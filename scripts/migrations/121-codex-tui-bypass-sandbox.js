/**
 * Fix the Codex TUI provider's headless posture so CoS agents stop hitting
 * sandbox/approval walls (e.g. `gh` failing to reach the network, surprise
 * permission prompts mid-run).
 *
 * The prior shipped default pinned `args: ["--ask-for-approval", "never"]`.
 * That silences the approval prompts but leaves Codex's *sandbox* at its
 * default (`workspace-write`), which blocks network access and can still force
 * escalation prompts. Worse, because `applyCommandDefaults()` treats an
 * explicit `--ask-for-approval` as "the user pinned a policy," it suppressed
 * the auto-injected `--dangerously-bypass-approvals-and-sandbox` that's meant
 * to give headless agents the full-yolo posture — so the shipped default
 * actively defeated the bypass mechanism. The CLI codex path already runs
 * `exec --dangerously-bypass-approvals-and-sandbox`; the TUI path should match.
 *
 * `setup-data.js` merges *missing* provider entries but never updates existing
 * ones, so deployed installs keep the broken args until a migration rewrites
 * them.
 *
 * Conservative: only rewrite when `args` STILL EXACTLY matches the old shipped
 * default `["--ask-for-approval", "never"]`. A user who curated their own Codex
 * flags (any other combination) is left alone.
 */

import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';

const PROVIDERS_REL_PATH = 'data/providers.json';

const TARGET_ID = 'codex-tui';
const OLD_ARGS = ['--ask-for-approval', 'never'];
const NEW_ARGS = ['--dangerously-bypass-approvals-and-sandbox'];

// Order-sensitive equality — a reordered/extended arg list counts as
// customization and is skipped.
const sameArray = (a, b) => {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
};

export default {
  async up({ rootDir }) {
    const providersPath = join(rootDir, PROVIDERS_REL_PATH);
    const raw = await readFile(providersPath, 'utf-8').catch((err) => {
      if (err.code === 'ENOENT') return null;
      throw err;
    });
    if (raw == null) {
      console.log(`📄 ${PROVIDERS_REL_PATH} not present — skipping (fresh install seeds from data.reference with the new args)`);
      return;
    }

    let config;
    try {
      config = JSON.parse(raw);
    } catch (err) {
      console.log(`⚠️ ${PROVIDERS_REL_PATH}: invalid JSON, skipping (${err.message})`);
      return;
    }

    const provider = config?.providers?.[TARGET_ID];
    if (!provider) {
      console.log(`✅ ${PROVIDERS_REL_PATH}: no ${TARGET_ID} provider — nothing to do`);
      return;
    }

    if (sameArray(provider.args, NEW_ARGS)) {
      console.log(`✅ ${PROVIDERS_REL_PATH}: ${TARGET_ID} already on the bypass posture — no change`);
      return;
    }

    if (!sameArray(provider.args, OLD_ARGS)) {
      console.log(`✅ ${PROVIDERS_REL_PATH}: ${TARGET_ID} args customized (${JSON.stringify(provider.args)}) — leaving alone`);
      return;
    }

    provider.args = [...NEW_ARGS];
    await writeFile(providersPath, `${JSON.stringify(config, null, 2)}\n`);
    console.log(`📝 ${PROVIDERS_REL_PATH}: ${TARGET_ID} args → --dangerously-bypass-approvals-and-sandbox (headless network + no approval walls)`);
  },
};
