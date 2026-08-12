import fs from "node:fs/promises";
import path from "node:path";

import { codegen } from "@graphql-codegen/core";
import * as typescriptPlugin from "@graphql-codegen/typescript";
import * as typescriptOperationsPlugin from "@graphql-codegen/typescript-operations";
import { schema as githubSchema } from "@octokit/graphql-schema";
import {
  buildSchema,
  parse,
  print,
  printSchema,
  printType,
  visit,
} from "graphql";
import { format, resolveConfig } from "prettier";

const PACKAGE_ROOT = path.join(import.meta.dirname, "..");
const QUERIES_DIR = path.join(PACKAGE_ROOT, "src/graphql/queries");
const OUT_DIR = path.join(PACKAGE_ROOT, "src/graphql/generated");
const COMMON_FILE = "common.ts";
// `typescript-operations` resolves this against the working directory
const COMMON_IMPORT_PATH = path.relative(
  process.cwd(),
  path.join(OUT_DIR, COMMON_FILE.replace(/\.ts$/, ".js")),
);

// `--check` regenerates in memory and fails on any difference, for CI
const checkOnly = process.argv.includes("--check");

const config = {
  emitLegacyCommonJSImports: false,
  enumsAsTypes: true,
  skipTypename: true,
  useTypeImports: true,
  // read the schema's own enums and input types from the common file instead of redeclaring them per query file;
  // the import is emitted only where they are used
  importSchemaTypesFrom: COMMON_IMPORT_PATH,
  // nullable fields as `x: T | null`; `@include(if:)` ones stay optional
  avoidOptionals: { field: true },
  scalars: { DateTime: "string" },
};

// GitHub's published SDL declares a few fields twice, which trips SDL validation
const schemaAst = buildSchema(githubSchema.idl, { assumeValidSDL: true });
const schemaDocument = parse(printSchema(schemaAst));

const queryFiles = (await fs.readdir(QUERIES_DIR))
  .filter((file) => file.endsWith(".graphql"))
  .sort();

const documents = await Promise.all(
  queryFiles.map(async (file) => {
    const location = path.join(QUERIES_DIR, file);
    const rawSDL = await fs.readFile(location, "utf8");
    return { location, rawSDL, document: parse(rawSDL) };
  }),
);

const fragments = new Map(
  documents.flatMap(({ document }) =>
    document.definitions
      .filter((definition) => definition.kind === "FragmentDefinition")
      .map((definition) => [definition.name.value, definition]),
  ),
);

/**
 * Every fragment a node spreads, directly or through another fragment.
 *
 * @param node Operation or fragment definition to walk.
 * @param found Fragment names collected so far.
 * @returns The fragment names the node needs.
 */
const spreadFragments = (node, found = new Set()) => {
  visit(node, {
    FragmentSpread(spread) {
      const name = spread.name.value;
      if (found.has(name)) {
        return;
      }
      const fragment = fragments.get(name);
      if (!fragment) {
        throw new Error(`No definition found for fragment "${name}"`);
      }
      found.add(name);
      spreadFragments(fragment, found);
    },
  });
  return found;
};

/**
 * The names `typescript-operations` gives an operation's types.
 *
 * @param operation Operation definition.
 * @returns Names to reference in the emitted document.
 */
const operationNames = (operation) => {
  if (!operation.name) {
    throw new Error("Every query needs a name to generate types from");
  }
  const name = operation.name.value;
  const pascalCase = name.charAt(0).toUpperCase() + name.slice(1);
  const suffix =
    operation.operation.charAt(0).toUpperCase() + operation.operation.slice(1);
  const resultType = pascalCase.endsWith(suffix)
    ? pascalCase
    : `${pascalCase}${suffix}`;
  return {
    documentName: `${pascalCase}Document`,
    resultType,
    variablesType: `${resultType}Variables`,
  };
};

/** Emits one typed document per operation, next to the types for its shape. */
const documentsPlugin = {
  plugin: (_schema, files) => {
    const operations = files.flatMap((file) =>
      file.document.definitions.filter(
        (definition) => definition.kind === "OperationDefinition",
      ),
    );
    return {
      prepend: [`import { graphqlDocument } from "../graphqlDocument.js";`],
      content: operations
        .map((operation) => {
          const { documentName, resultType, variablesType } =
            operationNames(operation);
          const text = [
            print(operation),
            ...[...spreadFragments(operation)].map((name) =>
              print(fragments.get(name)),
            ),
          ].join("\n");
          return `export const ${documentName} = graphqlDocument<${resultType}, ${variablesType}>(\`\n${text}\`);`;
        })
        .join("\n\n"),
    };
  },
};

// a schema of only the types the queries reference through their variables, so the
// common file gets the scalars and enums in use rather than every one GitHub declares
const variableTypeNames = new Set();
for (const { document } of documents) {
  visit(document, {
    VariableDefinition(node) {
      visit(node.type, {
        NamedType(namedType) {
          variableTypeNames.add(namedType.name.value);
        },
      });
    },
  });
}
const subsetSchemaAst = buildSchema(
  [...variableTypeNames]
    .map((name) => schemaAst.getType(name))
    .filter((type) => !!type && !type.name.startsWith("__"))
    .map((type) => printType(type))
    .join("\n\n"),
  { assumeValidSDL: true },
);

// `typescript-operations` emits this for the fragment masking we don't generate, and
// has no config to leave it out
const INCREMENTAL_TYPE =
  /^\/\*\* Internal type\. DO NOT USE DIRECTLY\. \*\/\nexport type Incremental<T> = [^\n]*\n/m;

const generated = [
  [
    path.join(OUT_DIR, COMMON_FILE),
    await codegen({
      filename: path.join(OUT_DIR, COMMON_FILE),
      schema: parse(printSchema(subsetSchemaAst)),
      schemaAst: subsetSchemaAst,
      documents: [],
      config,
      plugins: [{ typescript: {} }],
      pluginMap: { typescript: typescriptPlugin },
    }),
  ],
];

for (const file of documents) {
  const filename = path.join(
    OUT_DIR,
    `${path.basename(file.location, ".graphql")}.ts`,
  );
  const content = await codegen({
    filename,
    schema: schemaDocument,
    schemaAst,
    documents: [file],
    config,
    plugins: [{ "typescript-operations": {} }, { documents: {} }],
    pluginMap: {
      "typescript-operations": typescriptOperationsPlugin,
      documents: documentsPlugin,
    },
  });
  generated.push([filename, content.replace(INCREMENTAL_TYPE, "")]);
}

const prettierConfig = await resolveConfig(path.join(OUT_DIR, COMMON_FILE));
const drifted = [];

await fs.mkdir(OUT_DIR, { recursive: true });
for (const [filename, content] of generated) {
  const formatted = await format(content, {
    ...prettierConfig,
    parser: "typescript",
  });
  if (checkOnly) {
    const current = await fs.readFile(filename, "utf8").catch(() => null);
    if (current !== formatted) {
      drifted.push(path.relative(PACKAGE_ROOT, filename));
    }
  } else {
    await fs.writeFile(filename, formatted);
  }
}

// a query removed from the queries folder leaves its generated file behind
const expected = new Set(
  generated.map(([filename]) => path.basename(filename)),
);
const stale = (await fs.readdir(OUT_DIR).catch(() => [])).filter(
  (file) => !expected.has(file),
);
for (const file of stale) {
  if (checkOnly) {
    drifted.push(path.relative(PACKAGE_ROOT, path.join(OUT_DIR, file)));
  } else {
    await fs.rm(path.join(OUT_DIR, file));
  }
}

if (checkOnly) {
  if (drifted.length > 0) {
    console.error(
      `GraphQL types are out of date:\n${drifted.map((file) => `  ${file}`).join("\n")}\n\nRun \`pnpm generate-graphql-types\` in packages/core.`,
    );
    process.exit(1);
  }
  console.log(`GraphQL types are up to date (${queryFiles.length} queries)`);
} else {
  console.log(
    `Generated ${generated.length} files in ${path.relative(PACKAGE_ROOT, OUT_DIR)} from ${queryFiles.length} queries`,
  );
}
