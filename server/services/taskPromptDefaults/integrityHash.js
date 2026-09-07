/**
 * Hashing for the prompt-default integrity snapshot, and the snapshot itself.
 *
 * `integrity.snapshot.json` holds an md5 per current default body, the
 * PROMPT_VERSIONS map, and — under PREVIOUS_DEFAULT_PROMPTS — the md5 of every
 * default a key has ever shipped and since replaced. Three readers share this
 * module so they can never disagree about how a body is hashed:
 *
 *   - shippedPrompts.js recognizes a stored prompt as a retired default by
 *     hashing it against that history (the cross-install auto-upgrade contract,
 *     AGENTS.md "Distribution model");
 *   - taskPromptDefaults.test.js asserts the current bodies and versions still
 *     match the snapshot;
 *   - scripts/regen-prompt-integrity-snapshot.js advances the snapshot after a
 *     PROMPT_VERSIONS bump, retiring the outgoing hash onto the history
 *     (advancePromptIntegritySnapshot below).
 *
 * Not re-exported from ../taskPromptDefaults.js: that barrel is the prompt
 * DATA leaf, and this is the snapshot's tooling.
 */
import { createHash } from 'crypto';
import { createRequire } from 'module';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { PORTOS_API_URL } from '../../lib/portosUrls.js';

export const PROMPT_INTEGRITY_SNAPSHOT_PATH = join(dirname(fileURLToPath(import.meta.url)), 'integrity.snapshot.json');

// `require`, not `readFileSync`: ../taskPromptDefaults.js is reached by ~80
// server suites, dozens of which `vi.mock('fs')` wholesale for their own
// reasons, and a module-load read through the mocked module would fail every
// one of them. Node's CJS loader parses the JSON natively, outside any ESM mock
// layer — and, like the rest of the repo (lib/promptSystemStages.js), this
// avoids JSON import attributes. The result is the shared require cache:
// callers read it, never mutate it.
const require = createRequire(import.meta.url);
export const readPromptIntegritySnapshot = () => require(PROMPT_INTEGRITY_SNAPSHOT_PATH);

const API_URL_PLACEHOLDER = '{{PORTOS_API_URL}}';

// Prompt bodies embed the install's API origin two different ways:
//
//   1. Current defaults interpolate PORTOS_API_URL at module load, so the body
//      text varies with PORTOS_API_URL / PORTOS_HOST / PORT.
//   2. Retired defaults from before the genericization hardcode
//      `http://localhost:5555` — the origin that WAS the default when they
//      shipped. Those bytes are frozen history and never change again, so the
//      literal is pinned here rather than derived from PORTS.API.
//
// Both collapse to the same placeholder so a body hashes identically on every
// install — which is also what lets a stored retired body match whichever
// origin it was rendered with. Normalizing only (1) made the snapshot
// reproducible solely on a machine whose PORTOS_API_URL happened to equal the
// legacy origin: anywhere else — a custom PORTOS_HOST, or simply a shell with
// PORT set, as inside a CoS agent — the bodies carrying the literal hashed
// differently and the integrity test failed while nothing had actually drifted
// (issue #3359).
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
 * The source-owned sections of the snapshot, derived from the taskPromptDefaults
 * exports. The fourth section — PREVIOUS_DEFAULT_PROMPTS — is not derivable: the
 * retired bodies are not in the tree, only their hashes are, so only
 * advancePromptIntegritySnapshot composes it. Keys are sorted (see
 * sortedEntries) so a regeneration produces a clean, mergeable diff.
 */
export const buildPromptIntegritySnapshot = ({
  DEFAULT_TASK_PROMPTS,
  PROMPT_VERSIONS,
  REFERENCE_WATCH_AUDITED_VERSION,
}, apiUrl = PORTOS_API_URL) => ({
  DEFAULT_TASK_PROMPTS: sortedEntries(
    Object.entries(DEFAULT_TASK_PROMPTS).map(([key, body]) => [key, hashPromptBody(body, apiUrl)]),
  ),
  PROMPT_VERSIONS: sortedEntries(Object.entries(PROMPT_VERSIONS)),
  REFERENCE_WATCH_AUDITED_VERSION,
});

/**
 * Advance a committed snapshot to the current source — the bump tool's core,
 * and the only writer of the history lists.
 *
 * For each versioned key whose body hash changed, the committed CURRENT hash is
 * the outgoing default. When PROMPT_VERSIONS rose it is appended to that key's
 * history, so the body every un-customized install is still holding stays
 * recognized by construction — no paste, nothing to mis-copy. When the version
 * did not rise the change is drift, reported instead of blessed: writing it
 * would ship an edited default no install recognizes as shipped, which is
 * exactly what the integrity test exists to catch.
 *
 * Versions only ever rise. A rollback — even with the body untouched — is drift
 * too: every install already stamped at the higher number would read the next
 * real bump as `storedVersion < current` false and never receive it.
 *
 * Unversioned keys (pipeline stage bodies, the manual-claim body) are read live
 * and never persisted, so their hash simply follows the source. For the same
 * reason the history of a key that is no longer versioned is dropped: nothing
 * unversioned is ever stored (versions.js's parity allowlist), so no install
 * holds a body of it that needs recognizing.
 */
export const advancePromptIntegritySnapshot = (committed, defaults) => {
  const next = buildPromptIntegritySnapshot(defaults);
  const history = { ...committed.PREVIOUS_DEFAULT_PROMPTS };
  const retired = [];
  const drift = [];

  for (const [key, to] of Object.entries(next.PROMPT_VERSIONS)) {
    if (committed.PROMPT_VERSIONS[key] > to) drift.push({ key, version: to, reason: 'rollback' });
  }

  for (const [key, hash] of Object.entries(next.DEFAULT_TASK_PROMPTS)) {
    const outgoing = committed.DEFAULT_TASK_PROMPTS[key];
    const from = committed.PROMPT_VERSIONS[key];
    const to = next.PROMPT_VERSIONS[key];
    if (outgoing === undefined || outgoing === hash || to === undefined) continue;
    if (from === to) {
      drift.push({ key, version: to, reason: 'unbumped' });
      continue;
    }
    if (from > to) continue; // already reported as a rollback
    // A revert to an older body is already on the list; keep one entry per body.
    if (!history[key]?.includes(outgoing)) history[key] = [...(history[key] || []), outgoing];
    retired.push({ key, from, to, hash: outgoing });
  }

  const dropped = Object.keys(history).filter((key) => next.PROMPT_VERSIONS[key] === undefined);
  for (const key of dropped) delete history[key];

  return {
    snapshot: { ...next, PREVIOUS_DEFAULT_PROMPTS: sortedEntries(Object.entries(history)) },
    retired,
    drift,
    dropped,
  };
};

// Sorted keys put unrelated additions on unrelated lines so parallel branches
// merge cleanly (declaration order made every new prompt the last line of its
// section — a conflict on every rebase). Byte order, not locale, so every
// machine regenerates the same file.
function sortedEntries(entries) {
  return Object.fromEntries(entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}
