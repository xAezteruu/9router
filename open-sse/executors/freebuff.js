<<<<<<< HEAD
import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import { proxyAwareFetch } from "../utils/proxyFetch.js";

const BASE_URL = "https://www.codebuff.com";
const CLI_UA = "Freebuff-CLI/0.0.150";
const CHAT_URL = `${BASE_URL}/api/v1/chat/completions`;

export const BUFFY_SYSTEM_MARKER =
  "You are Buffy, the strategic coding assistant. You are the AI agent behind the product, Freebuff, a tool where users can chat with you to code with AI for free.";

const DEFAULT_MODEL = "mimo/mimo-v2.5";

const MODEL_AGENT = {
  "mimo/mimo-v2.5": "base2-free",
  "minimax/minimax-m2.7": "base2-free",
  "z-ai/glm-5.1": "base2-free",
  "google/gemini-3.1-pro-preview": "base2-free",
  "deepseek/deepseek-v4-flash": "base2-free-deepseek-flash",
  "deepseek/deepseek-v4-pro": "base2-free-deepseek",
  "moonshotai/kimi-k2.6": "base2-free-kimi",
};

// In-memory cache for free sessions: `${token}:${model}` -> { instanceId, expiresAt, model }
const sessions = new Map();

function generateClientId() {
  return Math.random().toString(36).slice(2, 15).padEnd(13, "0").slice(0, 13);
}

function clearSessionCache(token = null, model = null) {
  if (token && model) {
    sessions.delete(`${token}:${model}`);
  } else if (token) {
    for (const k of sessions.keys()) {
      if (k.startsWith(`${token}:`)) sessions.delete(k);
    }
  } else {
    sessions.clear();
  }
}

async function getFreebuffSession(token, model = DEFAULT_MODEL, proxyOptions = null) {
  const cacheKey = `${token}:${model}`;
  const cached = sessions.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) {
    return { instanceId: cached.instanceId, resolvedModel: cached.model };
  }

  const sessionId = "ad-" + Math.random().toString(36).slice(2, 12);
  const headers = {
    Authorization: `Bearer ${token}`,
    "User-Agent": CLI_UA,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
  if (model && model !== DEFAULT_MODEL) {
    headers["x-freebuff-model"] = model;
  }

  const resp = await proxyAwareFetch(`${BASE_URL}/api/v1/freebuff/session`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      provider: "gravity",
      messages: [],
      sessionId,
      device: { os: "linux", timezone: "UTC", locale: "en-US" },
      surface: "cli",
    }),
  }, proxyOptions);

  if (!resp.ok) {
    const text = await resp.text();
    if (resp.status === 409) {
      try {
        const errJson = JSON.parse(text);
        if (errJson.status === "model_locked" && errJson.currentModel) {
          if (errJson.currentModel !== model) {
            return await getFreebuffSession(token, errJson.currentModel, proxyOptions);
          }
        }
      } catch {}
    }
    throw new Error(`Freebuff session failed (${resp.status}): ${text.slice(0, 200)}`);
  }

  const data = await resp.json();
  const resolved = data.model || model;
  const remainingMs = typeof data.remainingMs === "number" ? data.remainingMs : 3600000;
  const expiresAt = Date.now() + Math.max(1000, remainingMs - 60000);
  sessions.set(cacheKey, { instanceId: data.instanceId, expiresAt, model: resolved });
  return { instanceId: data.instanceId, resolvedModel: resolved };
}

async function startAgentRun(token, agentId, proxyOptions = null) {
  const resp = await proxyAwareFetch(`${BASE_URL}/api/v1/agent-runs`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "User-Agent": CLI_UA,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      action: "START",
      agentId,
      ancestorRunIds: [],
    }),
  }, proxyOptions);

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Freebuff agent run START failed (${resp.status}): ${text.slice(0, 200)}`);
  }

  const data = await resp.json();
  return data.runId;
}

async function finishAgentRun(token, runId, proxyOptions = null) {
  if (!runId) return;
  try {
    await proxyAwareFetch(`${BASE_URL}/api/v1/agent-runs`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "User-Agent": CLI_UA,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        action: "FINISH",
        runId,
        status: "completed",
        totalSteps: 1,
        directCredits: 0,
        totalCredits: 0,
      }),
    }, proxyOptions);
  } catch {
    // Best-effort cleanup
  }
}

function injectBuffyMarker(messages) {
  const msgs = Array.isArray(messages) ? [...messages] : [];
  const first = msgs[0] || {};
  const hasMarker =
    first.role === "system" &&
    typeof first.content === "string" &&
    first.content.includes(BUFFY_SYSTEM_MARKER);
  if (!hasMarker) {
    msgs.unshift({ role: "system", content: BUFFY_SYSTEM_MARKER });
  }
  return msgs;
}

function wrapStreamWithCleanup(response, cleanupFn) {
  if (!response.body) {
    cleanupFn();
    return response;
  }

  let cleaned = false;
  const safeCleanup = () => {
    if (!cleaned) {
      cleaned = true;
      cleanupFn();
    }
  };

  const reader = response.body.getReader();
  const stream = new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          safeCleanup();
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch (err) {
        safeCleanup();
        controller.error(err);
      }
    },
    async cancel(reason) {
      safeCleanup();
      return reader.cancel(reason);
    },
  });

  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

export class FreebuffExecutor extends BaseExecutor {
  constructor() {
    super("freebuff", PROVIDERS.freebuff || { baseUrl: CHAT_URL });
  }

  buildUrl() {
    return CHAT_URL;
  }

  buildHeaders(credentials, stream = true) {
    const token = credentials?.accessToken || credentials?.apiKey;
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      "User-Agent": CLI_UA,
      Accept: stream ? "text/event-stream, application/json" : "application/json",
    };
  }

  transformRequest(model, body) {
    return {
      ...body,
      messages: injectBuffyMarker(body?.messages),
    };
  }

  async execute({ model, body, stream, credentials, signal, log, proxyOptions = null }) {
    const token = credentials?.accessToken || credentials?.apiKey;
    if (!token) {
      const fakeResp = new Response(
        JSON.stringify({ error: { message: "Freebuff requires an auth token", code: "unauthorized" } }),
        { status: 401, headers: { "Content-Type": "application/json" } }
      );
      return { response: fakeResp, url: CHAT_URL, headers: {}, transformedBody: body };
    }

    let targetModel = String(model || DEFAULT_MODEL).replace(/^(freebuff|cb)\//, "");
    if (!MODEL_AGENT[targetModel]) {
      targetModel = DEFAULT_MODEL;
    }

    let attempts = 0;
    let lastError = null;

    while (attempts < 2) {
      attempts++;
      let instanceId;
      let resolvedModel;
      let runId = null;

      try {
        const sess = await getFreebuffSession(token, targetModel, proxyOptions);
        instanceId = sess.instanceId;
        resolvedModel = sess.resolvedModel;
        const agentId = MODEL_AGENT[resolvedModel] || "base2-free";
        runId = await startAgentRun(token, agentId, proxyOptions);
      } catch (err) {
        log?.error?.("FREEBUFF", `Session/run initialization failed: ${err.message}`);
        lastError = err;
        clearSessionCache(token, targetModel);
        if (attempts < 2) continue;
        throw err;
      }

      let messages = injectBuffyMarker(body?.messages);

      // If client sent tools, append their definitions to the system prompt so the model is aware of them
      // without passing raw `tools` array which causes Codebuff router 404 ("No endpoints found for mimo/mimo-v2.5").
      if (Array.isArray(body?.tools) && body.tools.length > 0) {
        const toolDefs = body.tools
          .map((t) => {
            const f = t.function || t;
            if (!f?.name) return null;
            return `- ${f.name}: ${f.description || ""}\n  Parameters: ${JSON.stringify(f.parameters || {})}`;
          })
          .filter(Boolean)
          .join("\n");
        if (toolDefs) {
          const toolNotice = `\n\n[Available Tools]\nYou have access to the following tools if needed:\n${toolDefs}`;
          if (messages[0]?.role === "system") {
            messages[0] = { ...messages[0], content: messages[0].content + toolNotice };
          } else {
            messages.unshift({ role: "system", content: BUFFY_SYSTEM_MARKER + toolNotice });
          }
        }
      }

      const transformedBody = {
        model: resolvedModel,
        messages,
        max_tokens: body?.max_tokens || body?.max_completion_tokens || 4096,
        stream: stream !== false,
        codebuff_metadata: {
          run_id: runId,
          client_id: generateClientId(),
          cost_mode: "free",
          freebuff_instance_id: instanceId,
        },
        provider: { data_collection: "deny" },
        stop: ["cb_easp"],
      };

      if (body?.temperature !== undefined) {
        transformedBody.temperature = body.temperature;
      }
      if (body?.top_p !== undefined) {
        transformedBody.top_p = body.top_p;
      }

      const headers = this.buildHeaders(credentials, stream);
      const url = this.buildUrl();
      const bodyStr = JSON.stringify(transformedBody);
      log?.debug?.("FETCH", `FREEBUFF → ${url} | model=${resolvedModel} runId=${runId}`);

      let response;
      try {
        response = await proxyAwareFetch(url, {
          method: "POST",
          headers,
          body: bodyStr,
          signal,
        }, proxyOptions);
      } catch (fetchErr) {
        await finishAgentRun(token, runId, proxyOptions);
        throw fetchErr;
      }

      if (!response.ok) {
        let errText = "";
        try {
          const clone = response.clone();
          errText = await clone.text();
        } catch {}

        const retryable =
          response.status === 428 ||
          (response.status === 404 && errText.includes("No endpoints found")) ||
          (response.status === 409 && (errText.includes("superseded") || errText.includes("model_locked"))) ||
          (response.status === 429 && errText.includes("capacity"));

        await finishAgentRun(token, runId, proxyOptions);

        if (retryable && attempts < 2) {
          log?.debug?.("FREEBUFF", `Retryable upstream response (${response.status}), refreshing session...`);
          clearSessionCache(token, targetModel);
          if (response.status === 429) {
            await new Promise((r) => setTimeout(r, 2000));
          }
          continue;
        }

        if (response.status === 428) {
          clearSessionCache(token, targetModel);
        }

        return { response, url, headers, transformedBody };
      }

      const wrappedResponse = wrapStreamWithCleanup(response, () => {
        finishAgentRun(token, runId, proxyOptions);
      });

      return { response: wrappedResponse, url, headers, transformedBody };
    }

    throw lastError || new Error("Freebuff execution failed");
  }
}

export const __test__ = {
  getFreebuffSession,
  startAgentRun,
  finishAgentRun,
  injectBuffyMarker,
  generateClientId,
  clearSessionCache,
  BUFFY_SYSTEM_MARKER,
  DEFAULT_MODEL,
  MODEL_AGENT,
  CLI_UA,
  BASE_URL,
  CHAT_URL,
};

export default FreebuffExecutor;
=======
import { randomBytes } from "node:crypto";
import { BaseExecutor } from "./base.js";
import { SSE_DONE, SSE_HEADERS_NO_BUFFER } from "../utils/sseConstants.js";
import { tlsFetch } from "../utils/tlsClient.js";
import { proxyAwareFetch } from "../utils/proxyFetch.js";
import { PROVIDER_MODELS } from "../providers/index.js";

// FreeBuff (Account / codebuff.com API) — free-tier authToken provider.
//
// Bridges the private codebuff.com protocol to an OpenAI-compatible interface:
//   1. POST /api/v1/freebuff/session (x-freebuff-model header) → instanceId
//   2. POST /api/v1/agent-runs {action:"START", agentId:"base2-free",
//      ancestorRunIds:[]} → root runId (ancestorRunIds MUST be [] — null 400s)
//   3. POST /api/v1/chat/completions + codebuff_metadata
//      {run_id, cost_mode:"free", client_id:<13-hex>, freebuff_instance_id}
//
// Auth: raw `authToken` from the Freebuff CLI credentials store
// (~/.config/manicode/credentials.json) or https://freebuff.llm.pm.
//
// Session/run state is in-memory per token (a router restart lazily re-creates
// them on the next request — one cheap POST each). Upstream returns standard
// OpenAI SSE / JSON, so chat responses pass through verbatim.

const BASE_URL = "https://codebuff.com";
const ROOT_AGENT_ID = "base2-free";
// Upstream rejects free-tier traffic that doesn't look like an official
// client: session/run/chat calls must carry the codebuff SDK user agent
// (mirrors the official CLI's ai-sdk UA — see freebuff-proxy / free-buff-lol).
const CLI_USER_AGENT = "ai-sdk/openai-compatible/0.10.7/codebuff";
const SESSION_LEAD_MS = 30_000; // refresh the session 30s before expiry
const COOLDOWN_MS = 30 * 60 * 1000; // 401 → 30-minute per-token cooldown
const PREMIUM_MODEL_IDS = [
  "deepseek/deepseek-v4-pro",
  "openai/gpt-5.6-luna",
  "minimax/minimax-m3",
];
const FALLBACK_MODEL_ID = "deepseek/deepseek-v4-flash";

// In-memory per-token protocol state: { session, rootRun, cooldownUntil }.
const tokenStates = new Map();

function errorResponse(status, message, code = "FREEBUFF_ERROR", headers = {}) {
  return new Response(
    JSON.stringify({ error: { message, type: "upstream_error", code } }),
    { status, headers: { "Content-Type": "application/json", ...headers } },
  );
}

// Build a 403 response for an upstream rejection. A 403 is a policy/CLI-gate
// decision — NOT an auth failure — so it must never be reported as an invalid
// token or trigger the auth cooldown. When the body signals the free-tier
// CLI-only gate, surface that explicitly.
function forbiddenResponse(context, bodyText = "") {
  const isCliGate = /free_mode_cli_required|only available through the freebuff cli|freebuff cli/i.test(bodyText);
  const message = isCliGate
    ? `Freebuff free tier ${context} is currently restricted to the official CLI by upstream (403 free_mode_cli_required). Try again later, or use the freebuff CLI directly.`
    : `Freebuff upstream rejected the ${context} request (403): ${(bodyText || "forbidden").slice(0, 300)}`;
  return errorResponse(403, message, isCliGate ? "free_mode_cli_required" : "FORBIDDEN");
}

// Resolve the client's model string to a valid upstream wire id. The catalog
// ids are "provider/model" (deepseek/deepseek-v4-flash); the router may pass
// them with an alias prefix ("fb/…") or bare ("deepseek-v4-flash").
function resolveWireModel(raw) {
  const s = String(raw || "").trim() || FALLBACK_MODEL_ID;
  const known = (PROVIDER_MODELS["freebuff"] || []).map((m) => m.id);
  if (known.includes(s)) return s;
  const stripped = s.replace(/^(fb|freebuff|freebuff-api|freebuff-token)\//, "");
  const hit = known.find((id) => id === stripped || id.endsWith(`/${stripped}`));
  return hit || s;
}

function random13Hex() {
  return randomBytes(13).toString("hex").slice(0, 13);
}

async function ensureSession(token, wireModel, fetchFn) {
  const state = tokenStates.get(token) || {};
  const cur = state.session;
  if (
    cur?.instanceId &&
    cur?.expiresAt &&
    new Date(cur.expiresAt).getTime() - Date.now() > SESSION_LEAD_MS
  ) {
    return cur;
  }
  const res = await fetchFn(`${BASE_URL}/api/v1/freebuff/session`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
      "Accept": "application/json",
      "User-Agent": CLI_USER_AGENT,
      "x-freebuff-model": wireModel,
    },
    body: "{}",
  });
  if (res.status === 401 || res.status === 403) {
    const err = new Error(res.status === 401 ? "INVALID_TOKEN" : "UPSTREAM_FORBIDDEN");
    err.status = res.status;
    if (res.status === 403) err.bodyText = await res.text().catch(() => "");
    throw err;
  }
  if (!res.ok) {
    const err = new Error(`SESSION_FAILED:${res.status}`);
    err.status = res.status;
    throw err;
  }
  const data = await res.json().catch(() => ({}));
  const session = {
    instanceId: data.instanceId || "",
    expiresAt: data.expiresAt || "",
    status: data.status || "active",
    rateLimit: data.rateLimit || null,
  };
  // A rotated session invalidates the old root run (hierarchy is session-rooted).
  tokenStates.set(token, { session, rootRun: null, cooldownUntil: state.cooldownUntil });
  return session;
}

async function ensureRootRun(token, fetchFn) {
  const state = tokenStates.get(token) || {};
  if (state?.rootRun?.runId) return state.rootRun;
  const res = await fetchFn(`${BASE_URL}/api/v1/agent-runs`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
      "Accept": "application/json",
      "User-Agent": CLI_USER_AGENT,
    },
    body: JSON.stringify({ action: "START", agentId: ROOT_AGENT_ID, ancestorRunIds: [] }),
  });
  if (res.status === 401 || res.status === 403) {
    const err = new Error(res.status === 401 ? "INVALID_TOKEN" : "UPSTREAM_FORBIDDEN");
    err.status = res.status;
    if (res.status === 403) err.bodyText = await res.text().catch(() => "");
    throw err;
  }
  if (!res.ok) {
    const err = new Error(`RUN_START_FAILED:${res.status}`);
    err.status = res.status;
    throw err;
  }
  const data = await res.json().catch(() => ({}));
  const rootRun = { runId: data.runId || "" };
  tokenStates.set(token, { ...state, rootRun });
  return rootRun;
}

export class FreeBuffExecutor extends BaseExecutor {
  constructor() {
    super("freebuff", null);
  }

  async execute({ model, body, stream, credentials, signal, log, proxyOptions = null }) {
    const token = String(credentials?.accessToken || credentials?.apiKey || "").trim();
    if (!token) {
      return {
        response: errorResponse(401, "Freebuff: no authToken provided. Get it from freebuff.llm.pm or the Freebuff CLI (~/.config/manicode/credentials.json)."),
        url: `${BASE_URL}/api/v1/chat/completions`, headers: {}, transformedBody: body,
      };
    }

    const now = Date.now();
    const cooldown = tokenStates.get(token)?.cooldownUntil || 0;
    if (cooldown > now) {
      return {
        response: errorResponse(429, `Freebuff: authToken is cooling down after repeated 401s — retry after ${Math.ceil((cooldown - now) / 1000)}s. Re-copy the token from freebuff.llm.pm if it keeps failing.`),
        url: `${BASE_URL}/api/v1/chat/completions`, headers: {}, transformedBody: body,
      };
    }

    const wireModel = resolveWireModel(model || body?.model);
    const fetchFn = proxyOptions?.connectionProxyEnabled ? proxyAwareFetch : tlsFetch;

    // Reuse the session created at connect-time (stored in providerSpecificData)
    // so a restart doesn't burn a fresh 1-hour session from the daily quota.
    const storedSession = credentials?.providerSpecificData;
    const stateNow = tokenStates.get(token) || {};
    if (
      !stateNow.session &&
      storedSession?.instanceId &&
      storedSession?.sessionExpiresAt &&
      new Date(storedSession.sessionExpiresAt).getTime() > Date.now() + SESSION_LEAD_MS
    ) {
      tokenStates.set(token, {
        ...stateNow,
        session: { instanceId: storedSession.instanceId, expiresAt: storedSession.sessionExpiresAt, status: "active" },
      });
    }

    // 1. Session (queued → Retry-After; expired → keep-alive).
    let session;
    try {
      session = await ensureSession(token, wireModel, fetchFn);
    } catch (err) {
      if (err.message === "INVALID_TOKEN") {
        tokenStates.set(token, { ...(tokenStates.get(token) || {}), cooldownUntil: now + COOLDOWN_MS });
        return {
          response: errorResponse(401, "Freebuff: authToken is invalid or expired — re-copy from freebuff.llm.pm."),
          url: `${BASE_URL}/api/v1/freebuff/session`, headers: {}, transformedBody: body,
        };
      }
      if (err.message === "UPSTREAM_FORBIDDEN") {
        return {
          response: forbiddenResponse("session", err.bodyText),
          url: `${BASE_URL}/api/v1/freebuff/session`, headers: {}, transformedBody: body,
        };
      }
      if (err.message?.startsWith("SESSION_FAILED:429")) {
        return {
          response: errorResponse(429, "Freebuff: rate limited by upstream — retry shortly.", "rate_limit_exceeded"),
          url: `${BASE_URL}/api/v1/freebuff/session`, headers: {}, transformedBody: body,
        };
      }
      return {
        response: errorResponse(502, `Freebuff session failed: ${err.message || err}`),
        url: `${BASE_URL}/api/v1/freebuff/session`, headers: {}, transformedBody: body,
      };
    }

    if (session.status === "queued") {
      return {
        response: errorResponse(503, "Freebuff: your session is queued upstream — retry in a moment.", "queued"),
        url: `${BASE_URL}/api/v1/freebuff/session`, headers: {}, transformedBody: body,
      };
    }
    if (!session.instanceId) {
      return {
        response: errorResponse(502, "Freebuff: session accepted but no instanceId returned."),
        url: `${BASE_URL}/api/v1/freebuff/session`, headers: {}, transformedBody: body,
      };
    }

    // 2. Root run under the session.
    let root;
    try {
      root = await ensureRootRun(token, fetchFn);
    } catch (err) {
      if (err.message === "INVALID_TOKEN") {
        tokenStates.set(token, { ...(tokenStates.get(token) || {}), cooldownUntil: now + COOLDOWN_MS });
        return {
          response: errorResponse(401, "Freebuff: authToken is invalid or expired — re-copy from freebuff.llm.pm."),
          url: `${BASE_URL}/api/v1/agent-runs`, headers: {}, transformedBody: body,
        };
      }
      if (err.message === "UPSTREAM_FORBIDDEN") {
        return {
          response: forbiddenResponse("agent run", err.bodyText),
          url: `${BASE_URL}/api/v1/agent-runs`, headers: {}, transformedBody: body,
        };
      }
      return {
        response: errorResponse(502, `Freebuff run start failed: ${err.message || err}`),
        url: `${BASE_URL}/api/v1/agent-runs`, headers: {}, transformedBody: body,
      };
    }

    // 3. Chat with the mandatory codebuff_metadata envelope.
    const payload = {
      ...(body || {}),
      model: wireModel,
      stream,
      codebuff_metadata: {
        run_id: root.runId,
        cost_mode: "free",
        client_id: random13Hex(),
        freebuff_instance_id: session.instanceId,
      },
    };

    log?.info?.("FREEBUFF", `model=${wireModel} session=${session.instanceId.slice(0, 8)} run=${root.runId.slice(0, 8)}`);

    const chatUrl = `${BASE_URL}/api/v1/chat/completions`;
    let upstream;
    try {
      upstream = await fetchFn(chatUrl, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${token}`,
          "Content-Type": "application/json",
          "Accept": stream ? "text/event-stream" : "application/json",
          "User-Agent": CLI_USER_AGENT,
          // CLI envelope: the upstream expects the same x-freebuff-* headers
          // the official client sends (session instance binds the request to
          // the created session/run).
          "x-freebuff-model": wireModel,
          ...(session.instanceId ? { "x-freebuff-instance-id": session.instanceId } : {}),
        },
        body: JSON.stringify(payload),
        signal,
      }, proxyOptions);
    } catch (err) {
      if (err.name === "AbortError") throw err;
      return {
        response: errorResponse(502, `Freebuff fetch failed: ${err?.message || err}`),
        url: chatUrl, headers: {}, transformedBody: payload,
      };
    }

    if (upstream.status === 401) {
      tokenStates.set(token, { ...(tokenStates.get(token) || {}), cooldownUntil: now + COOLDOWN_MS });
      return {
        response: errorResponse(401, "Freebuff: authToken is invalid or expired — re-copy from freebuff.llm.pm."),
        url: chatUrl, headers: {}, transformedBody: payload,
      };
    }

    if (upstream.status === 403) {
      // Policy/CLI gate, not an auth failure — surface the real reason and
      // skip the auth cooldown.
      const errText = await upstream.text().catch(() => "");
      return {
        response: forbiddenResponse("chat", errText),
        url: chatUrl, headers: {}, transformedBody: payload,
      };
    }

    if (upstream.status === 429) {
      // Premium pool spent? Step down to the unlimited Flash model once, like
      // the official surfaces (FALLBACK_FREEBUFF_MODEL_ID).
      const retryAfter = upstream.headers?.get?.("retry-after") || "";
      if (PREMIUM_MODEL_IDS.includes(wireModel)) {
        log?.info?.("FREEBUFF", `premium pool spent for ${wireModel} — stepping down to ${FALLBACK_MODEL_ID}`);
        return this.execute({ model: FALLBACK_MODEL_ID, body, stream, credentials, signal, log, proxyOptions });
      }
      return {
        response: errorResponse(429, `Freebuff: rate limited by upstream${retryAfter ? ` — retry after ${retryAfter}s` : ""}.`, "rate_limit_exceeded", retryAfter ? { "Retry-After": retryAfter } : {}),
        url: chatUrl, headers: {}, transformedBody: payload,
      };
    }

    if (!upstream.ok) {
      const errText = await upstream.text().catch(() => "");
      return {
        response: errorResponse(upstream.status, `Freebuff error: ${errText.slice(0, 300)}`),
        url: chatUrl, headers: {}, transformedBody: payload,
      };
    }

    if (!upstream.body) {
      return {
        response: errorResponse(502, "Freebuff: empty response body"),
        url: chatUrl, headers: {}, transformedBody: payload,
      };
    }

    // Upstream speaks OpenAI protocol — forward verbatim (streaming SSE or JSON).
    if (!stream) {
      const json = await upstream.text();
      return {
        response: new Response(json, {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
        url: chatUrl, headers: {}, transformedBody: payload,
      };
    }

    // Streaming: sanitize the upstream SSE (drop non-"data:" lines, forward the
    // rest including [DONE]) so stray comments/heartbeats can't break clients.
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const responseStream = new ReadableStream({
      async start(controller) {
        const reader = upstream.body.getReader();
        let buffer = "";
        try {
          while (true) {
            if (signal?.aborted) break;
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";
            for (const line of lines) {
              const t = line.trim();
              if (!t) continue;
              if (!t.startsWith("data:")) continue; // ignore comments/heartbeats
              controller.enqueue(encoder.encode(`${t}\n\n`));
            }
          }
        } catch (err) {
          if (!signal?.aborted) controller.error(err);
        } finally {
          controller.enqueue(encoder.encode(SSE_DONE));
          controller.close();
        }
      },
    });

    return {
      response: new Response(responseStream, { status: 200, headers: { ...SSE_HEADERS_NO_BUFFER } }),
      url: chatUrl, headers: {}, transformedBody: payload,
    };
  }
}

export default FreeBuffExecutor;
>>>>>>> serenhope/master
