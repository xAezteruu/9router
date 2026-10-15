import { NextResponse } from "next/server";
import { CUSTOM_PLUGIN_KEYS } from "@/shared/constants/pluginKeys";
import { getSettings, updateSettings } from "@/lib/localDb";
import { clearPluginCache } from "@/lib/plugins/customPluginsRuntime";

export const dynamic = "force-dynamic";

// Custom System Prompts (fork): [{id, name, text, models[], enabled}]
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

// Anti Slop intensity, kept in step with the page's picker. "full" is the
// fallback: a plugin that silently stops filtering is worse than one that
// filters hard.
const ANTISLOP_LEVELS = new Set(["lite", "full", "ultra"]);
function normalizeAntislopLevel(level) {
  return ANTISLOP_LEVELS.has(level) ? level : "full";
}

export async function GET() {
  try {
    const settings = await getSettings();
    const stored = settings.customPlugins || {};
    // Answer over the key list (upstream) + fork-only systemPrompts plugin.
    // A plugin missing from settings reads as off, never undefined.
    const customPlugins = {};
    for (const key of [...CUSTOM_PLUGIN_KEYS, "unrestrictedMode"]) {
      const entry = stored[key];
      customPlugins[key] = {
        enabled: Boolean(entry?.enabled),
        models: Array.isArray(entry?.models) ? entry.models.filter(Boolean) : [],
        ...(key === "antiSlop" ? { level: normalizeAntislopLevel(entry?.level) } : {}),
      };
    }
    customPlugins.systemPrompts = sanitizeSystemPrompts(stored.systemPrompts);
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

    // Merged over the key list + fork-only systemPrompts plugin.
    const merged = {};
    for (const key of [...CUSTOM_PLUGIN_KEYS, "unrestrictedMode"]) {
      const entry = customPlugins[key];
      merged[key] = {
        enabled: Boolean(entry?.enabled),
        models: Array.isArray(entry?.models) ? entry.models.filter(Boolean) : [],
        // Anti Slop's level rides on the same entry; dropped otherwise on save.
        ...(key === "antiSlop" ? { level: normalizeAntislopLevel(entry?.level) } : {}),
      };
    }
    merged.systemPrompts = sanitizeSystemPrompts(customPlugins.systemPrompts);

    await updateSettings({ customPlugins: merged });
    clearPluginCache();
    return NextResponse.json({ success: true, customPlugins: merged });
  } catch (error) {
    console.error("Error updating custom plugins:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
