import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  getSettings: vi.fn(async () => ({ customPlugins: {} })),
}));

vi.mock("@/lib/localDb", () => ({
  getSettings: mocks.getSettings,
}));

import {
  applyCustomPlugins,
  clearPluginCache,
} from "@/lib/plugins/customPluginsRuntime.js";
import { FORMATS } from "open-sse/translator/formats.js";

const MODEL = "prov/m1";

function enable(customPlugins) {
  mocks.getSettings.mockResolvedValue({ customPlugins });
  clearPluginCache();
}

function chatBody() {
  return { model: "m1", messages: [{ role: "user", content: "hi" }] };
}

function systemText(body) {
  return body.messages
    .filter((m) => m.role === "system")
    .map((m) => (typeof m.content === "string" ? m.content : ""))
    .join("\n");
}

beforeEach(() => {
  clearPluginCache();
  mocks.getSettings.mockReset();
  mocks.getSettings.mockResolvedValue({ customPlugins: {} });
});

describe("custom plugin → persona injection", () => {
  it("changes the composed persona when Think Deeper is enabled for the model", async () => {
    enable({ thinkDeeper: { enabled: true, models: [MODEL] } });
    const body = chatBody();

    const result = await applyCustomPlugins(body, "prov", "m1", FORMATS.OPENAI, MODEL);

    expect(result.isThinkDeeperActive).toBe(true);
    // Superpowers & Chain of Thought persona
    expect(systemText(body)).toContain("Adaptive Thinking & Superpowers Chain-of-Thought Active");
    // Native half
    expect(body.reasoning_effort).toBe("high");
  });

  it("leaves the persona alone while the plugin is disabled", async () => {
    enable({ thinkDeeper: { enabled: false, models: [MODEL] } });
    const body = chatBody();

    const result = await applyCustomPlugins(body, "prov", "m1", FORMATS.OPENAI, MODEL);

    expect(result.isThinkDeeperActive).toBe(false);
    expect(systemText(body)).toBe("");
    expect(body.messages).toHaveLength(1);
  });

  it("leaves the persona alone when the plugin is on but for another model", async () => {
    enable({ thinkDeeper: { enabled: true, models: ["prov/other"] } });
    const body = chatBody();

    await applyCustomPlugins(body, "prov", "m1", FORMATS.OPENAI, MODEL);

    expect(systemText(body)).toBe("");
  });

  it("does not stack a second copy of the instruction on a repeated run", async () => {
    enable({ thinkDeeper: { enabled: true, models: [MODEL] } });
    const body = chatBody();

    await applyCustomPlugins(body, "prov", "m1", FORMATS.OPENAI, MODEL);
    await applyCustomPlugins(body, "prov", "m1", FORMATS.OPENAI, MODEL);

    const systems = body.messages.filter((m) => m.role === "system");
    expect(systems).toHaveLength(1);
    expect(systems[0].content.match(/Adaptive Thinking/g)).toHaveLength(1);
  });

  it("injects into body.system on the Claude wire shape", async () => {
    enable({ thinkDeeper: { enabled: true, models: [MODEL] } });
    const body = { model: "m1", system: "You are terse.", messages: [] };

    await applyCustomPlugins(body, "prov", "m1", FORMATS.CLAUDE, MODEL);

    expect(body.system).toContain("Adaptive Thinking & Superpowers Chain-of-Thought Active");
    // The model's own persona stays in front of the plugin line.
    expect(body.system.startsWith("You are terse.")).toBe(true);
  });

  it("keeps the existing Anti Slop persona plugin injecting its rules", async () => {
    enable({ antiSlop: { enabled: true, models: [MODEL], level: "lite" } });
    const body = chatBody();

    const result = await applyCustomPlugins(body, "prov", "m1", FORMATS.OPENAI, MODEL);

    expect(result.isAntiSlopActive).toBe(true);
    expect(systemText(body)).toContain("antislop");
  });
});
