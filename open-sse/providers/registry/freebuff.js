<<<<<<< HEAD
export default {
  id: "freebuff",
  priority: 25,
  hasFree: true,
  alias: "cb",
  aliases: ["codebuff"],
  uiAlias: "cb",
  display: {
    name: "Freebuff",
    icon: "bolt",
    color: "#6366F1",
    textIcon: "FB",
    website: "https://www.codebuff.com",
    notice: {
      signupUrl: "https://www.codebuff.com",
    },
  },
  category: "free",
  hasOAuth: true,
  authType: "oauth",
  authModes: ["oauth", "apikey"],
  transport: {
    baseUrl: "https://www.codebuff.com/api/v1/chat/completions",
    format: "openai",
    timeoutMs: 120000,
  },
  models: [
    { id: "mimo/mimo-v2.5", name: "MiMo v2.5 (Free)" },
    { id: "minimax/minimax-m2.7", name: "MiniMax M2.7 (Free)" },
    { id: "z-ai/glm-5.1", name: "GLM 5.1 (Free)" },
    { id: "google/gemini-3.1-pro-preview", name: "Gemini 3.1 Pro Preview (Free)" },
    { id: "deepseek/deepseek-v4-flash", name: "DeepSeek v4 Flash (Free)" },
    { id: "deepseek/deepseek-v4-pro", name: "DeepSeek v4 Pro (Free)" },
    { id: "moonshotai/kimi-k2.6", name: "Kimi k2.6 (Free)" },
  ],
  oauth: {
    deviceCodeUrl: "https://www.codebuff.com/api/auth/cli/code",
    tokenUrl: "https://www.codebuff.com/api/auth/cli/status",
  },
=======
// Freebuff (Account / codebuff.com API) — free-tier authToken provider.
//
// Freebuff's CLI/API surface authenticates with a raw `authToken` (from the
// Freebuff CLI at ~/.config/manicode/credentials.json or https://freebuff.llm.pm)
// against https://codebuff.com — NOT an OAuth2 flow. The FreeBuffExecutor
// (open-sse/executors/freebuff.js) bridges the private session/run protocol to
// an OpenAI-compatible interface:
//   1. POST /api/v1/freebuff/session (x-freebuff-model header) → instanceId
//   2. POST /api/v1/agent-runs {action:"START", agentId:"base2-free"} → runId
//   3. POST /api/v1/chat/completions + codebuff_metadata {run_id, cost_mode:"free", ...}
//
// Distinct from freebuff-web (freebuff.com/chat via NextAuth session cookie) —
// this is the account-token surface. Model list is curated from the official
// catalog (2026-08-13); server-side admission is stricter than the client
// picker, so each entry stays only after a successful E2E test.
export default {
  id: "freebuff",
  priority: 66,
  alias: "fb",
  aliases: ["freebuff-api", "freebuff-token"],
  uiAlias: "fb",
  display: {
    name: "Freebuff (Account)",
    icon: "bolt",
    color: "#F97316",
    textIcon: "FB",
    website: "https://freebuff.com",
    notice: {
      signupUrl: "https://freebuff.llm.pm",
      apiKeyUrl: "https://freebuff.llm.pm",
      text: "Connect your Freebuff account with a guided browser login (freebuff.com GitHub/Google) — no manual token needed. Already have an authToken? Paste it from https://freebuff.llm.pm or import it from the Freebuff CLI (~/.config/manicode/credentials.json).",
    },
  },
  category: "oauth",
  authModes: ["oauth"],
  hasOAuth: true,
  transport: {
    baseUrl: "https://codebuff.com",
    format: "freebuff",
    authType: "token",
  },
  models: [
    { id: "deepseek/deepseek-v4-flash", name: "DeepSeek V4 Flash (Freebuff)" },
    { id: "deepseek/deepseek-v4-pro", name: "DeepSeek V4 Pro (Freebuff)" },
    { id: "openai/gpt-5.6-luna", name: "GPT-5.6 Luna (Freebuff)" },
    { id: "minimax/minimax-m3", name: "MiniMax M3 (Freebuff)" },
  ],
>>>>>>> serenhope/master
  passthroughModels: true,
};
