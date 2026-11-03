"use client";

import { useState, useEffect } from "react";
import PropTypes from "prop-types";
import ProviderLogoField from "@/shared/components/ProviderLogoField";
import { Badge, Button, Input, Modal, Select } from "@/shared/components";
import { planBulkAdd } from "@/shared/utils/bulkAdd";
import { useTaskStore } from "@/store/taskStore";


const VARIANT_CONFIG = {
  openai: {
    title: "Add OpenAI Compatible",
    type: "openai-compatible",
    defaultBaseUrl: "https://api.openai.com/v1",
    namePlaceholder: "OpenAI Compatible (Prod)",
    prefixPlaceholder: "oc-prod",
    baseUrlHint: "Use the base URL (ending in /v1) for your OpenAI-compatible API.",
    modelIdPlaceholder: "e.g. gpt-4, claude-3-opus",
    errorLabel: "OpenAI Compatible",
    hasApiType: true,
  },
  anthropic: {
    title: "Add Anthropic Compatible",
    type: "anthropic-compatible",
    defaultBaseUrl: "https://api.anthropic.com/v1",
    namePlaceholder: "Anthropic Compatible (Prod)",
    prefixPlaceholder: "ac-prod",
    baseUrlHint: "Use the base URL (ending in /v1) for your Anthropic-compatible API. The system will append /messages.",
    modelIdPlaceholder: "e.g. claude-3-opus",
    errorLabel: "Anthropic Compatible",
    hasApiType: false,
  },
  moonshot: {
    title: "Add MoonshotAI Compatible",
    type: "openai-compatible",
    defaultBaseUrl: "https://api.moonshot.ai/v1",
    namePlaceholder: "MoonshotAI Compatible (Prod)",
    prefixPlaceholder: "mk-prod",
    baseUrlHint: "Use the base URL (ending in /v1) for your MoonshotAI (Kimi) OpenAI-compatible API. Docs: platform.kimi.ai",
    modelIdPlaceholder: "e.g. kimi-k2.6, moonshot-v1-8k",
    errorLabel: "MoonshotAI Compatible",
    hasApiType: true,
  },
};

const API_TYPE_OPTIONS = [
  { value: "chat", label: "Chat Completions" },
  { value: "responses", label: "Responses API" },
];

function AddCompatibleModal({ variant, isOpen, onClose, onCreated }) {
  const config = VARIANT_CONFIG[variant];
  const initialFormData = () => ({
    name: "",
    prefix: "",
    ...(config.hasApiType ? { apiType: "chat" } : {}),
    baseUrl: config.defaultBaseUrl,
    logo: "",
  });

  const [formData, setFormData] = useState(initialFormData);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState("");
  // Keys saved with the node. One per line: "name|key" names the connection,
  // a bare key is auto-named. Single key = one line; multi = many lines.
  const [keysText, setKeysText] = useState("");
  const [keysResult, setKeysResult] = useState(null); // { added, failed }
  const [checkModelId, setCheckModelId] = useState("");
  const [validating, setValidating] = useState(false);
  const [validationResult, setValidationResult] = useState(null);

  const keyLines = keysText.split("\n").map((l) => l.trim()).filter(Boolean);
  const firstKey = keyLines[0] || "";

  // openai: reset baseUrl when apiType changes; anthropic: reset checks when opened
  useEffect(() => {
    if (config.hasApiType) {
      setFormData((prev) => ({ ...prev, baseUrl: config.defaultBaseUrl }));
    } else if (isOpen) {
      setValidationResult(null);
      setKeysText("");
      setKeysResult(null);
      setCheckModelId("");
    }
  }, [config.hasApiType ? formData.apiType : isOpen]);

  const handleSubmit = async () => {
    if (!formData.name.trim() || !formData.prefix.trim() || !formData.baseUrl.trim()) return;
    setSubmitting(true);
    setFormError("");
    setKeysResult(null);
    try {
      const res = await fetch("/api/provider-nodes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: formData.name,
          prefix: formData.prefix,
          ...(config.hasApiType ? { apiType: formData.apiType } : {}),
          baseUrl: formData.baseUrl,
          type: config.type,
          brand: variant || undefined,
          logo: formData.logo,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setFormError(data?.error || `Failed to create ${config.errorLabel} node`);
        return;
      }
      const node = data.node;

      // Save pasted keys as connections on the new node so the node is
      // usable immediately - no separate trip to the node page needed.
      // Progress/results go to the task bell (AddCompatibleModal closes on
      // onCreated below, so inline results would never be seen).
      if (keyLines.length) {
        const taskId = `add-node-keys-${node.id}`;
        // Fresh node has no existing connection names; planBulkAdd keeps
        // explicit names from "name|key" lines and auto-names bare keys.
        const plan = planBulkAdd(keyLines, [], {});
        useTaskStore.getState().start({
          id: taskId,
          title: `Adding keys to ${node.name || formData.prefix}`,
          message: `0/${plan.length} keys`,
          progress: 0,
          href: typeof window !== "undefined" ? window.location.pathname : null,
        });
        let added = 0;
        let failed = 0;
        let processed = 0;
        for (const entry of plan) {
          try {
            // Validate before saving so new connections get a real status
            // instead of "unknown" that never flips until a manual test.
            let testStatus = "unknown";
            try {
              const vres = await fetch("/api/providers/validate", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ provider: node.id, apiKey: entry.apiKey }),
              });
              const vdata = await vres.json().catch(() => ({}));
              if (vdata.valid) testStatus = "active";
            } catch { /* keep unknown */ }
            const cres = await fetch("/api/providers", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                provider: node.id,
                apiKey: entry.apiKey,
                name: entry.name,
                priority: 1,
                testStatus,
              }),
            });
            if (cres.ok) added++;
            else failed++;
          } catch {
            failed++;
          }
          processed += 1;
          useTaskStore.getState().update(taskId, {
            message: `${processed}/${plan.length} keys`,
            progress: Math.round((processed / plan.length) * 100),
          });
        }
        useTaskStore.getState().finish(taskId);
        setKeysResult({ added, failed });
      }

      onCreated(node);
      setFormData(initialFormData());
      setKeysText("");
      setValidationResult(null);
    } catch (error) {
      console.log(`Error creating ${config.errorLabel} node:`, error);
      setFormError("Network error");
    } finally {
      setSubmitting(false);
    }
  };

  const handleValidate = async () => {
    setValidating(true);
    try {
      const res = await fetch("/api/provider-nodes/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          baseUrl: formData.baseUrl,
          apiKey: firstKey,
          type: config.type,
          modelId: checkModelId.trim() || undefined,
        }),
      });
      const data = await res.json();
      setValidationResult(data);
    } catch {
      setValidationResult({ valid: false, error: "Network error" });
    } finally {
      setValidating(false);
    }
  };

  const renderValidationResult = () => {
    if (!validationResult) return null;
    const { valid, error, method } = validationResult;
    if (valid) {
      return (
        <>
          <Badge variant="success">Valid</Badge>
          {method === "chat" && (
            <span className="text-sm text-text-muted">(via inference test)</span>
          )}
        </>
      );
    }
    return (
      <div className="flex flex-col gap-1">
        <Badge variant="error">Invalid</Badge>
        {error && <span className="text-sm text-red-500">{error}</span>}
      </div>
    );
  };

  return (
    <Modal isOpen={isOpen} title={config.title} onClose={onClose}>
      <div className="flex flex-col gap-4">
        <ProviderLogoField
          logo={formData.logo}
          onChange={(next) => setFormData({ ...formData, logo: next })}
        />
        <Input
          label="Name"
          value={formData.name}
          onChange={(e) => setFormData({ ...formData, name: e.target.value })}
          placeholder={config.namePlaceholder}
          hint="A friendly label for this node"
        />
        <Input
          label="Prefix"
          value={formData.prefix}
          onChange={(e) => setFormData({ ...formData, prefix: e.target.value })}
          placeholder={config.prefixPlaceholder}
          hint="The provider prefix used in model IDs"
        />
        {config.hasApiType && (
          <Select
            label="API Type"
            options={API_TYPE_OPTIONS}
            value={formData.apiType}
            onChange={(e) => setFormData({ ...formData, apiType: e.target.value })}
          />
        )}
        <Input
          label="Base URL"
          value={formData.baseUrl}
          onChange={(e) => setFormData({ ...formData, baseUrl: e.target.value })}
          placeholder={config.defaultBaseUrl}
          hint={config.baseUrlHint}
        />
        <div className="flex flex-col gap-1">
          <label className="text-sm font-medium text-text-main">API Keys (optional)</label>
          <textarea
            className="w-full rounded border border-accent/30 bg-sidebar p-2 text-sm font-mono resize-y min-h-[90px] focus:outline-none focus:ring-1 focus:ring-primary"
            placeholder={"sk-key1\nname2|sk-key2"}
            value={keysText}
            onChange={(e) => setKeysText(e.target.value)}
            spellCheck={false}
          />
          <p className="text-xs text-text-muted">
            Saved with this node. One key per line, or <code>name|key</code> to name it. Leave
            empty to add keys later on the node page.
          </p>
          {keysResult && (
            <p className={`text-sm font-medium ${keysResult.failed > 0 ? "text-yellow-400" : "text-green-400"}`}>
              {keysResult.added} key{keysResult.added === 1 ? "" : "s"} added
              {keysResult.failed > 0 ? `, ${keysResult.failed} failed` : ""}
            </p>
          )}
        </div>
        <Input
          label="Model ID (optional)"
          value={checkModelId}
          onChange={(e) => setCheckModelId(e.target.value)}
          placeholder={config.modelIdPlaceholder}
          hint="If provider lacks /models endpoint, enter a model ID to validate via chat/completions instead."
        />
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <Button
            onClick={handleValidate}
            disabled={!firstKey || validating || !formData.baseUrl.trim()}
            variant="secondary"
            className="w-full sm:w-auto"
          >
            {validating ? "Checking..." : "Check first key"}
          </Button>
          {renderValidationResult()}
        </div>
        {formError && (
          <p className="text-sm text-red-500">{formError}</p>
        )}
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button
            onClick={handleSubmit}
            fullWidth
            disabled={
              !formData.name.trim() ||
              !formData.prefix.trim() ||
              !formData.baseUrl.trim() ||
              submitting
            }
          >
            {submitting ? "Creating..." : "Create"}
          </Button>
          <Button onClick={onClose} variant="ghost" fullWidth>
            Cancel
          </Button>
        </div>
      </div>
    </Modal>
  );
}

AddCompatibleModal.propTypes = {
  variant: PropTypes.oneOf(["openai", "anthropic", "moonshot"]).isRequired,
  isOpen: PropTypes.bool.isRequired,
  onClose: PropTypes.func.isRequired,
  onCreated: PropTypes.func.isRequired,
};

export default AddCompatibleModal;
