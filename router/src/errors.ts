// Errors in the OpenAI error shape, so OpenAI SDKs surface them normally.

import type { ReceiptJson } from "@policyrouter/policy";

export interface ErrorBody {
  error: { message: string; type: string; code: string; param?: string | null };
  policyrouter_receipt?: ReceiptJson;
}

export function errorBody(code: string, message: string, extra?: Partial<ErrorBody>): ErrorBody {
  return { error: { message, type: code, code, param: null }, ...extra };
}

export const ERR = {
  missingKey: () => errorBody("invalid_api_key", "Missing API key. Send `Authorization: Bearer pr-live-…`."),
  badKey: () => errorBody("invalid_api_key", "Invalid API key."),
  badRequest: (msg: string) => errorBody("invalid_request_error", msg),
  unknownModel: (model: string) => errorBody("model_not_found", `Unknown model '${model}'. See GET /v1/models.`),
  rateLimited: () => errorBody("rate_limit_exceeded", "Too many requests for this API key. Slow down."),
  policyDenied: (receipt: ReceiptJson) =>
    errorBody("policy_denied", "The agent's policy circuit denied this request. See policyrouter_receipt.", {
      policyrouter_receipt: receipt,
    }),
  policyUnavailable: () =>
    errorBody("policy_unavailable", "The policy check could not run, so the request was refused. Try again shortly."),
  priceUnavailable: () =>
    errorBody("price_unavailable", "No current OKB price is available to charge this request, so it was refused. Try again shortly."),
  upstream: (status?: number) =>
    errorBody("upstream_error", `The model provider returned an error${status ? ` (status ${status})` : ""}.`),
  notFound: () => errorBody("not_found", "Not found."),
} as const;
