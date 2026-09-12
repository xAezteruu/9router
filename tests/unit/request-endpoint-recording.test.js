import { describe, it, expect } from "vitest";
import { buildRequestDetail } from "../../open-sse/handlers/chatCore/requestDetail.js";

describe("request endpoint recording (/v1 tagging)", () => {
  it("carries endpoint from clientRawRequest into the detail", () => {
    const d = buildRequestDetail({
      provider: "openai",
      model: "gpt-x",
      endpoint: "/api/v1/chat/completions",
    }, { apiKey: "sk-test-123" });
    expect(d.endpoint).toBe("/api/v1/chat/completions");
    expect(d.apiKey).toBe("sk-test-123");
  });

  it("endpoint absent → undefined (not null-polluted)", () => {
    const d = buildRequestDetail({ provider: "openai", model: "gpt-x" });
    expect(d.endpoint).toBeUndefined();
  });

  it("endpoint filter matching: /v1-family covers all LLM API surfaces", () => {
    const llmEndpoints = [
      "/v1/chat/completions",
      "/v1/messages",
      "/v1/responses",
      "/v1beta/models",
      "/codex/responses",
      "/responses",
      "/api/v1/chat/completions",
    ];
    const v1Re = /^\/(v1|api\/v1|v1beta|api\/v1beta|codex|responses)/;
    for (const ep of llmEndpoints) {
      expect(v1Re.test(ep)).toBe(true);
    }
    // Non-LLM surfaces must NOT match the v1 filter
    for (const ep of ["/api/health", "/api/settings", "/api/proxy-pools", "/dashboard"]) {
      expect(v1Re.test(ep)).toBe(false);
    }
  });
});
