/** Normalizing provider base URLs per chat API.
 *
 *  pi's models.json carries one `baseUrl` per provider, but the chat SDKs
 *  disagree about what it must point at: the OpenAI SDK appends only
 *  `/chat/completions` or `/responses` (so the provider URL needs a `/v1`
 *  suffix), while the Anthropic and Google SDKs own the version segment
 *  themselves (`/v1/messages`, `/v1beta/...`) and 404 on a doubled `/v1`.
 *  A gateway root URL therefore cannot serve both styles as-is, so PiX lets
 *  users enter the root and resolves the per-model URL from the model's
 *  effective API type, storing it as the model-level `baseUrl` (which pi
 *  prefers over the provider's). */

/** Strip trailing slashes and a trailing version segment, leaving the gateway root. */
function gatewayRoot(baseUrl: string): string {
  return baseUrl
    .trim()
    .replace(/\/+$/, "")
    .replace(/\/v1beta$/i, "")
    .replace(/\/v1$/i, "")
}

/** Version-segment prefix chat requests need on top of the gateway root. */
export function providerApiPathPrefix(api: string): string {
  if (api === "google-generative-ai") return "/v1beta"
  if (api === "anthropic-messages") return ""
  // openai-completions, openai-responses and future OpenAI-style apis.
  return "/v1"
}

/** Resolve the chat base URL for one model: normalize the provider URL to the
 *  gateway root, then append the API's own version prefix. */
export function resolveProviderBaseUrl(baseUrl: string, api: string): string {
  return gatewayRoot(baseUrl) + providerApiPathPrefix(api)
}

/** Base URL for the provider `/models` listing endpoint: OpenAI and Anthropic
 *  both list under `/v1/models`, Google under `/v1beta/models`. */
export function resolveModelsListBaseUrl(baseUrl: string, api: string): string {
  return gatewayRoot(baseUrl) + (api === "google-generative-ai" ? "/v1beta" : "/v1")
}

/** Fill each model of a provider entry with its resolved chat base URL.
 *  Models that already carry a custom `baseUrl` (neither the previous
 *  auto-resolved value nor the new one) are left untouched. */
export function syncModelBaseUrls(
  entry: { baseUrl?: string; api?: string; models?: Array<Record<string, unknown>> },
  previousBaseUrl?: string,
): void {
  const base = (entry.baseUrl ?? "").trim()
  if (!base) return
  for (const model of entry.models ?? []) {
    const api = (model.api as string | undefined) ?? entry.api ?? "openai-completions"
    const expected = resolveProviderBaseUrl(base, api)
    if (expected === base) continue // the SDK resolves correctly from the provider URL itself
    const existing = typeof model.baseUrl === "string" ? model.baseUrl.trim() : ""
    const previous = previousBaseUrl?.trim()
    if (!existing || existing === expected || (previous && existing === resolveProviderBaseUrl(previous, api))) {
      model.baseUrl = expected
    }
  }
}
