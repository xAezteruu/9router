import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import { SSE_DONE, SSE_HEADERS_NO_BUFFER } from "../utils/sseConstants.js";
import { sseChunk } from "../utils/sse.js";

const DEEPSEEK_WEB_BASE = PROVIDERS["deepseek-web"]?.baseUrl || "https://chat.deepseek.com/api/v0";
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

function extractUserToken(raw) {
  if (!raw) return "";
  let str = String(raw).trim();
  if (str.startsWith("{")) {
    try {
      const parsed = JSON.parse(str);
      if (parsed && typeof parsed.value === "string") {
        str = parsed.value.trim();
      }
    } catch {}
  }
  if (str.includes("userToken=")) {
    const m = str.match(/userToken=([^;]+)/);
    if (m) str = m[1].trim();
  }
  if (str.startsWith("Bearer ")) str = str.slice(7).trim();
  return str.replace(/^["']|["']$/g, "").trim();
}

function formatAuthToken(rawKey) {
  const token = extractUserToken(rawKey);
  return token ? `Bearer ${token}` : "";
}

function parseOpenAIMessages(messages) {
  const parts = [];
  for (const msg of messages || []) {
    let role = String(msg.role || "user");
    if (role === "developer") role = "system";
    let content = "";
    if (typeof msg.content === "string") {
      content = msg.content;
    } else if (Array.isArray(msg.content)) {
      content = msg.content.filter((c) => c.type === "text").map((c) => String(c.text || "")).join(" ");
    }
    if (!content.trim()) continue;
    parts.push(`${role.toUpperCase()}: ${content}`);
  }
  return parts.join("\n\n");
}

function isThinkingModel(model) {
  const m = String(model || "").toLowerCase();
  return (
    m.includes("reasoner") ||
    m.includes("r1") ||
    m.includes("thinking") ||
    m.includes("deepseek-v4.1-reasoner") ||
    m.includes("deepseek-v4-pro")
  );
}

export class DeepSeekWebExecutor extends BaseExecutor {
  constructor() {
    super("deepseek-web", PROVIDERS["deepseek-web"]);
  }

  async execute({ model, body, stream, credentials, signal, log }) {
    const rawKey = credentials?.apiKey || credentials?.token || "";
    const authToken = formatAuthToken(rawKey);

    if (!authToken) {
      const errResp = new Response(JSON.stringify({
        error: { message: "DeepSeek Web cookie/token is missing. Please provide userToken.", type: "invalid_request_error" }
      }), { status: 401, headers: { "Content-Type": "application/json" } });
      return { response: errResp, url: DEEPSEEK_WEB_BASE, headers: {}, transformedBody: body };
    }

    const messages = body?.messages || [];
    const promptText = parseOpenAIMessages(messages);
    if (!promptText.trim()) {
      const errResp = new Response(JSON.stringify({
        error: { message: "Prompt is empty", type: "invalid_request_error" }
      }), { status: 400, headers: { "Content-Type": "application/json" } });
      return { response: errResp, url: DEEPSEEK_WEB_BASE, headers: {}, transformedBody: body };
    }

    const thinkingEnabled = isThinkingModel(model) || Boolean(body?.reasoning || body?.thinking || body?.reasoning_effort);

    // 1. Create session (or use fallback)
    let sessionId = null;
    try {
      const createRes = await fetch(`${DEEPSEEK_WEB_BASE}/chat_session/create`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": authToken,
          "User-Agent": USER_AGENT,
          "Origin": "https://chat.deepseek.com",
          "Referer": "https://chat.deepseek.com/",
          "x-app-version": "20241129.0",
          "x-client-platform": "web",
        },
        body: JSON.stringify({ character_id: null }),
        signal,
      });

      if (createRes.ok) {
        const createData = await createRes.json();
        sessionId = createData?.data?.biz_data?.id || createData?.data?.id || null;
      }
    } catch (e) {
      log?.warn?.("DEEPSEEK-WEB", `Session create failed, proceeding without session ID: ${e.message}`);
    }

    // 2. Prepare completion request
    const completionPayload = {
      chat_session_id: sessionId,
      parent_message_id: null,
      prompt: promptText,
      ref_file_ids: [],
      thinking_enabled: thinkingEnabled,
      search_enabled: false,
    };

    const completionHeaders = {
      "Content-Type": "application/json",
      "Authorization": authToken,
      "User-Agent": USER_AGENT,
      "Origin": "https://chat.deepseek.com",
      "Referer": "https://chat.deepseek.com/",
      "x-app-version": "20241129.0",
      "x-client-platform": "web",
      "Accept": "text/event-stream, */*",
    };

    const completionUrl = `${DEEPSEEK_WEB_BASE}/chat/completion`;

    let upstreamRes;
    try {
      upstreamRes = await fetch(completionUrl, {
        method: "POST",
        headers: completionHeaders,
        body: JSON.stringify(completionPayload),
        signal,
      });
    } catch (err) {
      log?.error?.("DEEPSEEK-WEB", `Network error: ${err.message}`);
      const errResp = new Response(JSON.stringify({
        error: { message: `DeepSeek Web network error: ${err.message}`, type: "api_error" }
      }), { status: 502, headers: { "Content-Type": "application/json" } });
      return { response: errResp, url: completionUrl, headers: completionHeaders, transformedBody: completionPayload };
    }

    if (!upstreamRes.ok) {
      let text = "";
      try { text = await upstreamRes.text(); } catch {}
      log?.error?.("DEEPSEEK-WEB", `Upstream HTTP ${upstreamRes.status}: ${text.slice(0, 200)}`);
      const errResp = new Response(JSON.stringify({
        error: { message: `DeepSeek Web returned HTTP ${upstreamRes.status}: ${text || upstreamRes.statusText}`, type: "upstream_error" }
      }), { status: upstreamRes.status, headers: { "Content-Type": "application/json" } });
      return { response: errResp, url: completionUrl, headers: completionHeaders, transformedBody: completionPayload };
    }

    // Convert SSE/stream response to OpenAI format
    const created = Math.floor(Date.now() / 1000);
    const responseId = `chatcmpl-dsw-${Math.random().toString(36).slice(2, 10)}`;

    if (stream) {
      let streamBuffer = "";
      const decoder = new TextDecoder();

      const transformStream = new TransformStream({
        transform(chunk, controller) {
          streamBuffer += decoder.decode(chunk, { stream: true });
          const lines = streamBuffer.split("\n");
          streamBuffer = lines.pop() || "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data:")) continue;
            const dataStr = trimmed.slice(5).trim();
            if (!dataStr || dataStr === "[DONE]") continue;

            try {
              const json = JSON.parse(dataStr);
              if (json.code !== undefined && json.code !== 0) {
                log?.error?.("DEEPSEEK-WEB", `Stream error: ${json.msg || json.code}`);
                continue;
              }
              const bizData = json?.data?.biz_data || json?.biz_data || json?.data || json;
              const choices = bizData?.choices || json?.choices || [];
              for (const choice of choices) {
                const delta = choice?.delta;
                if (!delta) continue;
                const contentType = delta.type || "text";
                const contentText = delta.content || delta.text || "";

                if (!contentText) continue;

                let ssePayload = null;
                if (contentType === "thinking") {
                  ssePayload = {
                    id: responseId,
                    object: "chat.completion.chunk",
                    created,
                    model,
                    choices: [{
                      index: 0,
                      delta: { reasoning_content: contentText },
                      finish_reason: null,
                    }],
                  };
                } else {
                  ssePayload = {
                    id: responseId,
                    object: "chat.completion.chunk",
                    created,
                    model,
                    choices: [{
                      index: 0,
                      delta: { content: contentText },
                      finish_reason: null,
                    }],
                  };
                }

                if (ssePayload) {
                  controller.enqueue(new TextEncoder().encode(sseChunk(ssePayload)));
                }
              }
            } catch {}
          }
        },
        flush(controller) {
          if (streamBuffer.trim().startsWith("data:")) {
            const dataStr = streamBuffer.trim().slice(5).trim();
            if (dataStr && dataStr !== "[DONE]") {
              try {
                const json = JSON.parse(dataStr);
                const bizData = json?.data?.biz_data || json?.biz_data || json?.data || json;
                const choices = bizData?.choices || json?.choices || [];
                for (const choice of choices) {
                  const delta = choice?.delta;
                  if (!delta) continue;
                  const contentType = delta.type || "text";
                  const contentText = delta.content || delta.text || "";
                  if (contentText) {
                    const ssePayload = contentType === "thinking" ? {
                      id: responseId,
                      object: "chat.completion.chunk",
                      created,
                      model,
                      choices: [{ index: 0, delta: { reasoning_content: contentText }, finish_reason: null }]
                    } : {
                      id: responseId,
                      object: "chat.completion.chunk",
                      created,
                      model,
                      choices: [{ index: 0, delta: { content: contentText }, finish_reason: null }]
                    };
                    controller.enqueue(new TextEncoder().encode(sseChunk(ssePayload)));
                  }
                }
              } catch {}
            }
          }
          const finalChunk = {
            id: responseId,
            object: "chat.completion.chunk",
            created,
            model,
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          };
          controller.enqueue(new TextEncoder().encode(sseChunk(finalChunk)));
          controller.enqueue(new TextEncoder().encode(SSE_DONE));
        }
      });

      const responseStream = upstreamRes.body.pipeThrough(transformStream);
      const res = new Response(responseStream, {
        status: 200,
        headers: SSE_HEADERS_NO_BUFFER,
      });

      return { response: res, url: completionUrl, headers: completionHeaders, transformedBody: completionPayload };
    }

    // Non-streaming handling: read stream and accumulate
    const reader = upstreamRes.body.getReader();
    const decoder = new TextDecoder();
    let fullText = "";
    let fullThinking = "";
    let buffer = "";

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const dataStr = trimmed.slice(5).trim();
          if (!dataStr || dataStr === "[DONE]") continue;

          try {
            const json = JSON.parse(dataStr);
            const choices = json?.data?.biz_data?.choices || json?.choices || [];
            for (const choice of choices) {
              const delta = choice?.delta;
              if (!delta) continue;
              if (delta.type === "thinking") {
                fullThinking += delta.content || "";
              } else {
                fullText += delta.content || "";
              }
            }
          } catch {}
        }
      }
    } catch {}

    const responseMsg = { role: "assistant", content: fullText };
    if (fullThinking) {
      responseMsg.reasoning_content = fullThinking;
    }

    const totalTokens = Math.ceil((promptText.length + fullText.length + fullThinking.length) / 4);

    const jsonResp = new Response(JSON.stringify({
      id: responseId,
      object: "chat.completion",
      created,
      model,
      choices: [{ index: 0, message: responseMsg, finish_reason: "stop" }],
      usage: {
        prompt_tokens: Math.ceil(promptText.length / 4),
        completion_tokens: Math.ceil((fullText.length + fullThinking.length) / 4),
        total_tokens: totalTokens,
      },
    }), { status: 200, headers: { "Content-Type": "application/json" } });

    return { response: jsonResp, url: completionUrl, headers: completionHeaders, transformedBody: completionPayload };
  }
}
