import axios from "axios";
import type { AxiosRequestConfig, AxiosResponse } from "axios";

import type { GraphQLDocument } from "../graphql/graphqlDocument.js";

const GITHUB_GRAPHQL_API = "https://api.github.com/graphql";

/** Response of a GraphQL call: the envelope the GitHub API wraps results in. */
type GraphQLResponse<TResult> = AxiosResponse<{
  data: TResult;
  errors?: Array<{ type?: string; message?: string }>;
}>;

/**
 * Send a GraphQL request to the GitHub API.
 *
 * @param document Generated query document; carries its result and variable types.
 * @param variables Variables the query declares.
 * @param headers Request headers.
 * @returns Request response.
 */
const httpGraphQLRequest = <TResult, TVariables>(
  document: GraphQLDocument<TResult, TVariables>,
  variables: TVariables,
  headers: NonNullable<AxiosRequestConfig["headers"]>,
): Promise<GraphQLResponse<TResult>> => {
  return axios({
    url: GITHUB_GRAPHQL_API,
    method: "post",
    headers,
    data: { query: document.text, variables },
  });
};

/** Body of a GraphQL request sent to the GitHub API. */
interface GraphQLRequest {
  /** The GraphQL query. */
  query: string;
  /** Variables referenced by the query. */
  variables: Record<string, unknown>;
}

/**
 * Send an untyped GraphQL request to the GitHub API.
 *
 * @param data Request data.
 * @param headers Request headers.
 * @returns Request response.
 *
 * @description Superseded by {@link httpGraphQLRequest}.
 * Still used by the backend status endpoints for their own `rateLimit` query,
 * and part of this package's published API.
 *
 * @todo consider dropping this once those endpoints post through axios directly,
 * which they already depend on.
 */
const request = (
  data: GraphQLRequest,
  headers: NonNullable<AxiosRequestConfig["headers"]>,
): Promise<AxiosResponse> => {
  return axios({
    url: GITHUB_GRAPHQL_API,
    method: "post",
    headers,
    data,
  });
};

export { httpGraphQLRequest, request };
export type { GraphQLResponse };
