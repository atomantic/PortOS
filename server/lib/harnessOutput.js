/**
 * Parsers for coding-agent harness output: `parseHarnessVersion` extracts a semver from a version
 * banner and `compareHarnessVersions` compares versions null-safely.
 */

// Pure: the service layer hands captured stdout here. Model ids keep the spelling `--model` takes
// (OpenCode's `provider/model` namespace is KEPT). agy and cursor-agent delegate to their existing
// parsers (agy's handles older bare-id rows and drops the `<configured-default>` sentinel).

import { parseAntigravityModelList } from './aiToolkit/internal/antigravity.js';
import { parseCursorModelList } from './aiToolkit/internal/cursor.js';
import { parsePiModelList } from './aiToolkit/internal/pi.js';
import { compareSemver } from './versionUtils.js';

/**
 * The first semver-looking token in a `--version` banner, or `null`.
 *
 * Each banner holds one `x.y.z` run; the word boundary keeps a build hash from matching. `null`
 * (not `''`) is the NOT-KNOWN sentinel, so an unparseable banner never reads as out of date.
 * @param {string|null|undefined} stdout
 * @returns {string|null}
 */
export function parseHarnessVersion(stdout) {
  if (typeof stdout !== 'string') return null;
  const match = stdout.match(/\b(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\b/);
  return match ? match[1] : null;
}

/**
 * Null-guarding {@link compareSemver}, which maps a non-numeric segment to `NaN` and so reads
 * `'nightly'` as "equal". Callers render "update available" only for a definite `-1`.
 * @param {string|null|undefined} a
 * @param {string|null|undefined} b
 * @returns {-1|0|1|null}
 */
export function compareHarnessVersions(a, b) {
  const parsed = [a, b].map((v) => (typeof v === 'string' ? parseHarnessVersion(v.trim()) : null));
  if (parsed.some((v) => v === null)) return null;
  return compareSemver(parsed[0], parsed[1]);
}

// Chatter (agy's "Fetching available models...", grok's sign-in banner) is dropped by shape, not by listing banners.
const isChatterLine = (line) => line === '' || line.endsWith(':') || line.endsWith('...') || /\s/.test(line);

// `opencode models`: one `provider/model` per line.
const parseOpencodeModels = (lines) => lines.filter((line) => !isChatterLine(line) && line.includes('/'));

// `grok models`: only bulleted rows (`  * grok-4.6 (default)`), so `Default model:` is not read as a model.
const parseGrokModels = (lines) => lines
  .filter((line) => /^[*-]\s/.test(line))
  .map((line) => line.replace(/^[*-]\s+/, '').replace(/\s*\(default\)\s*$/, '').trim())
  .filter((id) => id && !isChatterLine(id));

// One parser per harness that can list models; the registry's `modelsArgs` is pinned to this table by `providerRuntimeInstaller.test.js`.
const MODEL_PARSERS = {
  pi: (lines) => parsePiModelList(lines.join('\n')),
  opencode: parseOpencodeModels,
  // Kilo is an OpenCode fork with the same output shape.
  kilo: parseOpencodeModels,
  grok: parseGrokModels,
  agy: (lines) => parseAntigravityModelList(lines.join('\n')),
  'cursor-agent': (lines) => parseCursorModelList(lines.join('\n')),
};

/** Harness ids {@link parseHarnessModels} can parse; a registry row with no parser would refuse forever. */
export const HARNESS_MODEL_PARSER_IDS = Object.freeze(Object.keys(MODEL_PARSERS));

/** Upper bound on a parsed catalog, so a runaway vendor output cannot be stored wholesale. */
export const MAX_MODELS = 200;

/**
 * Model ids a harness reported, de-duplicated in listed order. `[]` means nothing parsed; callers
 * refuse to overwrite a stored catalog with it.
 *
 * @param {string} harnessId - the binary name (`opencode`, `agy`, `grok`)
 * @param {string|null|undefined} stdout
 * @returns {string[]}
 */
export function parseHarnessModels(harnessId, stdout) {
  const parse = Object.hasOwn(MODEL_PARSERS, harnessId) ? MODEL_PARSERS[harnessId] : null;
  if (!parse || typeof stdout !== 'string') return [];
  // Leading trim only on tab-free rows: Antigravity's TAB rows keep their separator, Grok's arrive indented.
  const lines = stdout.split(/\r?\n/).map((line) => {
    const trimmed = line.replace(/\s+$/, '');
    return trimmed.includes('\t') ? trimmed : trimmed.trimStart();
  });
  return [...new Set(parse(lines))].slice(0, MAX_MODELS);
}

/** `npm view <pkg> version` can be preceded by a registry warning; reuse the banner parser. */
export const parseNpmLatestVersion = parseHarnessVersion;
