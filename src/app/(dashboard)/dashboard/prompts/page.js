"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Card,
  Button,
  Badge,
  Toggle,
  ModelSelectModal,
  CapacityBadges,
} from "@/shared/components";
import { useModelCaps } from "@/shared/hooks/useModelCaps";

const DEFAULT_PLUGINS_STATE = {
  imageVision: { enabled: false, models: [] },
  thinkDeeper: { enabled: false, models: [] },
  unrestrictedMode: { enabled: false, models: [] },
  speedMode: { enabled: false, models: [] },
  systemPrompts: { enabled: false, prompts: [] },
};

function formatModelName(modelVal) {
  if (!modelVal) return "";
  return modelVal.includes("/")
    ? modelVal.split("/").slice(1).join("/")
    : modelVal;
}

export default function PromptsPage() {
  const [customPlugins, setCustomPlugins] = useState(DEFAULT_PLUGINS_STATE);
  const [activeProviders, setActiveProviders] = useState([]);
  const [pickerPromptId, setPickerPromptId] = useState(null);
  const { getCaps } = useModelCaps();

  useEffect(() => {
    async function loadData() {
      try {
        const [pluginsRes, providersRes] = await Promise.all([
          fetch("/api/plugins", { cache: "no-store" }),
          fetch("/api/providers", { cache: "no-store" }),
        ]);

        if (pluginsRes.ok) {
          const data = await pluginsRes.json();
          if (data.customPlugins) {
            setCustomPlugins((prev) => ({
              ...prev,
              ...data.customPlugins,
              systemPrompts: {
                enabled: Boolean(data.customPlugins.systemPrompts?.enabled),
                prompts: Array.isArray(data.customPlugins.systemPrompts?.prompts)
                  ? data.customPlugins.systemPrompts.prompts.map((p) => ({
                      id: p.id,
                      name: p.name,
                      text: p.text,
                      models: Array.isArray(p.models) ? p.models : [],
                      enabled: p.enabled !== false,
                    }))
                  : [],
              },
            }));
          }
        }

        if (providersRes.ok) {
          const provData = await providersRes.json();
          setActiveProviders(provData.connections || []);
        }
      } catch (err) {
        console.error("Failed to load prompt data:", err);
      }
    }

    loadData();
  }, []);

  const savePlugins = useCallback(async (updatedPlugins) => {
    try {
      const res = await fetch("/api/plugins", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ customPlugins: updatedPlugins }),
      });
      if (res.ok) {
        window.dispatchEvent(new Event("customModelChanged"));
      }
    } catch (err) {
      console.error("Failed to save prompts:", err);
    }
  }, []);

  const commit = useCallback(
    (updater) => {
      setCustomPlugins((prev) => {
        const updated = updater(prev);
        savePlugins(updated);
        return updated;
      });
    },
    [savePlugins]
  );

  const handleToggleSystemPrompts = useCallback(
    (enabled) =>
      commit((prev) => ({
        ...prev,
        systemPrompts: { ...(prev.systemPrompts || { prompts: [] }), enabled },
      })),
    [commit]
  );

  const addSystemPrompt = useCallback(
    () =>
      commit((prev) => {
        const sp = prev.systemPrompts || { enabled: false, prompts: [] };
        return {
          ...prev,
          systemPrompts: {
            ...sp,
            enabled: true,
            prompts: [
              ...(sp.prompts || []),
              {
                id: `sp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                name: `Prompt ${(sp.prompts?.length || 0) + 1}`,
                text: "",
                models: [],
                enabled: true,
              },
            ],
          },
        };
      }),
    [commit]
  );

  const updateSystemPrompt = useCallback(
    (id, patch) =>
      commit((prev) => {
        const sp = prev.systemPrompts || { enabled: false, prompts: [] };
        let prompts = (sp.prompts || []).map((p) => (p.id === id ? { ...p, ...patch } : p));
        // 1 model → 1 prompt: if this prompt's models overlap another prompt, steal them.
        if (Array.isArray(patch.models)) {
          const mine = new Set(patch.models);
          prompts = prompts.map((p) =>
            p.id === id ? p : { ...p, models: (p.models || []).filter((m) => !mine.has(m)) }
          );
        }
        return { ...prev, systemPrompts: { ...sp, prompts } };
      }),
    [commit]
  );

  const removeSystemPrompt = useCallback(
    (id) =>
      commit((prev) => {
        const sp = prev.systemPrompts || { enabled: false, prompts: [] };
        return {
          ...prev,
          systemPrompts: { ...sp, prompts: (sp.prompts || []).filter((p) => p.id !== id) },
        };
      }),
    [commit]
  );

  const activePickerPrompt = (customPlugins.systemPrompts?.prompts || []).find(
    (p) => p.id === pickerPromptId
  );

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-text-main">System Prompts</h1>
          <p className="text-sm text-text-muted mt-1">
            Inject your own system prompt into selected models. Each prompt can
            target one or more models, but each model can only have one system
            prompt.
          </p>
        </div>
        <Toggle
          checked={Boolean(customPlugins.systemPrompts?.enabled)}
          onChange={handleToggleSystemPrompts}
        />
      </div>

      {Boolean(customPlugins.systemPrompts?.enabled) && (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
          {(customPlugins.systemPrompts?.prompts || []).map((sp) => (
            <Card key={sp.id} className="flex flex-col h-full">
              <div className="flex items-center gap-2 mb-3">
                <div className="size-10 rounded-xl flex items-center justify-center border shrink-0 bg-violet-500/10 border-violet-500/20">
                  <span className="material-symbols-outlined text-[22px] leading-none text-violet-500">
                    description
                  </span>
                </div>
                <input
                  type="text"
                  value={sp.name}
                  onChange={(e) => updateSystemPrompt(sp.id, { name: e.target.value })}
                  placeholder="Prompt name"
                  className="flex-1 min-w-0 px-2 py-1 rounded-lg bg-surface-1 border border-border-subtle text-sm text-text-main focus:outline-none focus:border-violet-500"
                />
                <Toggle
                  checked={sp.enabled !== false}
                  onChange={(val) => updateSystemPrompt(sp.id, { enabled: val })}
                />
                <button
                  type="button"
                  onClick={() => removeSystemPrompt(sp.id)}
                  className="text-text-muted hover:text-red-500 transition-colors cursor-pointer"
                  title="Delete prompt"
                >
                  <span className="material-symbols-outlined text-[18px]">delete</span>
                </button>
              </div>

              <textarea
                value={sp.text}
                onChange={(e) => updateSystemPrompt(sp.id, { text: e.target.value })}
                placeholder="System prompt text..."
                rows={6}
                className="w-full mb-4 px-2 py-1.5 rounded-lg bg-surface-1 border border-border-subtle text-xs text-text-main font-mono resize-y focus:outline-none focus:border-violet-500"
              />

              <div className="mt-auto pt-4 border-t border-border-subtle">
                <div className="flex items-center justify-between gap-2 mb-3">
                  <span className="text-xs font-semibold text-text-muted uppercase tracking-wider">
                    Models ({sp.models.length})
                  </span>
                  <Button
                    size="sm"
                    variant="secondary"
                    icon="add"
                    onClick={() => setPickerPromptId(sp.id)}
                  >
                    Add Models
                  </Button>
                </div>
                {sp.models.length === 0 ? (
                  <p className="text-xs text-text-muted italic">
                    No models assigned yet
                  </p>
                ) : (
                  <div className="flex flex-wrap gap-1.5">
                    {sp.models.map((modelVal) => (
                      <Badge
                        key={modelVal}
                        variant="default"
                        size="md"
                        className="font-medium bg-surface-2 text-text-main border border-border-subtle"
                      >
                        <span className="truncate max-w-[180px]">
                          {formatModelName(modelVal)}
                        </span>
                        <CapacityBadges caps={getCaps(modelVal)} />
                        <button
                          type="button"
                          onClick={() =>
                            updateSystemPrompt(sp.id, {
                              models: sp.models.filter((m) => m !== modelVal),
                            })
                          }
                          className="text-text-muted hover:text-red-500 transition-colors cursor-pointer leading-none ml-0.5"
                          title="Remove model"
                        >
                          <span className="material-symbols-outlined text-[14px]">
                            close
                          </span>
                        </button>
                      </Badge>
                    ))}
                  </div>
                )}
              </div>
            </Card>
          ))}

          <button
            type="button"
            onClick={addSystemPrompt}
            className="min-h-[120px] rounded-2xl border-2 border-dashed border-border-subtle bg-surface-2/20 hover:bg-surface-2/40 hover:border-violet-500/50 transition-colors flex flex-col items-center justify-center gap-2 text-text-muted hover:text-violet-500 cursor-pointer"
          >
            <span className="material-symbols-outlined text-[32px]">add</span>
            <span className="text-sm font-medium">Add System Prompt</span>
          </button>
        </div>
      )}

      {!Boolean(customPlugins.systemPrompts?.enabled) && (
        <div className="p-8 rounded-2xl border border-dashed border-border-subtle bg-surface-2/20 text-center">
          <p className="text-sm text-text-muted">
            Enable System Prompts (toggle above) to start creating prompts.
          </p>
        </div>
      )}

      {pickerPromptId && (
        <ModelSelectModal
          isOpen={Boolean(pickerPromptId)}
          onClose={() => setPickerPromptId(null)}
          onSelect={(m) => {
            const modelVal = typeof m === "string" ? m : m?.value || m?.name || m?.id || "";
            if (!modelVal) return;
            updateSystemPrompt(pickerPromptId, {
              models: [...(activePickerPrompt?.models || []), modelVal],
            });
          }}
          onDeselect={(m) => {
            const modelVal = typeof m === "string" ? m : m?.value || m?.name || m?.id || "";
            if (!modelVal) return;
            updateSystemPrompt(pickerPromptId, {
              models: (activePickerPrompt?.models || []).filter((x) => x !== modelVal),
            });
          }}
          activeProviders={activeProviders}
          title={`Select Models - ${activePickerPrompt?.name || "System Prompt"}`}
          addedModelValues={activePickerPrompt?.models || []}
          closeOnSelect={false}
        />
      )}
    </div>
  );
}
