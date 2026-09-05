/**
 * Give existing Codex provider records the explicit `ignoreUserConfig: false`
 * the shipped seed now carries (#6304).
 *
 * PortOS can now SAY when the install's own `~/.codex/config.toml` re-points
 * Codex model routing at a third-party bridge, and offer a per-provider pin
 * (`--ignore-user-config` at spawn) that puts the run back on the account the
 * provider card reports. `false` is the pin OFF, which is exactly today's
 * behavior — this migration changes no run, it only makes the field present so
 * the Providers toggle round-trips against a real stored value on an install
 * that predates the field, instead of on an absent one.
 *
 * Gated on the PRESENCE of a Codex record, never on the absence of the new
 * field (root AGENTS.md): the field is what this writes, so keying on its
 * absence would be keying on its own output. A record that already carries the
 * field — the user having toggled it, or a newer seed having landed — is left
 * exactly as it is.
 *
 * Command-keyed, matching `isCodexProvider`, so a renamed clone of the shipped
 * record is covered and a record repointed at somebody else's binary is not.
 * The rule is inlined rather than imported because a migration is a frozen
 * snapshot and must not drift when that helper changes.
 */

import { readProvidersDoc, writeJsonAtomic } from './_lib.js';

const CODEX_COMMAND = 'codex';
const PROVIDERS_REL_PATH = 'data/providers.json';

const SKIP_REASONS = {
  'no-file': 'not present (a fresh install seeds these from data.reference)',
  unreadable: 'is not valid JSON',
  'bad-shape': 'has no providers map',
};

/** `commandBasename`, inlined: case-insensitive basename with `.exe` stripped. */
const basename = (command) => (typeof command === 'string' ? command.trim() : '')
  .split(/[\\/]/).pop().toLowerCase().replace(/\.exe$/, '');

const isCodexRecord = (provider) => (provider?.type === 'cli' || provider?.type === 'tui')
  && basename(provider.command) === CODEX_COMMAND;

export default {
  async up({ rootDir }) {
    const doc = await readProvidersDoc({ rootDir });
    if (!doc.ok) {
      const why = SKIP_REASONS[doc.reason] ?? 'could not be read';
      console.log(`📄 ${PROVIDERS_REL_PATH} ${why} — skipping the Codex ignore-user-config stamp`);
      return { ok: false, reason: doc.reason, updated: 0 };
    }

    const codexRecords = Object.values(doc.providers).filter(isCodexRecord);
    if (codexRecords.length === 0) return { ok: true, reason: 'no-codex-records', updated: 0 };

    const targets = codexRecords.filter((provider) => typeof provider.ignoreUserConfig !== 'boolean');
    if (targets.length === 0) return { ok: true, reason: 'already-current', updated: 0 };

    for (const provider of targets) provider.ignoreUserConfig = false;
    await writeJsonAtomic(doc.path, doc.config);
    console.log(`📝 ${PROVIDERS_REL_PATH}: ${targets.length} Codex provider record${targets.length === 1 ? '' : 's'} stamped with ignoreUserConfig=false`);
    return { ok: true, reason: 'updated', updated: targets.length };
  },
};
