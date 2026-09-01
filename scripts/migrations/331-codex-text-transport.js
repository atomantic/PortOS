/**
 * Advertise the ChatGPT-subscription text transport on every installed Codex
 * harness record (#5590).
 *
 * Phase 1 (#5589) taught PortOS to read the Codex account; this is the record
 * flag that lets the same `codex` record ALSO serve plain text through the
 * app-server, so a signed-in subscriber can point Brain / JIRA / Identity at
 * their subscription instead of buying an OpenAI API key.
 *
 * Two things this migration deliberately does NOT do:
 *
 *   - **It never sets `textTransportEnabled`.** Advertising the capability is
 *     not permission to bill a subscription; the user turns it on themselves.
 *     A migration that enabled it would make an install start routing existing
 *     background features through ChatGPT the moment it updated.
 *   - **It never touches a record the user has already pointed somewhere else.**
 *     A `codex` entry whose `command` is no longer the `codex` binary, or that
 *     already carries a `textTransport`, is left exactly as it is.
 *
 * Kept in lockstep with data.reference/providers.json and
 * server/lib/aiToolkit/defaults/providers.sample.json. Later default changes
 * require a new migration.
 */

import { readProvidersDoc, writeJsonAtomic } from './_lib.js';

const TRANSPORT = 'codex-app-server';
const CODEX_COMMAND = 'codex';

// Logged relative, never as `doc.path` — that is an absolute path carrying the
// operator's home directory, and a boot line is the wrong place to print it.
const PROVIDERS_REL_PATH = 'data/providers.json';

// `readProvidersDoc` is deliberately silent so each caller can say what ITS skip
// costs the user; this is 331's copy of that message.
const SKIP_REASONS = {
  'no-file': 'not present (a fresh install seeds Codex from data.reference)',
  unreadable: 'is not valid JSON',
  'bad-shape': 'has no providers map',
};

/**
 * Is this record still the shipped Codex CLI/TUI harness?
 *
 * Keyed on the COMMAND rather than the id, matching `isCodexSubscriptionProvider`
 * in server/lib/codexAccount.js: a user who renamed the record still runs the
 * same binary against the same ChatGPT sign-in, while a record repointed at a
 * different binary must not inherit a Codex-only capability.
 */
const isCodexHarness = (provider) => {
  if (provider?.type !== 'cli' && provider?.type !== 'tui') return false;
  if (provider.textTransport) return false;
  const command = typeof provider.command === 'string' ? provider.command.trim() : '';
  if (command === '') return false;
  // Byte-for-byte the rule `lib/providerModels.commandBasename` applies (inlined
  // because a migration is a frozen snapshot and must not drift when that helper
  // changes). Case-INSENSITIVE, and only `.exe` is stripped: a record this
  // stamps but the runtime gate then rejects would advertise a capability that
  // can never be switched on, and one it skips never gets the flag at all.
  return command.split(/[\\/]/).pop().toLowerCase().replace(/\.exe$/, '') === CODEX_COMMAND;
};

export default {
  async up({ rootDir }) {
    const doc = await readProvidersDoc({ rootDir });
    if (!doc.ok) {
      const why = SKIP_REASONS[doc.reason] ?? 'could not be read';
      console.log(`📄 ${PROVIDERS_REL_PATH} ${why} — skipping the Codex text-transport flag`);
      return { ok: false, reason: doc.reason, updated: 0 };
    }

    // Every Codex harness record, not just the `codex` id — that is what "keyed on
    // the COMMAND" above actually means, and an install that cloned `codex` into
    // `codex-review` runs the same binary against the same ChatGPT sign-in.
    const targets = Object.values(doc.providers).filter(isCodexHarness);
    if (targets.length === 0) return { ok: true, reason: 'already-current-or-custom', updated: 0 };

    for (const provider of targets) provider.textTransport = TRANSPORT;
    await writeJsonAtomic(doc.path, doc.config);
    console.log(`📝 ${PROVIDERS_REL_PATH}: ${targets.length} Codex provider record${targets.length === 1 ? '' : 's'} now advertising the ChatGPT subscription text transport (off until enabled)`);
    return { ok: true, reason: 'updated', updated: targets.length };
  },
};
