"use client";

import { useState } from "react";
import PropTypes from "prop-types";
import { Button, Modal, ProgressCard } from "@/shared/components";

// Generic "Fetch from /models" button for API-key (and OAuth) providers with a
// live /models catalog on the backend. Same fetch → picker → import flow as
// CompatibleModelsSection, extracted so every non-compatible provider page gets
// it without per-provider handlers. Qoder/Cline keep their bespoke buttons.
export default function ImportModelsButton({ connections, existingIds = [], onImport, label = "Fetch from /models" }) {
  const [importing, setImporting] = useState(false);
  const [fetching, setFetching] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerModels, setPickerModels] = useState([]);
  const [pickerSelected, setPickerSelected] = useState({});
  const [importTotals, setImportTotals] = useState(null);
  const [error, setError] = useState("");

  const existing = new Set(existingIds);
  const canFetch = connections.some((conn) => conn.isActive !== false);
  const selectedIds = pickerModels.filter((id) => pickerSelected[id]);

  const handleFetch = async () => {
    if (fetching || !canFetch) return;
    const activeConnection = connections.find((conn) => conn.isActive !== false);
    setFetching(true);
    setError("");
    try {
      const res = await fetch(`/api/providers/${activeConnection.id}/models`, { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || `Failed to fetch models (${res.status})`);
        return;
      }
      const models = (data.models || [])
        .map((m) => m.id || m.name || m.model)
        .filter(Boolean)
        .filter((id, index, list) => list.indexOf(id) === index);
      if (models.length === 0) {
        setError("No models returned from /models.");
        return;
      }
      setPickerModels(models);
      setPickerSelected(Object.fromEntries(models.map((id) => [id, !existing.has(id)])));
      setPickerOpen(true);
    } catch (e) {
      setError("Error fetching models: " + e.message);
    } finally {
      setFetching(false);
    }
  };

  const togglePickerModel = (id) => {
    setPickerSelected((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const toggleSelectAll = () => {
    const allSelected = pickerModels.length > 0 && pickerModels.every((id) => pickerSelected[id]);
    setPickerSelected(Object.fromEntries(pickerModels.map((id) => [id, !allSelected])));
  };

  const handleImportSelected = async () => {
    if (importing || selectedIds.length === 0) return;
    setImporting(true);
    try {
      setImportTotals({ done: 0, total: selectedIds.length });
      let done = 0;
      for (const id of selectedIds) {
        await onImport(id);
        done += 1;
        setImportTotals({ done, total: selectedIds.length });
      }
      setPickerOpen(false);
    } catch (e) {
      setError("Error importing models: " + e.message);
    } finally {
      setImporting(false);
      setImportTotals(null);
    }
  };

  return (
    <>
      <button
        onClick={handleFetch}
        disabled={fetching || !canFetch}
        className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-blue-500/40 px-3 py-2 text-xs text-blue-600 dark:text-blue-400 transition-colors hover:border-blue-500 hover:bg-blue-500/5 sm:w-auto disabled:opacity-50 disabled:cursor-not-allowed"
        title={canFetch ? "Fetch the live /models catalog from this provider" : "Add an active connection first"}
      >
        <span className="material-symbols-outlined text-sm" style={fetching ? { animation: "spin 1s linear infinite" } : undefined}>
          {fetching ? "progress_activity" : "download"}
        </span>
        {fetching ? "Fetching..." : label}
      </button>
      {error && (
        <p className="w-full text-[11px] text-red-500 sm:basis-full">{error}</p>
      )}

      <Modal
        isOpen={pickerOpen}
        onClose={() => setPickerOpen(false)}
        title="Import models from /models"
        size="full"
        footer={
          <>
            <Button variant="ghost" onClick={() => setPickerOpen(false)}>Cancel</Button>
            <Button icon="download" onClick={handleImportSelected} disabled={selectedIds.length === 0 || importing}>
              {importing ? "Importing..." : `Import selected (${selectedIds.length})`}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
            <input
              type="checkbox"
              checked={pickerModels.length > 0 && pickerModels.every((id) => pickerSelected[id])}
              onChange={toggleSelectAll}
              className="accent-[var(--color-primary,#6366f1)] w-4 h-4"
            />
            <span className="font-medium">Select all</span>
            <span className="text-text-muted text-xs">
              {pickerModels.length} models from /models
            </span>
          </label>
          <div className="flex flex-wrap gap-2 border border-border rounded-lg p-3 max-h-[50vh] overflow-y-auto custom-scrollbar">
            {pickerModels.map((id) => {
              const exists = existing.has(id);
              return (
                <label
                  key={id}
                  className={`inline-flex items-center gap-2 px-2.5 py-1.5 rounded-lg border text-sm cursor-pointer select-none transition-colors ${pickerSelected[id] ? "border-primary bg-primary/10 text-text-main" : "border-border hover:bg-sidebar/50 text-text-muted"} ${exists ? "opacity-60" : ""}`}
                >
                  <input
                    type="checkbox"
                    checked={Boolean(pickerSelected[id])}
                    onChange={() => togglePickerModel(id)}
                    className="accent-[var(--color-primary,#6366f1)] w-3.5 h-3.5 shrink-0"
                  />
                  <span className="font-mono truncate max-w-[320px]">{id}</span>
                </label>
              );
            })}
          </div>
        </div>
      </Modal>

      {importing && (
        <ProgressCard
          fixed={false}
          title="Importing models"
          message={
            importTotals && importTotals.total > 0
              ? `${importTotals.done}/${importTotals.total} models`
              : "Fetching model list"
          }
          progress={
            importTotals && importTotals.total > 0
              ? Math.round((importTotals.done / importTotals.total) * 100)
              : null
          }
        />
      )}
    </>
  );
}

ImportModelsButton.propTypes = {
  connections: PropTypes.arrayOf(PropTypes.shape({
    id: PropTypes.string,
    isActive: PropTypes.bool,
  })).isRequired,
  existingIds: PropTypes.arrayOf(PropTypes.string),
  onImport: PropTypes.func.isRequired,
  label: PropTypes.string,
};
