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
 *     body edit, bumping the version and retiring the outgoing hash onto the
 *     history (advancePromptIntegritySnapshot below).
 *
 * Not re-exported from ../taskPromptDefaults.js: that barrel is the prompt
 * DATA leaf, and this is the snapshot's tooling.
 */
import { createHash } from 'crypto';
import { createRequire } from 'module';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { PORTOS_API_URL } from '../../lib/portosUrls.js';
import { TASK_TYPE_RENAMES } from '../../lib/scheduledTaskTypes.js';

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

// Prompt history follows a scheduled task when its public task key is renamed
// (TASK_TYPE_RENAMES), so installs carrying the old persisted prompt body still
// recognize it as shipped after the task config is migrated.

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
 * Advance a committed snapshot to the current source — the regen tool's core,
 * and the only writer of PROMPT_VERSIONS and the history lists.
 *
 * The snapshot is the source of version numbers (versions.js re-exports them),
 * so authors never pick a bump: for each versioned key whose body hash changed,
 * the version rises by one and the committed CURRENT hash — the default every
 * un-customized install is still holding — is retired onto that key's history.
 * Recognition is by construction: no paste, nothing to mis-copy. Versions only
 * ever rise here; the guard test compares against the base snapshot to catch a
 * hand edit that lowers one (every install stamped at the higher number would
 * read the next real bump as `storedVersion < current` false and never get it).
 *
 * A body with no committed hash is new: it starts at v1 unless the key is on
 * `UNPERSISTED_PROMPT_KEYS` (pipeline stage bodies and the manual claim body are
 * read live and never persisted, so their hash simply follows the source and
 * they carry no version or history). Nothing unversioned is ever stored, so the
 * history of a key that is no longer versioned is dropped.
 */
export const advancePromptIntegritySnapshot = (committed, defaults) => {
  const unpersisted = new Set(defaults.UNPERSISTED_PROMPT_KEYS ?? []);
  const versions = { ...committed.PROMPT_VERSIONS };
  const next = buildPromptIntegritySnapshot({ ...defaults, PROMPT_VERSIONS: versions });
  const history = { ...committed.PREVIOUS_DEFAULT_PROMPTS };
  const retired = [];
  const added = [];

  for (const [oldKey, newKey] of Object.entries(TASK_TYPE_RENAMES)) {
    const moved = [...(history[oldKey] || [])];
    const oldCurrent = committed.DEFAULT_TASK_PROMPTS[oldKey];
    if (oldCurrent && oldCurrent !== next.DEFAULT_TASK_PROMPTS[newKey]) moved.push(oldCurrent);
    if (moved.length) {
      history[newKey] = [...new Set([...(history[newKey] || []), ...moved])];
    }
    if (versions[oldKey] !== undefined && versions[newKey] === undefined) versions[newKey] = versions[oldKey];
    delete history[oldKey];
  }

  for (const [key, hash] of Object.entries(next.DEFAULT_TASK_PROMPTS)) {
    const outgoing = committed.DEFAULT_TASK_PROMPTS[key];
    if (outgoing === hash) continue;
    if (outgoing === undefined) {
      if (versions[key] === undefined && !unpersisted.has(key)) {
        versions[key] = 1;
        added.push({ key, to: 1 });
      }
      continue;
    }
    const from = versions[key];
    if (from === undefined) continue;
    versions[key] = from + 1;
    // A revert to an older body is already on the list; keep one entry per body.
    if (!history[key]?.includes(outgoing)) history[key] = [...(history[key] || []), outgoing];
    retired.push({ key, from, to: from + 1, hash: outgoing });
  }

  const dropped = Object.keys(history).filter((key) => versions[key] === undefined);
  for (const key of dropped) delete history[key];

  return {
    snapshot: {
      ...next,
      PROMPT_VERSIONS: sortedEntries(Object.entries(versions)),
      PREVIOUS_DEFAULT_PROMPTS: sortedEntries(Object.entries(history)),
    },
    retired,
    added,
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
