/**
 * Parsers for what a coding-agent HARNESS prints about itself — its version
 * banner and its model catalog.
 *
 * A harness is the CLI/TUI binary a provider shells out to (`opencode`,
 * `claude`, `codex`, `agy`, `grok`, `kimi`, `cursor-agent`). PortOS could
 * already answer "is it on PATH?" (`services/providerRuntimeInstaller.js`); the
 * Harnesses page also needs "which version, and which models does THIS install
 * of it know about?" — and every vendor answers both in its own shape.
 *
 * Pure on purpose: no spawning, no filesystem, no network. The service layer
 * runs the child and hands the captured stdout here, which keeps the vendor
 * output shapes pinned by cheap table-driven tests instead of by running six
 * real binaries in CI.
 *
 * **Model ids come back in the exact spelling `--model` takes.** OpenCode names
 * its models `provider/model` and accepts that form verbatim, so the namespace
 * is KEPT; Antigravity and Grok name theirs bare and take them bare. Stripping
 * or adding a namespace here would produce a list the harness itself rejects.
 *
 * **A vendor whose stdout already has a parser DELEGATES to it.** Antigravity's
 * and Cursor's live in `antigravity.js` and `aiToolkit/internal/cursor.js`,
 * where the provider-card refresh has used them for far longer than this page
 * has existed. A second copy here would be a third and fourth transcription of
 * one vendor's output — and would have been wrong on arrival: the agy parser
 * accepts an older build's bare-id-per-line rows and drops the
 * `<configured-default>` sentinel, neither of which a fresh reading of today's
 * TAB-separated output would have known to do.
 */

import { parseAntigravityModelList } from './antigravity.js';
import { compareSemver } from './versionUtils.js';
import { parseCursorModelList } from './aiToolkit/internal/cursor.js';

/**
 * The first semver-looking token in a `--version` banner, or `null`.
 *
 * Every harness spells the banner differently — `1.18.27`, `2.1.259 (Claude
 * Code)`, `codex-cli 0.151.0`, `grok 1.0.13 (5e9a58528b76) [stable]` — and all
 * of them contain exactly one `x.y.z` run. Anchored on a word boundary so a
 * build hash (`5e9a58528b76`) or a date fragment inside a longer token cannot
 * be read as the version.
 *
 * `null` (not `''`) is the NOT-KNOWN sentinel: a harness whose banner we cannot
 * parse must not read as "version unknown, therefore out of date" — the
 * update-available comparison bails on a null on either side.
 *
 * @param {string|null|undefined} stdout
 * @returns {string|null}
 */
export function parseHarnessVersion(stdout) {
  if (typeof stdout !== 'string') return null;
  const match = stdout.match(/\b(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\b/);
  return match ? match[1] : null;
}

/**
 * The null-guarding wrapper around {@link compareSemver}.
 *
 * The ORDERING is `versionUtils.js`'s job (prerelease precedence, build
 * metadata, the lot) — what is new here is the refusal: a version that did not
 * parse must yield `null`, not an ordering. `compareSemver` maps a
 * non-numeric segment to `NaN` and every NaN comparison to "equal", so feeding
 * it `'nightly'` would silently answer "same version" and a caller would render
 * a harness as current on no evidence. The caller renders "update available"
 * only for a definite `-1`.
 *
 * @param {string|null|undefined} a
 * @param {string|null|undefined} b
 * @returns {-1|0|1|null}
 */
export function compareHarnessVersions(a, b) {
  // Both sides must be a version this module would have accepted out of a
  // `--version` banner in the first place.
  const parsed = [a, b].map((v) => (typeof v === 'string' ? parseHarnessVersion(v.trim()) : null));
  if (parsed.some((v) => v === null)) return null;
  return compareSemver(parsed[0], parsed[1]);
}

/**
 * A line that is chatter rather than a model id.
 *
 * `agy models` prints `Fetching available models...` before its table and
 * `grok models` prints a sign-in banner plus a `Default model:` line — both on
 * stdout, interleaved with the real rows. Dropping a "model" whose id contains
 * whitespace or ends in a colon is enough to separate the two for every vendor
 * here without hand-listing each banner string.
 */
const isChatterLine = (line) => line === '' || line.endsWith(':') || line.endsWith('...') || /\s/.test(line);

/**
 * `opencode models` — one fully-qualified `provider/model` per line, no header.
 * The namespace is what `opencode --model` takes, so it is preserved.
 */
const parseOpencodeModels = (lines) => lines.filter((line) => !isChatterLine(line) && line.includes('/'));

/**
 * `grok models` — a sign-in banner, a `Default model: <id>` line, an `Available
 * models:` header, then bulleted rows: `  * grok-4.6 (default)` / `  - grok-4.5`.
 * Keep the bulleted rows only, dropping the bullet and the `(default)` marker,
 * so the `Default model:` line cannot be read as a model called `model:`.
 */
const parseGrokModels = (lines) => lines
  .filter((line) => /^[*-]\s/.test(line))
  .map((line) => line.replace(/^[*-]\s+/, '').replace(/\s*\(default\)\s*$/, '').trim())
  .filter((id) => id && !isChatterLine(id));

/**
 * One parser per harness whose binary can enumerate its own models. A vendor
 * absent from this table has no `models` subcommand, which the registry
 * declares by carrying no `modelsArgs` — the two are pinned together by
 * `providerRuntimeInstaller.test.js`.
 */
const MODEL_PARSERS = {
  opencode: parseOpencodeModels,
  grok: parseGrokModels,
  // Delegated — these two vendors' stdout shapes are already owned elsewhere.
  // Both take the raw stdout rather than the pre-split lines, so they are
  // adapted here instead of being called through the line pipeline.
  agy: (lines) => parseAntigravityModelList(lines.join('\n')),
  'cursor-agent': (lines) => parseCursorModelList(lines.join('\n')),
};

/**
 * The harness ids {@link parseHarnessModels} can actually parse. Published so
 * the registry's `modelsArgs` rows and these parsers are pinned to each other:
 * a row claiming it can list models with no parser here would report an empty
 * catalog and refuse forever.
 */
export const HARNESS_MODEL_PARSER_IDS = Object.freeze(Object.keys(MODEL_PARSERS));

/** Upper bound on a parsed catalog, so a runaway vendor output cannot be stored wholesale. */
export const MAX_MODELS = 200;

/**
 * The model ids a harness reported, de-duplicated and in the order it listed
 * them (vendors sort newest-first, which is the order a picker wants).
 *
 * Returns `[]` for output that parsed to nothing — the caller distinguishes
 * "the probe never ran" from "it ran and found none" by whether it called this
 * at all, and refuses to overwrite a stored catalog with an empty result.
 *
 * @param {string} harnessId - the binary name (`opencode`, `agy`, `grok`)
 * @param {string|null|undefined} stdout
 * @returns {string[]}
 */
export function parseHarnessModels(harnessId, stdout) {
  const parse = Object.hasOwn(MODEL_PARSERS, harnessId) ? MODEL_PARSERS[harnessId] : null;
  if (!parse || typeof stdout !== 'string') return [];
  // Trailing whitespace goes unconditionally; a LEADING trim only on a row with
  // no tab, because a TAB-separated Antigravity row must keep its separator
  // intact while Grok's rows arrive indented under their header.
  const lines = stdout.split(/\r?\n/).map((line) => {
    const trimmed = line.replace(/\s+$/, '');
    return trimmed.includes('\t') ? trimmed : trimmed.trimStart();
  });
  // Every parser already drops blanks, so no second filter is needed here.
  return [...new Set(parse(lines))].slice(0, MAX_MODELS);
}

/**
 * `npm view <pkg> version` prints the bare version and nothing else, but a
 * registry warning can precede it on stdout. Reuse the banner parser.
 */
export const parseNpmLatestVersion = parseHarnessVersion;
