// Kamu LLM Proxy provider for local development.
//
// Routes pi at the kotisivukamu llm-proxy. One /login stores the token you
// mint at the internal dashboard → "LLM-tokenit"; the model catalog is then
// fetched from the proxy's GET /llm/catalog endpoint so the extension always
// matches what prod can actually route — no hand-mirrored second copy of
// llm-proxy/src/catalog.ts to drift (the kimi-k2.7-code 28%-overbilling
// incident in catalog.ts was exactly that kind of silent drift).
//
// The volatile fields (which models exist, costs, provider routing, wire
// protocol, baseUrl) come from the endpoint. The stable fields pi needs but
// the proxy catalog doesn't track (contextWindow, maxTokens, reasoning,
// image support, GLM's reasoning_effort:"none" quirk) are enriched locally
// — these rarely change and only gate pi's auto-compaction / thinking UI,
// so a stale approximation is non-critical.
//
// Usage:
//   pi
//   /login kamu            # paste the token from the internal dashboard
//   /reload                # re-fetch the catalog now that the token is stored
//   /model kamu/claude-sonnet-5
//
// To point at a local llm-proxy instead of prod:
//   KAMU_LLM_PROXY_URL=http://localhost:8300 pi
//
// First run (no token yet): the provider registers with zero models so it
// still appears in the /login list; the catalog fetch is skipped. After
// /login + /reload the models populate.
//
// Sharing: this file is the body of the kamuhub/pi-kamu-llm package —
// `pi install git:github.com/kamuhub/pi-kamu-llm` loads the same provider.

import {
  anthropicMessagesApi,
  createProvider,
  openAICompletionsApi,
  type Api,
  type Model,
} from "@earendil-works/pi-ai";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const GATEWAY = (
  process.env.KAMU_LLM_PROXY_URL ?? "https://llm-proxy.kotisivukamu.fi"
).replace(/\/$/, "");

const CATALOG_URL = `${GATEWAY}/llm/catalog`;

// pi's agent dir is where auth.json lives. Mirror getAgentDir(): a per-job
// PI_CODING_AGENT_DIR wins (builder uses this), else $HOME/.pi/agent.
function agentDir(): string {
  return (
    process.env.PI_CODING_AGENT_DIR ??
    path.join(process.env.HOME ?? "", ".pi", "agent")
  );
}

// Read the stored kamu api-key credential. auth.json is plain JSON the auth
// store writes: { "kamu": { "type": "api_key", "key": "..." } }. Absent or
// unparseable → undefined (first run, or not yet logged in).
function storedKamuToken(): string | undefined {
  const file = path.join(agentDir(), "auth.json");
  try {
    const raw = fs.readFileSync(file, "utf8");
    const creds = JSON.parse(raw) as Record<string, { key?: string }>;
    return creds.kamu?.key?.trim() || undefined;
  } catch {
    return undefined;
  }
}

interface CatalogModel {
  id: string;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
}
interface CatalogProvider {
  baseUrl: string;
  api: "anthropic-messages" | "openai-completions";
  models: CatalogModel[];
}
interface CatalogResponse {
  providers: Record<string, CatalogProvider>;
}

// Fetch the catalog with the stored token. Returns undefined on any failure
// (no token, network, 401, parse error) so the caller can register an empty
// provider rather than crash pi startup. Bounded by a 5s timeout so a dead
// gateway can't hang the (synchronous-feeling) factory.
async function fetchCatalog(token: string): Promise<CatalogResponse | undefined> {
  try {
    const res = await fetch(CATALOG_URL, {
      headers: { "x-api-key": token },
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) {
      console.error(
        `[kamu] catalog fetch failed: HTTP ${res.status} from ${CATALOG_URL}`,
      );
      return undefined;
    }
    return (await res.json()) as CatalogResponse;
  } catch (err) {
    console.error(
      `[kamu] catalog fetch failed: ${err instanceof Error ? err.message : err}`,
    );
    return undefined;
  }
}

// Stable per-model fields the proxy catalog doesn't carry. Keyed by exact id
// where it matters, prefix-matched for the Claude / DeepSeek families.
interface Enrichment {
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  input: ("text" | "image")[];
  samplingParams?: Record<string, unknown>;
}

function enrich(id: string): Enrichment {
  // GLM 5.2 via cortecs burns 600-2500 reasoning tokens/turn at default
  // thinking; reasoning_effort "none" is verified working and ~2x faster
  // (builder/src/agent-cli.ts, 2026-08-17). Other GLM/MiniMax/Qwen/Kimi
  // slugs run fine thinking-off, which is the safe default.
  if (id === "glm-5.2") {
    return {
      contextWindow: 128_000,
      maxTokens: 8_192,
      reasoning: false,
      input: ["text"],
      samplingParams: { reasoning_effort: "none" },
    };
  }
  if (id.startsWith("claude-opus")) {
    return { contextWindow: 200_000, maxTokens: 32_000, reasoning: true, input: ["text", "image"] };
  }
  if (id.startsWith("claude-sonnet")) {
    return { contextWindow: 200_000, maxTokens: 16_384, reasoning: true, input: ["text", "image"] };
  }
  if (id.startsWith("claude-haiku")) {
    return { contextWindow: 200_000, maxTokens: 8_192, reasoning: true, input: ["text", "image"] };
  }
  const reasoning = id === "deepseek-reasoner" || id === "deepseek-v4-pro" || id === "kimi-k3";
  const image = id === "deepseek-v4-pro" || id === "kimi-k2.6";
  return {
    contextWindow: 128_000,
    maxTokens: 8_192,
    reasoning,
    input: image ? ["text", "image"] : ["text"],
  };
}

// Flatten the provider-grouped catalog into one kamu provider's model list.
// Each model keeps its upstream's baseUrl + api (pi dispatches on model.api
// via the provider's api map), and gets provider:"kamu" set explicitly —
// createProvider does NOT inject it, and list-models crashes sorting by
// model.provider if it's undefined.
//
// The proxy's piCatalogHandler derives baseUrl from `c.req.url`, which behind
// the TLS-terminating edge is http:// even though the public origin is https.
// The edge's force_https then 301-redirects every http model call to https,
// and the redirect drops the auth header → a spurious 401 on the retried call.
// Normalize every returned baseUrl back to the same origin we fetched the
// catalog from (GATEWAY), which is the origin that actually works.
function toModels(catalog: CatalogResponse): Model<Api>[] {
  const models: Model<Api>[] = [];
  for (const provider of Object.values(catalog.providers ?? {})) {
    const baseUrl = provider.baseUrl.replace(/^https?:\/\/[^/]+/, GATEWAY);
    for (const m of provider.models ?? []) {
      const e = enrich(m.id);
      models.push({
        id: m.id,
        name: m.id,
        provider: "kamu",
        api: provider.api,
        baseUrl,
        reasoning: e.reasoning,
        input: e.input,
        cost: m.cost,
        contextWindow: e.contextWindow,
        maxTokens: e.maxTokens,
        ...(e.samplingParams ? { samplingParams: e.samplingParams } : {}),
      } as Model<Api>);
    }
  }
  return models;
}

async function buildModels(): Promise<Model<Api>[]> {
  const token = storedKamuToken();
  if (!token) {
    // First run, or not logged in. Register with zero models so /login still
    // lists the provider; /reload after login populates the catalog.
    return [];
  }
  const catalog = await fetchCatalog(token);
  if (!catalog) return [];
  const models = toModels(catalog);
  if (models.length === 0) {
    console.error(`[kamu] catalog at ${CATALOG_URL} returned no models`);
  }
  return models;
}

export default async function (pi: ExtensionAPI) {
  const models = await buildModels();
  pi.registerProvider(
    createProvider({
      id: "kamu",
      name: "Kamu",
      auth: {
        apiKey: {
          name: "Kamu LLM token",
          async login(interaction) {
            const key = await interaction.prompt({
              type: "secret",
              message:
                "Paste your llm-proxy token (internal dashboard → LLM-tokenit)",
            });
            const trimmed = key.trim();
            if (!trimmed) throw new Error("No token entered");
            return { type: "api_key", key: trimmed };
          },
          async resolve({ credential }) {
            return credential?.key
              ? { auth: { apiKey: credential.key }, source: "stored kamu token" }
              : undefined;
          },
        },
      },
      // Mixed-API provider: dispatch on model.api. Claude models use the
      // Anthropic Messages streamer (x-api-key); everything else uses the
      // OpenAI Chat Completions streamer (Authorization: Bearer). The proxy
      // accepts either header, so one stored token covers all models.
      api: {
        "anthropic-messages": anthropicMessagesApi(),
        "openai-completions": openAICompletionsApi(),
      },
      models,
    }),
  );
}
