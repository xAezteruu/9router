import { DASHSCOPE_INTL_COMPAT_BASE_URL } from "../shared.js";
// Model Studio Intl — standard DashScope API keys (sk-...), NOT Coding Plan keys.
// Sibling of alicode-intl (Coding Plan). Two key types use two different hosts.
export default {
  id: "alims-intl",
  priority: 11,
  alias: "alims-intl",
  display: {
    name: "Alibaba Studio",
    icon: "cloud",
    color: "#FF6A00",
    textIcon: "ALi",
    website: "https://modelstudio.console.alibabacloud.com",
    notice: {
      apiKeyUrl: "https://modelstudio.console.alibabacloud.com/?apiKey=1",
    },
  },
  category: "apikey",
  transport: {
    baseUrl: DASHSCOPE_INTL_COMPAT_BASE_URL,
    headers: {},
    quirks: { preserveCacheControl: true },
  },
  models: [
    { id: "qwen3.5-plus", name: "Qwen3.5 Plus" },
    { id: "kimi-k2.5", name: "Kimi K2.5" },
    { id: "glm-5", name: "GLM 5" },
    { id: "MiniMax-M2.5", name: "MiniMax M2.5" },
    { id: "qwen3-coder-next", name: "Qwen3 Coder Next" },
    { id: "qwen3-coder-plus", name: "Qwen3 Coder Plus" },
    { id: "glm-4.7", name: "GLM 4.7" },
  ],
};
