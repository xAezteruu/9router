import { LLAMA_CPP_LOCAL_BASE_URL } from "../shared.js";
// llama.cpp — local OpenAI-compatible inference server.
// Imported from OmniRoute catalog (2026-08). Default base URL is the localhost
// default; override per connection via providerSpecificData.baseUrl when the
// server runs on a different host/port.
export default {
  id: "llama-cpp",
  priority: 50,
  alias: "llamacpp",
  display: {
    name: "llama.cpp",
    icon: "description",
    color: "#795548",
    textIcon: "LC",
    website: "https://github.com/ggml-org/llama.cpp",
    notice: { text: "llama.cpp server — OpenAI-compatible local inference (default port 8080). Base URL overridable per connection." },
  },
  category: "apikey",
  hasFree: true,
  freeNote: "Runs on your own hardware — no per-token cost.",
  transport: {
    baseUrl: LLAMA_CPP_LOCAL_BASE_URL,
    format: "openai",
  },
  passthroughModels: true,
  serviceKinds: ["llm"],
};
