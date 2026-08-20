# kamu-pi-extension

A pi provider extension routing through the kotisivukamu `llm-proxy`. See
`README.md` for usage.

## What this repo is

A single-file pi package (`extensions/kamu.ts`) that registers a `kamu`
provider. It is a **dev tool** for kamu developers running pi locally — not a
deployed service, not part of any subproduct's release cycle.

## Source of truth

- **Catalog (model ids, costs, routing, wire protocol, baseUrl):**
  `GET /llm/catalog` on the live `llm-proxy` (`llm-proxy/src/routes/catalog.ts`
  `piCatalogHandler`). This extension fetches it at load; it does NOT maintain
  a copy. Never duplicate the catalog here.
- **Stable per-model metadata** (`contextWindow`, `maxTokens`, `reasoning`,
  image support, GLM's `reasoning_effort:"none"`): the `enrich()` function in
  `extensions/kamu.ts`. The proxy catalog doesn't carry these, so they live
  here. A new model family may need a branch in `enrich()`.

## Sibling repos

- `llm-proxy` (in `kotisivukamu/llm-proxy`) — the proxy this points at, and
  the catalog source. The `GET /llm/catalog` endpoint and its response shape
  are the contract between them.
- `builder` (`builder/src/agent-cli.ts`) and `studio`
  (`studio/api/src/lib/model.ts`) — the other two consumers of the proxy
  catalog, via generated `models.json` (not this extension). When the catalog
  shape changes, all three may need touching.

## Pi packages

This is a pi package (`"keywords": ["pi-package"]`, `"pi": {"extensions": …}`).
Core packages are `peerDependencies` (`@earendil-works/pi-ai`,
`@earendil-works/pi-coding-agent`) — never bundle them; pi exposes them to
extensions via virtual modules.

Install (after this repo is pushed):

```bash
pi install git:github.com/kotisivukamu/kamu-pi-extension
```
