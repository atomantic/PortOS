/**
 * Make Claude Code TUI the default enabled provider.
 *
 * Pre-existing installs were created when `claude-code` (the headless CLI)
 * was the seeded default. PortOS now runs CoS agents inside the Claude
 * Code TUI by default — it owns its own commit/push/PR sequence via
 * slashdo, supports live BTW paste-through, and avoids the headless
 * CLI's stale-prompt edge cases. This migration switches the user's
 * active provider and enables `claude-code-tui` IFF they still have the
 * pre-flip default in place. A user who deliberately picked a different
 * active provider — or already enabled the TUI on their own — is left
 * untouched.
 *
 * Idempotent: a second run is a no-op once `activeProvider` is something
 * other than `claude-code`, or once `claude-code-tui.enabled` is true.
 */

import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';

const PROVIDERS_REL_PATH = 'data/providers.json';

export default {
  async up({ rootDir }) {
    const providersPath = join(rootDir, PROVIDERS_REL_PATH);
    const raw = await readFile(providersPath, 'utf-8').catch((err) => {
      if (err.code === 'ENOENT') return null;
      throw err;
    });
    if (raw == null) {
      console.log(`📄 ${PROVIDERS_REL_PATH} not present — skipping (fresh install will copy from data.sample with the new default already applied)`);
      return;
    }

    let config;
    try {
      config = JSON.parse(raw);
    } catch (err) {
      console.log(`⚠️ ${PROVIDERS_REL_PATH}: invalid JSON, skipping migration (${err.message})`);
      return;
    }

    const providers = config?.providers;
    if (!providers || typeof providers !== 'object') {
      console.log(`⚠️ ${PROVIDERS_REL_PATH}: no providers map — skipping`);
      return;
    }

    const tui = providers['claude-code-tui'];
    if (!tui) {
      // setup-data's JSON_MERGE_TARGETS would have added this if the
      // sample carried it, but skip cleanly when somehow absent.
      console.log(`⚠️ claude-code-tui provider missing — skipping (run setup-data first)`);
      return;
    }

    let changed = false;
    if (tui.enabled !== true) {
      tui.enabled = true;
      changed = true;
    }
    if (config.activeProvider === 'claude-code') {
      config.activeProvider = 'claude-code-tui';
      changed = true;
    }

    if (changed) {
      await writeFile(providersPath, `${JSON.stringify(config, null, 2)}\n`);
      console.log(`📝 ${PROVIDERS_REL_PATH}: switched default provider to claude-code-tui`);
    } else {
      console.log(`✅ ${PROVIDERS_REL_PATH}: already on claude-code-tui (or a user-selected provider), no changes`);
    }
  },
};
