"use client";

import { useState } from "react";
import PropTypes from "prop-types";
import { Button, Modal } from "@/shared/components";
import { getProviderCustomModelRows } from "@/shared/utils/providerCustomModels";
function CompatibleModelRow({ modelId, fullModel, copied, onCopy, onDeleteAlias, onTest, testStatus, isTesting }) {
  const borderColor = testStatus === "ok"
    ? "border-green-500/40"
    : testStatus === "error"
    ? "border-red-500/40"
    : "border-border";

  const iconColor = testStatus === "ok"
    ? "#22c55e"
    : testStatus === "error"
    ? "#ef4444"
    : undefined;

  return (
    <div className={`flex items-center gap-3 p-3 rounded-lg border ${borderColor} hover:bg-sidebar/50`}>
      <span
        className="material-symbols-outlined text-base text-text-muted"
        style={iconColor ? { color: iconColor } : undefined}
      >
        {testStatus === "ok" ? "check_circle" : testStatus === "error" ? "cancel" : "smart_toy"}
      </span>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium truncate">{modelId}</p>
        <div className="flex items-center gap-1 mt-1">
          <code className="text-xs text-text-muted font-mono bg-sidebar px-1.5 py-0.5 rounded">{fullModel}</code>
          <div className="relative group/btn">
            <button
              onClick={() => onCopy(fullModel, `model-${modelId}`)}
              className="p-0.5 hover:bg-sidebar rounded text-text-muted hover:text-primary"
            >
              <span className="material-symbols-outlined text-sm">
                {copied === `model-${modelId}` ? "check" : "content_copy"}
              </span>
            </button>
            <span className="pointer-events-none absolute top-5 left-1/2 -translate-x-1/2 text-[10px] text-text-muted whitespace-nowrap opacity-0 group-hover/btn:opacity-100 transition-opacity">
              {copied === `model-${modelId}` ? "Copied!" : "Copy"}
            </span>
          </div>
          {onTest && (
            <div className="relative group/btn">
              <button
                onClick={onTest}
                disabled={isTesting}
                className="p-0.5 hover:bg-sidebar rounded text-text-muted hover:text-primary transition-colors"
              >
                <span className="material-symbols-outlined text-sm" style={isTesting ? { animation: "spin 1s linear infinite" } : undefined}>
                  {isTesting ? "progress_activity" : "science"}
                </span>
              </button>
              <span className="pointer-events-none absolute top-5 left-1/2 -translate-x-1/2 text-[10px] text-text-muted whitespace-nowrap opacity-0 group-hover/btn:opacity-100 transition-opacity">
                {isTesting ? "Testing..." : "Test"}
              </span>
            </div>
          )}
        </div>
      </div>
      <button
        onClick={onDeleteAlias}
        className="p-1 hover:bg-red-50 rounded text-red-500"
        title="Remove model"
      >
        <span className="material-symbols-outlined text-sm">delete</span>
      </button>
    </div>
  );
}

export default function CompatibleModelsSection({ providerStorageAlias, providerDisplayAlias, modelAliases, customModels, copied, onCopy, onDeleteAlias, onAddCustomModel, onDeleteCustomModel, connections, isAnthropic }) {
  const [newModel, setNewModel] = useState("");
  const [adding, setAdding] = useState(false);
  const [importing, setImporting] = useState(false);
  const [testingModelId, setTestingModelId] = useState(null);
  const [modelTestResults, setModelTestResults] = useState({});

  const handleTestModel = async (modelId) => {
    if (testingModelId) return;
    setTestingModelId(modelId);
    try {
      const res = await fetch("/api/models/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: `${providerStorageAlias}/${modelId}` }),
      });
      const data = await res.json();
      setModelTestResults((prev) => ({ ...prev, [modelId]: data.ok ? "ok" : "error" }));
    } catch {
      setModelTestResults((prev) => ({ ...prev, [modelId]: "error" }));
    } finally {
      setTestingModelId(null);
    }
  };

  const allModels = getProviderCustomModelRows({
    customModels,
    modelAliases,
    providerAlias: providerStorageAlias,
    type: "llm",
  });

  const handleAdd = async () => {
    if (!newModel.trim() || adding) return;
    const modelId = newModel.trim();
    if (allModels.some((model) => model.id === modelId)) {
      alert("Model already exists for this provider.");
      return;
    }

    setAdding(true);
    try {
      await onAddCustomModel(modelId);
      setNewModel("");
    } catch (error) {
      console.log("Error adding model:", error);
    } finally {
      setAdding(false);
    }
  };

  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerModels, setPickerModels] = useState([]);
  const [pickerSelected, setPickerSelected] = useState({});

  const handleImport = async () => {
    if (importing) return;
    const activeConnection = connections.find((conn) => conn.isActive !== false);
    if (!activeConnection) return;

    setImporting(true);
    try {
      const res = await fetch(`/api/providers/${activeConnection.id}/models`);
      const data = await res.json();
      if (!res.ok) {
        alert(data.error || "Failed to fetch models");
        return;
      }
      const models = (data.models || [])
        .map((model) => model.id || model.name || model.model)
        .filter(Boolean)
        .filter((modelId, index, list) => list.indexOf(modelId) === index);
      if (models.length === 0) {
        alert("No models returned from /models.");
        return;
      }
      setPickerModels(models);
      // Pre-select everything that isn't already added for this provider.
      setPickerSelected(Object.fromEntries(models.map((modelId) => [modelId, !allModels.some((entry) => entry.id === modelId)])));
      setPickerOpen(true);
    } catch (error) {
      console.log("Error fetching models:", error);
      alert("Error fetching models: " + error.message);
    } finally {
      setImporting(false);
    }
  };

  const pickerSelectedIds = pickerModels.filter((modelId) => pickerSelected[modelId]);

  const togglePickerModel = (modelId) => {
    setPickerSelected((prev) => ({ ...prev, [modelId]: !prev[modelId] }));
  };

  const toggleSelectAll = () => {
    const allSelected = pickerModels.every((modelId) => pickerSelected[modelId]);
    setPickerSelected(Object.fromEntries(pickerModels.map((modelId) => [modelId, !allSelected])));
  };

  const handleImportSelected = async () => {
    if (adding || pickerSelectedIds.length === 0) return;
    setAdding(true);
    try {
      for (const modelId of pickerSelectedIds) {
        await onAddCustomModel(modelId);
      }
      setPickerOpen(false);
    } catch (error) {
      console.log("Error importing models:", error);
      alert("Error importing models: " + error.message);
    } finally {
      setAdding(false);
    }
  };

  const canImport = connections.some((conn) => conn.isActive !== false);

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-text-muted">
        Add {isAnthropic ? "Anthropic" : "OpenAI"}-compatible models manually or import them from the /models endpoint.
      </p>

      <div className="flex items-end gap-2 flex-wrap">
        <div className="flex-1 min-w-[240px]">
          <label htmlFor="new-compatible-model-input" className="text-xs text-text-muted mb-1 block">Model ID</label>
          <input
            id="new-compatible-model-input"
            type="text"
            value={newModel}
            onChange={(e) => setNewModel(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleAdd()}
            placeholder={isAnthropic ? "claude-3-opus-20240229" : "gpt-4o"}
            className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-background focus:outline-none focus:border-primary"
          />
        </div>
        <Button size="sm" icon="add" onClick={handleAdd} disabled={!newModel.trim() || adding}>
          {adding ? "Adding..." : "Add"}
        </Button>
        <Button size="sm" variant="secondary" icon="download" onClick={handleImport} disabled={!canImport || importing}>
          {importing ? "Importing..." : "Import from /models"}
        </Button>
      </div>

      {!canImport && (
        <p className="text-xs text-text-muted">
          Add a connection to enable importing models.
        </p>
      )}

      <Modal
        isOpen={pickerOpen}
        onClose={() => setPickerOpen(false)}
        title="Import models from /models"
        size="full"
        footer={
          <>
            <Button variant="ghost" onClick={() => setPickerOpen(false)}>Cancel</Button>
            <Button icon="download" onClick={handleImportSelected} disabled={pickerSelectedIds.length === 0 || adding}>
              {adding ? "Importing..." : `Import selected (${pickerSelectedIds.length})`}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
            <input
              type="checkbox"
              checked={pickerModels.length > 0 && pickerModels.every((modelId) => pickerSelected[modelId])}
              onChange={toggleSelectAll}
              className="accent-[var(--color-primary,#6366f1)] w-4 h-4"
            />
            <span className="font-medium">Select all</span>
            <span className="text-text-muted text-xs">
              {pickerModels.length} models from /models
            </span>
          </label>
          <div className="flex flex-wrap gap-2 border border-border rounded-lg p-3 max-h-[50vh] overflow-y-auto custom-scrollbar">
            {pickerModels.map((modelId) => {
              const exists = allModels.some((entry) => entry.id === modelId);
              return (
                <label
                  key={modelId}
                  className={`inline-flex items-center gap-2 px-2.5 py-1.5 rounded-lg border text-sm cursor-pointer select-none transition-colors ${pickerSelected[modelId] ? "border-primary bg-primary/10 text-text-main" : "border-border hover:bg-sidebar/50 text-text-muted"} ${exists ? "opacity-60" : ""}`}
                >
                  <input
                    type="checkbox"
                    checked={Boolean(pickerSelected[modelId])}
                    onChange={() => togglePickerModel(modelId)}
                    className="accent-[var(--color-primary,#6366f1)] w-3.5 h-3.5 shrink-0"
                  />
                  <span className="font-mono truncate max-w-[320px]">{modelId}</span>
                </label>
              );
            })}
          </div>
        </div>
      </Modal>

      {allModels.length > 0 && (
        <div className="flex flex-col gap-3">
          {allModels.map(({ id, alias, source }) => (
            <CompatibleModelRow
              key={`${source}-${providerStorageAlias}/${id}`}
              modelId={id}
              fullModel={`${providerDisplayAlias}/${id}`}
              copied={copied}
              onCopy={onCopy}
              onDeleteAlias={() => source === "custom" ? onDeleteCustomModel(id) : onDeleteAlias(alias)}
              onTest={connections.length > 0 ? () => handleTestModel(id) : undefined}
              testStatus={modelTestResults[id]}
              isTesting={testingModelId === id}
            />
          ))}
        </div>
      )}
    </div>
  );
}

CompatibleModelsSection.propTypes = {
  providerStorageAlias: PropTypes.string.isRequired,
  providerDisplayAlias: PropTypes.string.isRequired,
  modelAliases: PropTypes.object.isRequired,
  customModels: PropTypes.arrayOf(PropTypes.object),
  copied: PropTypes.string,
  onCopy: PropTypes.func.isRequired,
  onDeleteAlias: PropTypes.func.isRequired,
  onAddCustomModel: PropTypes.func.isRequired,
  onDeleteCustomModel: PropTypes.func.isRequired,
  connections: PropTypes.arrayOf(PropTypes.shape({
    id: PropTypes.string,
    isActive: PropTypes.bool,
  })).isRequired,
  isAnthropic: PropTypes.bool,
};
