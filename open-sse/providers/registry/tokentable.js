// TokenTable web chat — OpenAI-shaped SSE at /api/chat, apiKey travels IN THE BODY.
// Models come from /v1/models (public); passthrough so any listed id works.
export default {
  id: "tokentable",
  priority: 45,
  hasFree: true,
  alias: "tt",
  uiAlias: "tt",
  display: {
    name: "TokenTable Web",
    icon: "coins",
    color: "#7C3AED",
    textIcon: "TT",
    website: "https://tokentable.asia/en/chat",
    notice: {
      apiKeyUrl: "https://tokentable.asia/en/chat",
    },
  },
  category: "webCookie",
  authType: "apikey",
  authHint: "Paste the web apiKey (tt-web-...) captured from tokentable.asia/api/chat request body",
  transport: {
    baseUrl: "https://tokentable.asia",
    format: "openai",
    forceStream: true,
  },
  models: [
    { id: "auto", name: "TokenTable Auto" },
    { id: "deepseek-ai/DeepSeek-V4.1-Flash", name: "DeepSeek V4.1 Flash" },
    { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash" },
    { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro" },
    { id: "qwen3.8-max", name: "Qwen3.8 Max" },
    { id: "gemini-3.8-flash", name: "Gemini 3.8 Flash" },
  ],
  modelsFetcher: { url: "https://tokentable.asia/v1/models", type: "tokentable" },
  passthroughModels: true,
};
