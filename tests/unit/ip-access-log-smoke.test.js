// Smoke check: getIpAccessLog + saveRequestUsage with ip (runs outside vitest via tsconfig paths? no — via vitest)
import { describe, it, expect } from "vitest";
import { saveRequestUsage, getIpAccessLog } from "../../src/lib/db/index.js";

describe("ip access log — smoke", () => {
  it("records usage with ip and aggregates per-IP", async () => {
    await saveRequestUsage({
      provider: "openai", model: "gpt-smoke-test",
      tokens: { prompt_tokens: 10, completion_tokens: 5 },
      ip: "203.0.113.99", apiKey: null, endpoint: "/v1/chat/completions",
    });
    const ips = await getIpAccessLog();
    const hit = ips.filter((e) => e.ip === "203.0.113.99");
    expect(hit.length).toBe(1);
    expect(hit[0].requests).toBeGreaterThanOrEqual(1);
    expect(hit[0].lastSeen).toBeTruthy();
  });
});
