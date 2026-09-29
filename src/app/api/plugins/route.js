import { NextResponse } from "next/server";
import { getSettings, updateSettings } from "@/lib/localDb";
import { clearPluginCache } from "@/lib/plugins/customPluginsRuntime";

export const dynamic = "force-dynamic";

// Custom System Prompts: [{id, name, text, models[], enabled}]
// Enforce: 1 model belongs to at most 1 prompt (later prompts steal the model).
function sanitizeSystemPrompts(input) {
  const enabled = Boolean(input?.enabled);
  const prompts = Array.isArray(input?.prompts) ? input.prompts : [];
  const seenModels = new Set();
  const clean = [];
  for (const p of prompts) {
    const text = typeof p?.text === "string" ? p.text.slice(0, 20000) : "";
    const models = Array.isArray(p?.models)
      ? p.models.filter((m) => {
          if (typeof m !== "string" || !m.trim()) return false;
          if (seenModels.has(m)) return false; // enforce 1 model = 1 prompt
          return true;
        })
      : [];
    for (const m of models) seenModels.add(m);
    clean.push({
      id: typeof p?.id === "string" && p.id ? p.id.slice(0, 64) : `sp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name: typeof p?.name === "string" ? p.name.slice(0, 100) : "Untitled",
      text,
      models: models.filter(Boolean),
      enabled: p?.enabled !== false,
    });
  }
  return { enabled, prompts: clean };
}

export async function GET() {
  try {
    const settings = await getSettings();
    const customPlugins = settings.customPlugins || {
      imageVision: { enabled: false, models: [] },
      thinkDeeper: { enabled: false, models: [] },
      unrestrictedMode: { enabled: false, models: [] },
      speedMode: { enabled: false, models: [] },
      systemPrompts: { enabled: false, prompts: [] },
    };
    return NextResponse.json({ customPlugins }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("Error getting custom plugins:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function PUT(request) {
  try {
    const body = await request.json();
    const { customPlugins } = body;
    if (!customPlugins || typeof customPlugins !== "object") {
      return NextResponse.json({ error: "Invalid customPlugins payload" }, { status: 400 });
    }

    const merged = {
      imageVision: {
        enabled: Boolean(customPlugins.imageVision?.enabled),
        models: Array.isArray(customPlugins.imageVision?.models) ? customPlugins.imageVision.models.filter(Boolean) : [],
      },
      thinkDeeper: {
        enabled: Boolean(customPlugins.thinkDeeper?.enabled),
        models: Array.isArray(customPlugins.thinkDeeper?.models) ? customPlugins.thinkDeeper.models.filter(Boolean) : [],
      },
      unrestrictedMode: {
        enabled: Boolean(customPlugins.unrestrictedMode?.enabled),
        models: Array.isArray(customPlugins.unrestrictedMode?.models) ? customPlugins.unrestrictedMode.models.filter(Boolean) : [],
      },
      speedMode: {
        enabled: Boolean(customPlugins.speedMode?.enabled),
        models: Array.isArray(customPlugins.speedMode?.models) ? customPlugins.speedMode.models.filter(Boolean) : [],
      },
      systemPrompts: sanitizeSystemPrompts(customPlugins.systemPrompts),
    };

    await updateSettings({ customPlugins: merged });
    clearPluginCache();
    return NextResponse.json({ success: true, customPlugins: merged });
  } catch (error) {
    console.error("Error updating custom plugins:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
