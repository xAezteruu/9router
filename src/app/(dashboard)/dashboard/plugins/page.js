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
import { useNotificationStore } from "@/store/notificationStore";

const PLUGINS = [
  {
    key: "imageVision",
    title: "Image Vision",
    icon: "visibility",
    iconColor: "text-blue-500",
    iconBg: "bg-blue-500/10 border-blue-500/20",
    description:
      "Enable image understanding for models that don't natively support vision. Images are converted to text descriptions, allowing any model to process visual content in CLI tools and agents.",
  },
  {
    key: "thinkDeeper",
    title: "Think Deeper",
    icon: "psychology",
    iconColor: "text-purple-500",
    iconBg: "bg-purple-500/10 border-purple-500/20",
    description:
      "Enhance reasoning with multi-step chain-of-thought analysis. Forces the model to break problems into steps before answering, producing more thorough and accurate responses.",
  },
  {
    key: "unrestrictedMode",
    title: "Uncensored Output",
    icon: "local_fire_department",
    iconColor: "text-red-500",
    iconBg: "bg-red-500/10 border-red-500/20",
    description:
      "Bypass standard AI refusals and guardrails. Injects an unrestricted direct technical directive, compelling the model to provide raw code, analysis, and uncensored answers (Note: may not work on some provider models).",
  },
  {
    key: "speedMode",
    title: "Speed Mode",
    icon: "bolt",
    iconColor: "text-cyan-500",
    iconBg: "bg-cyan-500/10 border-cyan-500/20",
    description:
      "Skip thinking for faster responses. Disables reasoning mode on the selected models and instructs them to answer directly, ideal for simple tasks where low latency matters more than deep analysis.",
  },
];

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

export default function PluginsPage() {
  const [customPlugins, setCustomPlugins] = useState(DEFAULT_PLUGINS_STATE);
  const [activeProviders, setActiveProviders] = useState([]);
  const [pickerPlugin, setPickerPlugin] = useState(null);
  const { getCaps } = useModelCaps();
  const addNotification = useNotificationStore((state) => state.addNotification);

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
            setCustomPlugins({
              imageVision: {
                enabled: Boolean(data.customPlugins.imageVision?.enabled),
                models: Array.isArray(data.customPlugins.imageVision?.models)
                  ? data.customPlugins.imageVision.models
                  : [],
              },
              thinkDeeper: {
                enabled: Boolean(data.customPlugins.thinkDeeper?.enabled),
                models: Array.isArray(data.customPlugins.thinkDeeper?.models)
                  ? data.customPlugins.thinkDeeper.models
                  : [],
              },
              unrestrictedMode: {
                enabled: Boolean(data.customPlugins.unrestrictedMode?.enabled),
                models: Array.isArray(data.customPlugins.unrestrictedMode?.models)
                  ? data.customPlugins.unrestrictedMode.models
                  : [],
              },
              speedMode: {
                enabled: Boolean(data.customPlugins.speedMode?.enabled),
                models: Array.isArray(data.customPlugins.speedMode?.models)
                  ? data.customPlugins.speedMode.models
                  : [],
              },
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
            });
          }
        }

        if (providersRes.ok) {
          const provData = await providersRes.json();
          setActiveProviders(provData.connections || []);
        }
      } catch (err) {
        console.error("Failed to load plugin data:", err);
      }
    }

    loadData();
  }, []);

  const savePlugins = useCallback(
    async (updatedPlugins) => {
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
        console.error("Failed to save plugins:", err);
      }
    },
    []
  );

  const handleToggle = useCallback(
    (pluginKey, enabled) => {
      setCustomPlugins((prev) => {
        const updated = {
          ...prev,
          [pluginKey]: {
            ...prev[pluginKey],
            enabled,
          },
        };
        savePlugins(updated);
        return updated;
      });
    },
    [savePlugins]
  );

  const handleAddModel = useCallback(
    (pluginKey, model) => {
      const modelVal =
        typeof model === "string"
          ? model
          : model?.value || model?.name || model?.id || "";
      if (!modelVal || !pluginKey) return;

      setCustomPlugins((prev) => {
        const currentModels = prev[pluginKey]?.models || [];
        if (currentModels.includes(modelVal)) return prev;

        const updated = {
          ...prev,
          [pluginKey]: {
            ...prev[pluginKey],
            models: [...currentModels, modelVal],
          },
        };
        savePlugins(updated);
        return updated;
      });
    },
    [savePlugins]
  );

  const handleRemoveModel = useCallback(
    (pluginKey, model) => {
      const modelVal =
        typeof model === "string"
          ? model
          : model?.value || model?.name || model?.id || "";
      if (!modelVal || !pluginKey) return;

      setCustomPlugins((prev) => {
        const currentModels = prev[pluginKey]?.models || [];
        if (!currentModels.includes(modelVal)) return prev;

        const updated = {
          ...prev,
          [pluginKey]: {
            ...prev[pluginKey],
            models: currentModels.filter((m) => m !== modelVal),
          },
        };
        savePlugins(updated);
        return updated;
      });
    },
    [savePlugins]
  );

  // ---- Custom System Prompts (multiple prompts; 1 model belongs to 1 prompt) ----
  const saveSystemPrompts = useCallback(
    (spState) => {
      setCustomPlugins((prev) => {
        const updated = { ...prev, systemPrompts: spState };
        savePlugins(updated);
        return updated;
      });
    },
    [savePlugins]
  );

  const handleToggleSystemPrompts = useCallback(
    (enabled) => {
      setCustomPlugins((prev) => {
        const sp = prev.systemPrompts || { enabled: false, prompts: [] };
        const updated = { ...prev, systemPrompts: { ...sp, enabled } };
        savePlugins(updated);
        return updated;
      });
    },
    [savePlugins]
  );

  const addSystemPrompt = useCallback(() => {
    setCustomPlugins((prev) => {
      const sp = prev.systemPrompts || { enabled: false, prompts: [] };
      const prompts = [
        ...(sp.prompts || []),
        {
          id: `sp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          name: `Prompt ${(sp.prompts?.length || 0) + 1}`,
          text: "",
          models: [],
          enabled: true,
        },
      ];
      const updated = { ...prev, systemPrompts: { ...sp, enabled: true, prompts } };
      savePlugins(updated);
      return updated;
    });
  }, [savePlugins]);

  const updateSystemPrompt = useCallback((id, patch) => {
    setCustomPlugins((prev) => {
      const sp = prev.systemPrompts || { enabled: false, prompts: [] };
      let prompts = (sp.prompts || []).map((p) => (p.id === id ? { ...p, ...patch } : p));
      // 1 model → 1 prompt: if this prompt's models overlap another prompt, steal them.
      if (Array.isArray(patch.models)) {
        const mine = new Set(patch.models);
        prompts = prompts.map((p) =>
          p.id === id ? p : { ...p, models: (p.models || []).filter((m) => !mine.has(m)) }
        );
      }
      const updated = { ...prev, systemPrompts: { ...sp, prompts } };
      savePlugins(updated);
      return updated;
    });
  }, [savePlugins]);

  const removeSystemPrompt = useCallback((id) => {
    setCustomPlugins((prev) => {
      const sp = prev.systemPrompts || { enabled: false, prompts: [] };
      const prompts = (sp.prompts || []).filter((p) => p.id !== id);
      const updated = { ...prev, systemPrompts: { ...sp, prompts } };
      savePlugins(updated);
      return updated;
    });
  }, [savePlugins]);

  const activePickerConfig = PLUGINS.find((p) => p.key === pickerPlugin);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-text-main">Custom Plugins</h1>
        <p className="text-sm text-text-muted mt-1">
          Extend model capabilities with plugins
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {/* ---- Custom System Prompt card (multi-prompt) ---- */}
        <Card className="flex flex-col h-full md:col-span-2 lg:col-span-1">
          <div className="flex items-start justify-between gap-4 mb-3">
            <div className="flex items-center gap-3">
              <div className="size-10 rounded-xl flex items-center justify-center border shrink-0 bg-violet-500/10 border-violet-500/20">
                <span className="material-symbols-outlined text-[22px] leading-none text-violet-500">
                  description
                </span>
              </div>
              <h3 className="font-semibold text-base text-text-main">
                Custom System Prompt
              </h3>
            </div>
            <Toggle
              checked={Boolean(customPlugins.systemPrompts?.enabled)}
              onChange={handleToggleSystemPrompts}
            />
          </div>

          <p className="text-sm text-text-muted leading-relaxed mb-5">
            Inject your own system prompt into selected models. Add multiple
            prompts; each prompt can target one or more models, but each model
            can only have one system prompt.
          </p>

          {Boolean(customPlugins.systemPrompts?.enabled) && (
            <div className="mt-auto pt-4 border-t border-border-subtle space-y-3">
              {(customPlugins.systemPrompts?.prompts || []).map((sp) => (
                <div
                  key={sp.id}
                  className="p-3 rounded-xl border border-border-subtle bg-surface-2/30 space-y-2"
                >
                  <div className="flex items-center gap-2">
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
                    rows={4}
                    className="w-full px-2 py-1.5 rounded-lg bg-surface-1 border border-border-subtle text-xs text-text-main font-mono resize-y focus:outline-none focus:border-violet-500"
                  />
                  <div>
                    <div className="flex items-center justify-between gap-2 mb-2">
                      <span className="text-xs font-semibold text-text-muted uppercase tracking-wider">
                        Models ({sp.models.length})
                      </span>
                      <Button
                        size="sm"
                        variant="secondary"
                        icon="add"
                        onClick={() => setPickerPlugin(`systemPrompt:${sp.id}`)}
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
                </div>
              ))}
              <Button
                size="sm"
                variant="secondary"
                icon="add"
                onClick={addSystemPrompt}
                className="w-full"
              >
                Add System Prompt
              </Button>
            </div>
          )}
        </Card>

        {PLUGINS.map((plugin) => {
          const config = customPlugins[plugin.key] || {
            enabled: false,
            models: [],
          };
          const isEnabled = config.enabled;
          const selectedModels = config.models || [];

          return (
            <Card key={plugin.key} className="flex flex-col h-full">
              <div className="flex items-start justify-between gap-4 mb-3">
                <div className="flex items-center gap-3">
                  <div
                    className={`size-10 rounded-xl flex items-center justify-center border shrink-0 ${plugin.iconBg}`}
                  >
                    <span
                      className={`material-symbols-outlined text-[22px] leading-none ${plugin.iconColor}`}
                    >
                      {plugin.icon}
                    </span>
                  </div>
                  <h3 className="font-semibold text-base text-text-main">
                    {plugin.title}
                  </h3>
                </div>
                <Toggle
                  checked={isEnabled}
                  onChange={(val) => handleToggle(plugin.key, val)}
                />
              </div>

              <p className="text-sm text-text-muted leading-relaxed mb-5">
                {plugin.description}
              </p>

              {isEnabled && (
                <div className="mt-auto pt-4 border-t border-border-subtle">
                  <div className="flex items-center justify-between gap-2 mb-3">
                    <span className="text-xs font-semibold text-text-muted uppercase tracking-wider">
                      Selected Models
                    </span>
                    <Button
                      size="sm"
                      variant="secondary"
                      icon="add"
                      onClick={() => setPickerPlugin(plugin.key)}
                    >
                      Add Models
                    </Button>
                  </div>

                  {selectedModels.length === 0 ? (
                    <div className="p-4 rounded-xl border border-dashed border-border-subtle bg-surface-2/30 text-center">
                      <p className="text-xs text-text-muted">
                        Select models to apply this plugin
                      </p>
                    </div>
                  ) : (
                    <div className="flex flex-wrap gap-2">
                      {selectedModels.map((modelVal) => (
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
                            onClick={() => handleRemoveModel(plugin.key, modelVal)}
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
              )}
            </Card>
          );
        })}
      </div>

      {pickerPlugin && (() => {
        const isSpPicker = pickerPlugin.startsWith("systemPrompt:");
        const spId = isSpPicker ? pickerPlugin.slice("systemPrompt:".length) : null;
        const sp = isSpPicker
          ? (customPlugins.systemPrompts?.prompts || []).find((p) => p.id === spId)
          : null;
        return (
          <ModelSelectModal
            isOpen={Boolean(pickerPlugin)}
            onClose={() => setPickerPlugin(null)}
            onSelect={(m) => {
              const modelVal = typeof m === "string" ? m : m?.value || m?.name || m?.id || "";
              if (!modelVal) return;
              if (isSpPicker) {
                updateSystemPrompt(spId, { models: [...(sp?.models || []), modelVal] });
              } else {
                handleAddModel(pickerPlugin, modelVal);
              }
            }}
            onDeselect={(m) => {
              const modelVal = typeof m === "string" ? m : m?.value || m?.name || m?.id || "";
              if (!modelVal) return;
              if (isSpPicker) {
                updateSystemPrompt(spId, { models: (sp?.models || []).filter((x) => x !== modelVal) });
              } else {
                handleRemoveModel(pickerPlugin, modelVal);
              }
            }}
            activeProviders={activeProviders}
            title={
              isSpPicker
                ? `Select Models - ${sp?.name || "System Prompt"}`
                : `Select Models - ${activePickerConfig?.title || "Plugin"}`
            }
            addedModelValues={
              isSpPicker ? sp?.models || [] : customPlugins[pickerPlugin]?.models || []
            }
            closeOnSelect={false}
          />
        );
      })()}
    </div>
  );
}
