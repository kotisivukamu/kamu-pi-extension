# kamu-pi-extension

A [pi](https://pi.dev) provider extension that routes through the
kotisivukamu `llm-proxy`. Registers a `kamu` provider (shown as **"Kamu"** in
`/login`). One `/login kamu` stores a token minted at the internal dashboard;
the model catalog is then fetched from the proxy's `GET /llm/catalog` endpoint
so it always matches what prod can actually route.

## How to test

Rough steps:

1. **Install pi** (if you don't have it):
   ```bash
   curl -fsSL https://pi.dev/install.sh | bash
   ```

2. **Install this extension**:
   ```bash
   pi install git:github.com/kotisivukamu/kamu-pi-extension
   ```
   (Private repo — needs GitHub git creds on the machine.)

3. **Mint a token** at the internal dashboard → **"LLM-tokenit"**:
   name = your machine, models = `*` (all), TTL = 1 year. Copy the JWT it
   shows you.

4. **Log in and load the catalog**:
   ```bash
   pi
   ```
   then inside pi:
   ```
   /login kamu        # paste the token from step 3
   /reload            # re-fetch the catalog now that the token is stored
   ```

5. **Profit** — pick a model and talk to it:
   ```
   /model kamu/claude-sonnet-5
   ```
   Send a message. It answers through the llm-proxy, metered against your
   token's `budget_usd` cap if you set one.

To make `kamu` the default, edit `~/.pi/agent/settings.json`:
```json
{
  "defaultProvider": "kamu",
  "defaultModel": "claude-sonnet-5"
}
```

## Troubleshooting

- **`/login` doesn't list kamu** — bare `/login` shows a top-level picker
  first. Either choose **"Sign in with an API key"** and look for "Kamu", or
  just run `/login kamu` directly (matches by id, skips the picker).
- **401 on model calls, but the token works against the proxy directly** —
  the proxy's catalog endpoint can return `http://` baseUrls behind the
  TLS-terminating edge; the extension normalizes them back to https, but if you're
  on an old version, `pi update --extension …` and `/reload`.
- **No models after `/reload`** — check the token's `models` allowlist is
  `*` (an empty list is fail-closed), and that it hasn't expired. The
  extension logs `[kamu] catalog fetch failed: HTTP <code> from <url>` to
  stderr on any fetch failure.
- **First run (no token yet)** — the provider registers with zero models so
  `/login` still lists it; the catalog fetch is skipped until you log in.

## Pointing at a local proxy

```bash
KAMU_LLM_PROXY_URL=http://localhost:8300 pi
```
Defaults to `https://llm-proxy.kotisivukamu.fi`.

## Updating after a push

```bash
pi update --extension git:github.com/kotisivukamu/kamu-pi-extension
# then /reload inside pi
```

## How it works (for maintainers)

- **Catalog is dynamic.** The volatile fields — which models exist, costs,
  provider routing, wire protocol, `baseUrl` — come from
  `GET /llm/catalog` on the proxy, authenticated with the stored token. The
  proxy maps each upstream's `auth_style` to the pi `api` type
  (`anthropic-messages` for Anthropic, `openai-completions` for the rest)
  and derives `baseUrl` from the request origin, so the extension always
  matches what the proxy can actually route.

- **Stable metadata is enriched locally.** The proxy catalog doesn't carry
  `contextWindow` / `maxTokens` / `reasoning` / image support, so those are
  matched by id in `enrich()` in the extension. They rarely change and only
  gate pi's auto-compaction and thinking-level UI, so a stale approximation
  is non-critical. **A new model family may need a branch in `enrich()`** —
  e.g. a new Claude tier with a different output cap — otherwise it falls
  back to `128_000 / 8_192 / reasoning:false / text-only`, which works but
  is suboptimal.

- **One token, mixed wire protocols.** The proxy accepts the token from
  either `x-api-key` (Anthropic SDK) or `Authorization: Bearer` (OpenAI SDK),
  so a single stored credential covers Claude and the OpenAI-compatible
  models. The provider is a mixed-API `createProvider` whose `api` map
  dispatches on `model.api`.

- **baseUrl normalization.** The proxy's `piCatalogHandler` derives
  `baseUrl` from `c.req.url`, which behind the TLS-terminating edge is `http://`.
  The edge's `force_https` then 301-redirects every http model call to https, and
  the redirect drops the auth header → a spurious 401 on the retried call.
  The extension rewrites each returned `baseUrl`'s origin back to the https
  `GATEWAY` it fetched the catalog from. The proper fix lives in the proxy
  (respect `X-Forwarded-Proto`); this is the defensive client-side fallback.

- **Failure posture.** No token yet (first run) or fetch failure (401 /
  network / 5s timeout) → the provider registers with zero models so
  `/login` still lists it; `console.error` reports the fetch failure. After
  `/login` + `/reload` the models populate.

## Token minting (background)

Tokens are stateless HMAC JWTs signed with the shared `SESSION_JWT_SECRET`
(`kotisivukamu/deno-shared/llm-token.ts`). Mint one at the internal dashboard
→ **"LLM-tokenit"** (`POST /api/llm-tokens`): name it for the machine, `*`
models, 1y TTL. Revocation is by rotating the secret — use a bounded TTL and
the optional `budget_usd` cap to limit blast radius.

## Source of truth

- **Catalog** (model ids, costs, routing, wire protocol, baseUrl):
  `GET /llm/catalog` on the live `llm-proxy` (`llm-proxy/src/routes/catalog.ts`
  `piCatalogHandler`). This extension fetches it at load; it does NOT maintain
  a copy. Never duplicate the catalog here.
- **Stable per-model metadata** (`contextWindow`, `maxTokens`, `reasoning`,
  image support, GLM's `reasoning_effort:"none"`): the `enrich()` function in
  `extensions/kamu.ts`. A new model family may need a branch there.
