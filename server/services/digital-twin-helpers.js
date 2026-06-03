import { v4 as uuidv4 } from '../lib/uuid.js';
import { existsSync } from 'fs';
import { ensureDir, PATHS, safeJSONParse } from '../lib/fileUtils.js';
import { runPromptThroughProvider } from '../lib/promptRunner.js';

export const DIGITAL_TWIN_DIR = PATHS.digitalTwin;

export function generateId() {
  return uuidv4();
}

export function now() {
  return new Date().toISOString();
}

/**
 * Extract and parse the first JSON block from an AI response string.
 * Tries ```json fences first, then bare-object/array fallback.
 * Returns the parsed value or null.
 */
export function extractJSON(response, context = 'response') {
  const fenceMatch = response.match(/```json\s*([\s\S]*?)\s*```/);
  if (fenceMatch) {
    const parsed = safeJSONParse(fenceMatch[1], null, { logError: true, context });
    if (parsed) return parsed;
  }
  const trimmed = response.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    return safeJSONParse(trimmed, null, { logError: true, context: `${context} fallback` });
  }
  return null;
}

/**
 * Parse a JSON-ish scorer response into { result, reasoning }. Tolerates both
 * `"result": "x"` and `result: x` shapes. `verdicts` lists the recognized
 * result tokens in priority order (first match wins); anything unrecognized
 * falls back to `fallback`. Shared by the behavioral and values-alignment
 * test scorers.
 */
export function parseScorerVerdict(response, verdicts, fallback = 'partial') {
  let result = fallback;
  for (const v of verdicts) {
    // Anchor on `result:` so a verdict word appearing inside the reasoning
    // doesn't false-match, but tolerate the whitespace/quote variations LLMs
    // actually emit — `"result": "held"`, `"result":"held"`, `result: held`,
    // pretty-printed or compact JSON all parse the same.
    if (new RegExp(`result"?\\s*:\\s*"?${v}\\b`, 'i').test(response)) {
      result = v;
      break;
    }
  }
  const reasoningMatch = response.match(/"reasoning":\s*"([^"]+)"/);
  const reasoning = reasoningMatch ? reasoningMatch[1] : response.substring(0, 200);
  return { result, reasoning };
}

/**
 * Parse a markdown bullet list (`- item` / `* item`) into a trimmed string
 * array, dropping blanks. Shared by the values-alignment and adversarial-
 * boundary suite parsers (the "Values at Stake" / "Boundary Tested" blocks).
 */
export function parseBulletList(block) {
  return (block || '')
    .split('\n')
    .map(line => line.replace(/^[-*]\s*/, '').trim())
    .filter(Boolean);
}

/**
 * Resolve a persona id (as passed to a test runner) into the fields stamped on
 * a test-history entry, so a run can be attributed to the persona it embodied.
 * Returns `{}` when no persona id is given or it doesn't match a stored persona
 * — leaving the history entry persona-free (the base-twin run). `personas` is
 * `meta.personas`; mirrors how `resolvePersona` in digital-twin-context.js maps
 * an id to a persona for the prompt itself.
 */
export function resolveTestPersona(personas, personaId) {
  if (!personaId) return {};
  const list = Array.isArray(personas) ? personas : [];
  const persona = list.find(p => p.id === personaId);
  if (!persona) return {};
  return { personaId: persona.id, personaName: persona.name };
}

/**
 * Ensure a document entry exists in meta.documents. If absent, push it.
 * Mutates meta in place; caller must saveMeta() after.
 */
export function ensureDocumentInMeta(meta, filename, title, category, { enabled = true, priority = 30 } = {}) {
  if (!meta.documents.find(d => d.filename === filename)) {
    meta.documents.push({ id: generateId(), filename, title, category, enabled, priority });
  }
}

export async function ensureSoulDir() {
  if (!existsSync(DIGITAL_TWIN_DIR)) {
    await ensureDir(DIGITAL_TWIN_DIR);
    console.log(`🧬 Created soul data directory: ${DIGITAL_TWIN_DIR}`);
  }
}

/**
 * Call any AI provider (CLI / API / TUI) with a prompt and return the response text.
 *
 * Dispatches through the shared `runPromptThroughProvider` so TUI providers
 * (claude-code, etc.) no longer fall into the legacy CLI spawn branch — that
 * branch piped raw stdin into a process that wanted an interactive PTY and
 * either hung or echoed banner chrome into the captured output. The shared
 * runner picks the right transport per provider type and strips TUI chrome
 * before returning the cleaned response.
 *
 * Returns `{ text }` on success, `{ error }` on failure — preserved from the
 * legacy shape so the parse-and-fallback patterns in callers keep working.
 */
export async function callProviderAI(provider, model, prompt) {
  return runPromptThroughProvider({
    provider,
    prompt,
    model,
    source: 'digital-twin',
  }).then(({ text }) => ({ text: text || '' }))
    .catch((err) => ({ error: err?.message || 'AI request failed' }));
}
