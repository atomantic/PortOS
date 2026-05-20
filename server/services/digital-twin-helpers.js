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
