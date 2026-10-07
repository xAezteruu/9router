// Liquid AI — LFM family (efficiency-first hybrid models); OpenAI-compatible.
// The old api.liquid.ai host stopped serving the API; the live endpoint is
// inference.liquid.ai (verified by upstream sweep).
export default {
  id: "liquid",
  priority: 50,
  alias: "liquid",
  display: {
    name: "Liquid AI",
    icon: "water_drop",
    color: "#06B6D4",
    textIcon: "LQ",
    website: "https://liquid.ai",
    notice: {
      apiKeyUrl: "https://labs.liquid.ai/keys",
      text: "OpenAI-compatible. Free LFM2.5-1.2B-Thinking and LFM2.5-1.2B-Instruct models. MIT spinoff, hybrid architecture.",
    },
  },
  category: "apikey",
  authType: "apikey",
  transport: {
    baseUrl: "https://inference.liquid.ai/v1/chat/completions",
    validateUrl: "https://inference.liquid.ai/v1/models",
  },
  models: [
    { id: "liquid-lfm-40b", name: "Liquid LFM 40B" },
    { id: "d1", name: "Liquid d1 (Decision)", kind: "systemone" },
  ],
  serviceKinds: ["llm", "systemone"],
  hasFree: true,
  freeNote: "Free LFM2.5-1.2B-Thinking and LFM2.5-1.2B-Instruct models",
  // System One decision API (d1): https://api.liquid.ai/decisions
  systemoneConfig: {
    baseUrl: "https://api.liquid.ai/decisions/v1/systemone",
    authType: "apikey",
    authHeader: "bearer",
  },
};
