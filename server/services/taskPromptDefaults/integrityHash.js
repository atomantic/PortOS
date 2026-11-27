/**
 * Hashing for the prompt-default integrity snapshot, and the snapshot itself.
 *
 * `integrity.snapshot.json` holds an md5 per current default body, the
 * PROMPT_VERSIONS map, and under PREVIOUS_DEFAULT_PROMPTS the md5 of every
 * replaced default. Shared by shippedPrompts.js (recognizes a retired default;
 * AGENTS.md "Distribution model"), taskPromptDefaults.test.js, and
 * scripts/regen-prompt-integrity-snapshot.js so they agree on how a body is hashed.
 *
 * Not re-exported from ../taskPromptDefaults.js: that barrel is the prompt
 * DATA leaf, and this is the snapshot's tooling.
 */
import { createHash } from 'crypto';
import { createRequire } from 'module';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { PORTOS_API_URL } from '../../lib/portosUrls.js';
import { AUDIT_DOMAIN_ALIASES, TASK_TYPE_RENAMES } from '../../lib/scheduledTaskTypes.js';

export const PROMPT_INTEGRITY_SNAPSHOT_PATH = join(dirname(fileURLToPath(import.meta.url)), 'integrity.snapshot.json');

// `require`, not `readFileSync`: ../taskPromptDefaults.js is reached by ~80
// server suites, dozens of which `vi.mock('fs')`, and a mocked module-load read
// would fail them all. Node's CJS loader sits outside the ESM mock layer and
// avoids JSON import attributes. Shared require cache: never mutate.
const require = createRequire(import.meta.url);
export const readPromptIntegritySnapshot = () => require(PROMPT_INTEGRITY_SNAPSHOT_PATH);

const API_URL_PLACEHOLDER = '{{PORTOS_API_URL}}';

// Prompt bodies embed the API origin two ways: current defaults interpolate
// PORTOS_API_URL (varies with PORTOS_API_URL / PORTOS_HOST / PORT); retired
// defaults hardcode `http://localhost:5555`, frozen history pinned here rather
// than derived from PORTS.API. Both collapse to one placeholder so a body hashes
// identically on every install and a stored retired body matches whichever
// origin it was rendered with (#3359).
const LEGACY_API_ORIGIN = 'http://localhost:5555';

// Longest first: the origins can overlap (`PORTOS_API_URL=http://localhost` is a
// prefix of the legacy literal); replacing the shorter first would turn
// `http://localhost:5555` into `{{PORTOS_API_URL}}:5555`, which the legacy pass
// can no longer match.
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
 * For each versioned key whose body hash changed, the version rises by one and
 * the committed CURRENT hash (what un-customized installs hold) is retired onto
 * that key's history. Versions only ever rise here; the guard test compares
 * against the base snapshot to catch a hand edit that lowers one (installs
 * stamped at the higher number would never get the next real bump).
 *
 * A body with no committed hash is new: v1 unless the key is on
 * `UNPERSISTED_PROMPT_KEYS` (read live, never persisted, no version or history).
 * The history of a key that is no longer versioned is dropped.
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

  for (const [oldKey, domain] of Object.entries(AUDIT_DOMAIN_ALIASES)) {
    if (Object.hasOwn(next.DEFAULT_TASK_PROMPTS, oldKey)) continue;
    const oldCurrent = committed.DEFAULT_TASK_PROMPTS[oldKey];
    const moved = [...(history[oldKey] || []), ...(oldCurrent ? [oldCurrent] : [])];
    if (moved.length) history[domain] = [...new Set([...(history[domain] || []), ...moved])];
    delete history[oldKey];
    delete versions[oldKey];
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
