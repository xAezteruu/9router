export const SYSTEM_MODELS = [
  { id: "9router/auto", name: "Auto Router (Best Available)", provider: "system" },
];

export const PLUGIN_ICONS = {
  adaptiveThinking: "psychology",
  imageVision: "image",
  thinkDeeper: "neurology",
  unrestrictedMode: "lock_open",
  speedMode: "bolt",
  jsonGuard: "data_object",
  openaiToolBridge: "build",
  antiSlop: "filter_alt",
};

export const PLUGIN_MARK_META = {
  adaptiveThinking: {
    label: "Adaptive",
    desc: "Adaptive Thinking: Model automatically decides whether and how much to think based on task complexity",
  },
  imageVision: {
    label: "OCR Image",
    desc: "OCR Auto Image-to-Text: Transcribes and extracts text from attached images, allowing text-only models to process images",
  },
  thinkDeeper: { label: "Think Deeper", desc: "Forces extended reasoning budget on selected models" },
  unrestrictedMode: { label: "Unrestricted", desc: "Uncensored output mode: injects anti-refusal system prompt and framing" },
  speedMode: { label: "Speed", desc: "Speed mode: minimal reasoning overhead for latency-sensitive routes" },
  jsonGuard: { label: "JSON Guard", desc: "Guarantees machine-readable JSON output by filling response_format and stripping prose" },
  openaiToolBridge: {
    label: "Tool Calling",
    desc: "Tool Calling Bridge: Folds the request's tools into the prompt and parses the model's own call back into standard tool_calls, giving function calling to upstreams that have none",
  },
  antiSlop: { label: "Anti-Slop", desc: "Strips slop patterns from responses" },
};
