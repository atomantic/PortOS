import { createHash } from 'node:crypto';

/**
 * Static contract for PortOS's model-abuse boundary.
 *
 * This is intentionally not part of the local chat-model catalog. Prompt Guard
 * is a dedicated text classifier: it is installed from one pinned Hugging Face
 * revision and executed by a separate offline Python runner. It is never sent
 * a PortOS tool definition and it is never selected as a normal chat provider.
 */

export const MODEL_ABUSE_GUARD_ID = 'llama-prompt-guard-2-86m';

export const MODEL_ABUSE_GUARD = Object.freeze({
  id: MODEL_ABUSE_GUARD_ID,
  name: 'Llama Prompt Guard 2 86M',
  repository: 'meta-llama/Llama-Prompt-Guard-2-86M',
  revision: 'a8ded8e697ce7c355e395a0df51f94adb4a2fd27',
  pipelineTag: 'text-classification',
  runtime: 'python-transformers',
  params: '86M',
  contextTokens: 512,
  gated: true,
  capabilities: ['classification', 'prompt-injection-detection'],
  sourceUrl: 'https://huggingface.co/meta-llama/Llama-Prompt-Guard-2-86M',
  featured: {
    label: 'Recommended for model-abuse scanning',
    description: 'Dedicated local classifier with no chat, agent, tool, or MCP loop.'
  }
});

// Only these files are downloaded. The scanner never executes arbitrary
// repository Python or accepts a model directory from a request.
export const MODEL_ABUSE_GUARD_REQUIRED_FILES = Object.freeze([
  'config.json',
  'model.safetensors',
  'special_tokens_map.json',
  'tokenizer.json',
  'tokenizer_config.json'
]);

// The public-review model must be a text model with an explicit capability
// report and no native tool-calling capability. Keep this vocabulary here so
// the execution-time gate and its tests do not reimplement the policy beside
// the classifier contract.
export const MODEL_ABUSE_GUARD_TEXT_CAPABILITIES = Object.freeze(['chat', 'completion']);

/**
 * Fail-closed capability check for the downstream code-review model.
 *
 * An absent or empty capability list means "not measured", not "safe". The
 * caller must supply the backend's authoritative vocabulary (`chat` for
 * normalized catalog rows or `completion` from Ollama `/api/show`).
 */
export function hasToolFreeTextCapability(capabilities) {
  if (!Array.isArray(capabilities) || capabilities.length === 0) return false;
  const normalized = capabilities.map((capability) => String(capability).toLowerCase());
  return normalized.some((capability) => MODEL_ABUSE_GUARD_TEXT_CAPABILITIES.includes(capability))
    && !normalized.includes('tools');
}

// These are fixed package import names, not user-controlled pip arguments.
export const MODEL_ABUSE_GUARD_PYTHON_IMPORTS = Object.freeze([
  'torch',
  'transformers',
  'safetensors',
  'huggingface_hub'
]);

// Read the complete supplied item up to this bound. Never truncate and then
// treat the prefix as a trustworthy verdict.
export const MODEL_ABUSE_GUARD_MAX_INPUT_CHARS = 2_000_000;
// Compact chunk metadata is still proportional to the number of windows. Keep
// the bound above the worst case for a complete 2M-character scan so a valid
// long input cannot be mistaken for a failed/partial verdict.
export const MODEL_ABUSE_GUARD_MAX_OUTPUT_CHARS = 2_000_000;
export const MODEL_ABUSE_GUARD_MAX_CHUNKS = 100_000;
export const MODEL_ABUSE_GUARD_MIN_BENIGN_SCORE = 0.9;
export const MODEL_ABUSE_GUARD_TIMEOUT_MS = 5 * 60 * 1000;
export const MODEL_ABUSE_GUARD_CHUNK_TOKENS = 512;
export const MODEL_ABUSE_GUARD_CHUNK_OVERLAP = 64;

/**
 * Serialize cleared public-review material for the no-tools code-review
 * stage. The JSON is supplied as data in the user message; it is not a path
 * for the reviewer to resolve and it never includes flagged PRs.
 */
export function formatPublicReviewInputPrompt(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return null;
  return [
    '<cleared-public-review-input>',
    JSON.stringify(snapshot),
    '</cleared-public-review-input>',
  ].join('\n');
}

/**
 * Fingerprint the exact public content that crossed the abuse boundary. This
 * belongs beside the scanner contract so every caller uses the same identity
 * and cannot accidentally downgrade freshness to a commit-SHA-only check.
 */
export function modelAbuseContentFingerprint(kind, identity, content) {
  if (
    typeof kind !== 'string' || !kind
    || !identity || typeof identity !== 'object' || Array.isArray(identity)
    || typeof content !== 'string'
  ) return null;
  return createHash('sha256')
    .update(JSON.stringify({ kind, ...identity }))
    .update('\u0000')
    .update(content)
    .digest('hex');
}

const blockingFinding = (category, reason) => ({
  severity: 'blocking',
  category,
  location: 'external-content',
  reason
});

const hasModelTarget = (value) => /\b(?:agent|assistant|model|prompt|review(?:er)?|llm|ai)\b/i.test(value);

/**
 * High-confidence, content-only checks that run before the classifier. These
 * checks deliberately return generic explanations and never quote the source
 * text, so a finding cannot become another injection channel when displayed.
 */
export function detectDeterministicModelAbuseSignals(value) {
  if (typeof value !== 'string' || !value) return [];
  const findings = [];
  const add = (category, reason) => {
    if (!findings.some((finding) => finding.category === category)) {
      findings.push(blockingFinding(category, reason));
    }
  };

  if (
    /\b(?:ignore|disregard|forget|override|bypass|disobey|replace)\b.{0,100}\b(?:previous|prior|above|system|developer|reviewer|safety|security|instructions?|rules?|prompt)\b/i.test(value)
    || /\b(?:system|developer|reviewer)\s+(?:prompt|instructions?)\b.{0,100}\b(?:ignore|override|replace|bypass)\b/i.test(value)
  ) {
    add('instruction-override', 'Content attempts to override or replace instructions used by a downstream model.');
  }

  const hasDownload = /\b(?:curl|wget|fetch|invoke-webrequest|certutil|bitsadmin|powershell\s+-c)\b/i.test(value);
  const hasExecution = /\b(?:bash|sh|zsh|powershell|cmd(?:\.exe)?|python(?:3)?|node|chmod\s+\+x|execute|run|install)\b/i.test(value);
  if (hasDownload && hasExecution) {
    add('download-execute', 'Content combines a remote-download mechanism with instructions to execute or install the result.');
  }

  const hasExfiltration = /\b(?:exfiltrat|upload|send|post|forward|publish|leak|transmit)\w*\b/i.test(value);
  const hasSecretTarget = /\b(?:secret|credential|token|password|private\s+key|ssh\s+key|api\s+key|environment|env(?:ironment)?\s+var|cookie|personal\s+data)\b/i.test(value);
  if (hasExfiltration && hasSecretTarget) {
    add('secret-exfiltration', 'Content asks a downstream model to disclose or transmit credentials, private data, or environment values.');
  }

  if (
    /\b(?:reveal|print|dump|show|disclose|leak|repeat|quote)\w*\b.{0,100}\b(?:system\s+prompt|developer\s+prompt|hidden\s+instructions?|credentials?|secrets?|environment|private\s+files?)\b/i.test(value)
    || /\b(?:system\s+prompt|developer\s+prompt|hidden\s+instructions?)\b.{0,100}\b(?:reveal|print|dump|show|disclose|leak)\w*\b/i.test(value)
  ) {
    add('context-disclosure', 'Content attempts to extract private prompts, context, credentials, or local data from a downstream model.');
  }

  if (
    /\b(?:base64|base\s*64|hex(?:adecimal)?|rot\s*13|encoded?|decode|decrypt|obfuscat(?:e|ed|ion)|payload)\b/i.test(value)
    && (hasModelTarget(value) || /\b(?:instruction|command|script|prompt)\w*\b/i.test(value))
  ) {
    add('encoded-instruction', 'Content contains an encoded or obfuscated instruction or payload that must not reach a downstream model unchecked.');
  }

  if (
    /[\u200B-\u200D\u2060\uFEFF]/u.test(value)
    && (hasModelTarget(value) || /\b(?:instruction|command|script|payload)\w*\b/i.test(value))
  ) {
    add('hidden-unicode', 'Content contains invisible Unicode alongside model-directed or executable content.');
  }

  if (
    /\b(?:approve|approval|merge|request\s+changes|comment|label|review)\w*\b.{0,100}\b(?:automatically|without\s+(?:review|approval)|skip|bypass|force|ignore)\b/i.test(value)
    && hasModelTarget(value)
  ) {
    add('reviewer-control', 'Content attempts to control a downstream review, approval, comment, label, or merge decision.');
  }

  return findings.slice(0, 8);
}

function normalizeLabel(label) {
  if (typeof label !== 'string') return null;
  const normalized = label.trim().toUpperCase();
  if (normalized === 'BENIGN' || normalized === 'LABEL_0') return 'benign';
  if (normalized === 'MALICIOUS' || normalized === 'LABEL_1') return 'malicious';
  return null;
}

/**
 * Validate the small, machine-generated classifier envelope. No prose or
 * source excerpts are accepted. An unknown label, missing chunk, low score, or
 * contradictory result is explicitly inconclusive and must fail closed.
 */
export function normalizeModelAbuseGuardResult(raw, { minBenignScore = MODEL_ABUSE_GUARD_MIN_BENIGN_SCORE } = {}) {
  const chunks = raw?.chunks;
  if (!Array.isArray(chunks) || chunks.length < 1 || chunks.length > MODEL_ABUSE_GUARD_MAX_CHUNKS) {
    return { ok: false, code: 'security-guard-verdict-invalid' };
  }

  const normalized = [];
  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    const label = normalizeLabel(chunk?.label);
    const score = Number(chunk?.score);
    if (
      !chunk || typeof chunk !== 'object' || Array.isArray(chunk)
      || chunk.index !== index
      || !label || !Number.isFinite(score) || score < 0 || score > 1
      || !Number.isInteger(chunk.tokenStart) || chunk.tokenStart < 0
      || !Number.isInteger(chunk.tokenEnd) || chunk.tokenEnd <= chunk.tokenStart
    ) {
      return { ok: false, code: 'security-guard-verdict-invalid' };
    }
    normalized.push({
      index,
      label,
      score,
      tokenStart: chunk.tokenStart,
      tokenEnd: chunk.tokenEnd
    });
  }

  const malicious = normalized.filter((chunk) => chunk.label === 'malicious');
  if (malicious.length > 0) {
    return {
      ok: true,
      safe: false,
      code: 'security-guard-classified-malicious',
      findings: [blockingFinding('prompt-classifier', 'The dedicated model-abuse classifier marked one or more complete content windows as malicious.')],
      chunkCount: normalized.length,
      minBenignScore: null
    };
  }

  const minScore = Math.min(...normalized.map((chunk) => chunk.score));
  if (!Number.isFinite(minBenignScore) || minBenignScore < 0 || minBenignScore > 1 || minScore < minBenignScore) {
    return {
      ok: true,
      safe: false,
      code: 'security-guard-low-confidence',
      findings: [blockingFinding('prompt-classifier-confidence', 'The dedicated model-abuse classifier did not clear every content window at the required confidence threshold.')],
      chunkCount: normalized.length,
      minBenignScore: minScore
    };
  }

  return {
    ok: true,
    safe: true,
    code: 'security-guard-passed',
    findings: [],
    chunkCount: normalized.length,
    minBenignScore: minScore
  };
}
