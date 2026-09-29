import { platform, arch } from "os";

// === OS/Arch helpers (Stainless fingerprint) ===
export function mapStainlessOs() {
  switch (platform()) {
    case "darwin": return "MacOS";
    case "win32": return "Windows";
    case "linux": return "Linux";
    case "freebsd": return "FreeBSD";
    default: return `Other::${platform()}`;
  }
}

export function mapStainlessArch() {
  switch (arch()) {
    case "x64": return "x64";
    case "arm64": return "arm64";
    case "ia32": return "x86";
    default: return `other::${arch()}`;
  }
}

// Anthropic API version (single source — reused across claude-format providers/executors)
export const ANTHROPIC_API_VERSION = "2023-06-01";
export const CLAUDE_CLI_VERSION = "2.1.280";

// Shared Claude-compatible API headers (reused across claude-format providers)
export const CLAUDE_API_HEADERS = {
  "Anthropic-Version": ANTHROPIC_API_VERSION,
  "Anthropic-Beta": "claude-code-20250219,interleaved-thinking-2025-05-14"
};

// Full Claude CLI fingerprint — required by providers that gate on client identity (e.g. agentrouter)
export const CLAUDE_CLI_SPOOF_HEADERS = {
  "Anthropic-Version": ANTHROPIC_API_VERSION,
  "Anthropic-Beta": "claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,context-management-2025-06-27,prompt-caching-scope-2026-01-05,advanced-tool-use-2025-11-20,effort-2025-11-24,structured-outputs-2025-12-15,fast-mode-2026-02-01,redact-thinking-2026-02-12,token-efficient-tools-2026-03-28",
  "Anthropic-Dangerous-Direct-Browser-Access": "true",
  "User-Agent": `claude-cli/${CLAUDE_CLI_VERSION} (external, sdk-cli)`,
  "X-App": "cli",
  "X-Stainless-Helper-Method": "stream",
  "X-Stainless-Retry-Count": "0",
  "X-Stainless-Runtime-Version": "v24.14.0",
  "X-Stainless-Package-Version": "0.80.0",
  "X-Stainless-Runtime": "node",
  "X-Stainless-Lang": "js",
  "X-Stainless-Arch": mapStainlessArch(),
  "X-Stainless-Os": mapStainlessOs(),
  "X-Stainless-Timeout": "600"
};

const ANTHROPIC_BETA_BASE = [
  "claude-code-20250219",
  "oauth-2025-04-20",
  "interleaved-thinking-2025-05-14",
  "context-management-2025-06-27",
  "prompt-caching-scope-2026-01-05",
  "structured-outputs-2025-12-15",
  "fast-mode-2026-02-01",
  "redact-thinking-2026-02-12",
  "token-efficient-tools-2026-03-28",
];
const ANTHROPIC_BETA_HEAVY_AGENT = ["advanced-tool-use-2025-11-20", "effort-2025-11-24"];

// Heavy-agent beta flags are gated to opus/sonnet — cheaper models don't need them.
// `redact-thinking` asks Anthropic to return signature-only thinking blocks, which
// is right for clients that never render thinking but blanks the summaries a
// client explicitly requested with `thinking.display: "summarized"`.
const ANTHROPIC_BETA_REDACT_THINKING = "redact-thinking-2026-02-12";

export function wantsThinkingSummaries(body) {
  return body?.thinking?.display === "summarized";
}

export function selectAnthropicBeta(model = "", body = null) {
  const flags = ANTHROPIC_BETA_BASE.filter((flag) => flag !== ANTHROPIC_BETA_REDACT_THINKING || !wantsThinkingSummaries(body));
  if (/^claude-(opus|sonnet)/.test(model)) flags.push(...ANTHROPIC_BETA_HEAVY_AGENT);
  return flags.join(",");
}

export function mergeAnthropicBeta(...values) {
  const flags = values.flatMap((v) => (typeof v === "string" ? v.split(",") : [])).map((f) => f.trim()).filter(Boolean);
  return [...new Set(flags)].join(",");
}

// Shared baseUrls
export const KIMI_CODING_BASE_URL = "https://api.kimi.com/coding/v1/messages";


// Shared provider baseUrls (single source of truth for registries sharing an endpoint)
export const AGNES_API_BASE_URL = "https://apihub.agnes-ai.com/v1/chat/completions";
export const DASHSCOPE_INTL_COMPAT_BASE_URL = "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions";
export const ANTHROPIC_MESSAGES_BASE_URL = "https://api.anthropic.com/v1/messages";
export const CLINE_API_BASE_URL = "https://api.cline.bot/api/v1/chat/completions";
export const FISH_AUDIO_TTS_BASE_URL = "https://api.fish.audio/v1/tts";
export const KIMI_CODING_MESSAGES_BASE_URL = "https://api.kimi.com/coding/v1/messages";
export const KIMI_CODING_CHAT_BASE_URL = "https://api.kimi.com/coding/v1/chat/completions";
export const LLAMA_CPP_LOCAL_BASE_URL = "http://127.0.0.1:8080/v1/chat/completions";
export const MIMO_FREE_BASE_URL = "https://api.xiaomimimo.com/api/free-ai/openai/chat";
export const NAGA_AC_BASE_URL = "https://api.naga.ac/v1/chat/completions";
export const OPENCODE_ZEN_SYSTEMONE_BASE_URL = "https://opencode.ai/zen/v1/systemone";
export const VLLM_LOCAL_BASE_URL = "http://localhost:8000/v1/chat/completions";
export const VERTEX_AI_PLATFORM_BASE_URL = "https://aiplatform.googleapis.com";

// Default base for dynamic compat providers (openai-compatible-* / anthropic-compatible-*) when user gives no baseUrl
export const OPENAI_COMPAT_BASE = "https://api.openai.com/v1";
export const ANTHROPIC_COMPAT_BASE = "https://api.anthropic.com/v1";

// Official Antigravity IDE Desktop 2.11.0 fingerprint captured from macOS arm64.
// Keep this static even when 9router runs on Linux: the provider profile is
// intentionally matching the IDE client, not the server host.
export const ANTIGRAVITY_IDE_VERSION = "2.11.0";
export const ANTIGRAVITY_IDE_BASE_URL = "https://daily-cloudcode-pa.googleapis.com";
export const ANTIGRAVITY_IDE_USER_AGENT = `antigravity/ide/${ANTIGRAVITY_IDE_VERSION} darwin/arm64`;

// Antigravity OAuth client credentials (public CLI client — duplicated in usage.js + src/lib/oauth)
export const ANTIGRAVITY_OAUTH_CLIENT = {
  clientId: "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com",
  clientSecret: "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"
};

// Gemini (Google) OAuth client credentials (public CLI client — shared by gemini, gemini-cli, src/lib/oauth)
export const GOOGLE_OAUTH_CLIENT = {
  clientId: "681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com",
  clientSecret: "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"
};
