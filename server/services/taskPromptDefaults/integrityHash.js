/**
 * Hashing for the prompt-default integrity snapshot.
 *
 * Shared by taskPromptDefaults.test.js (which asserts the snapshot) and
 * scripts/regen-prompt-integrity-snapshot.js (which writes it), so the two can
 * never disagree about how a prompt body is hashed.
 *
 * Deliberately NOT re-exported from ../taskPromptDefaults.js: that barrel is a
 * pure data leaf, and this is tooling for the snapshot rather than prompt data.
 */
import { createHash } from 'crypto';
import { PORTOS_API_URL } from '../../lib/ports.js';

const API_URL_PLACEHOLDER = '{{PORTOS_API_URL}}';

// Prompt bodies embed the install's API origin two different ways:
//
//   1. Current defaults interpolate PORTOS_API_URL at module load, so the body
//      text varies with PORTOS_API_URL / PORTOS_HOST / PORT.
//   2. Preserved historical defaults (pre-genericization) hardcode
//      `http://localhost:5555` — the origin that WAS the default when they
//      shipped. Those bytes are frozen history and never change again, so the
//      literal is pinned here rather than derived from PORTS.API.
//
// Both collapse to the same placeholder so a body hashes identically on every
// install. Normalizing only (1) made the snapshot reproducible solely on a
// machine whose PORTOS_API_URL happened to equal the legacy origin: anywhere
// else — a custom PORTOS_HOST, or simply a shell with PORT set, as inside a CoS
// agent — the five bodies carrying the literal hashed differently and the
// integrity test failed while nothing had actually drifted (issue #3359).
const LEGACY_API_ORIGIN = 'http://localhost:5555';

// Longest first: the two origins can overlap — `PORTOS_API_URL=http://localhost`
// (port 80) is a prefix of the legacy literal, and replacing it first would turn
// `http://localhost:5555` into `{{PORTOS_API_URL}}:5555`, which the legacy pass
// can then no longer match. Replacing the longer candidate first leaves only
// standalone occurrences of the shorter one.
export const normalizePromptForHash = (body, apiUrl = PORTOS_API_URL) => (
  [apiUrl, LEGACY_API_ORIGIN]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)
    .reduce((out, origin) => out.split(origin).join(API_URL_PLACEHOLDER), String(body))
);

export const hashPromptBody = (body, apiUrl = PORTOS_API_URL) => createHash('md5')
  .update(normalizePromptForHash(body, apiUrl), 'utf8')
  .digest('hex');

/**
 * Build the full snapshot shape from the taskPromptDefaults exports. Keys are
 * sorted (see sortedEntries) so a regeneration produces a clean, mergeable diff.
 */
export const buildPromptIntegritySnapshot = ({
  DEFAULT_TASK_PROMPTS,
  PROMPT_VERSIONS,
  REFERENCE_WATCH_AUDITED_VERSION,
  PREVIOUS_DEFAULT_PROMPTS,
}, apiUrl = PORTOS_API_URL) => ({
  DEFAULT_TASK_PROMPTS: sortedEntries(
    Object.entries(DEFAULT_TASK_PROMPTS).map(([key, body]) => [key, hashPromptBody(body, apiUrl)]),
  ),
  PROMPT_VERSIONS: sortedEntries(Object.entries(PROMPT_VERSIONS)),
  REFERENCE_WATCH_AUDITED_VERSION,
  PREVIOUS_DEFAULT_PROMPTS: sortedEntries(
    Object.entries(PREVIOUS_DEFAULT_PROMPTS)
      .map(([key, bodies]) => [key, bodies.map((body) => hashPromptBody(body, apiUrl))]),
  ),
});

// Sorted keys put unrelated additions on unrelated lines so parallel branches
// merge cleanly (declaration order made every new prompt the last line of its
// section — a conflict on every rebase). Byte order, not locale, so every
// machine regenerates the same file.
function sortedEntries(entries) {
  return Object.fromEntries(entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}
