/**
 * Strip the non-existent `--print` / `--afk` flags from the Kimi Code providers'
 * stored args so headless runs stop dying at argv parsing (issue #4139).
 *
 * Migration 201 seeded `kimi-cli` with `args: ["--print"]`, documented from
 * MoonshotAI docs without a live binary to check against. A live `kimi` v0.32.0
 * rejects it outright:
 *
 *     $ kimi --print -p "hello"
 *     error: unknown option '--print'
 *     (Did you mean --prompt?)
 *
 * Non-interactive mode is implicit in supplying `-p`/`--prompt`, so the headless
 * argv needs no mode flag at all. `--afk` is equally unrecognized on both the CLI
 * and TUI paths. `server/lib/kimi.js` no longer injects either, but a deployed
 * install already carries the bad token in `data/providers.json` — `setup-data.js`
 * merges only *missing* provider entries and never updates existing ones — so
 * without this migration every stored `kimi-cli` stays broken.
 *
 * Unlike the conservative "rewrite only an exactly-matching old default" rule used
 * by 121-codex-tui-bypass-sandbox, this migration removes the two tokens wherever
 * they appear in a Kimi provider's args, including a hand-curated list. That is
 * safe because neither flag exists in the binary at all: keeping one is never a
 * valid user preference, it is a guaranteed startup failure. Every other arg the
 * user added is preserved in order, so the rest of their customization survives.
 */

import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';

const PROVIDERS_REL_PATH = 'data/providers.json';

const TARGET_IDS = ['kimi-cli', 'kimi-tui'];
const DEAD_FLAGS = new Set(['--print', '--afk']);

export default {
  async up({ rootDir }) {
    const providersPath = join(rootDir, PROVIDERS_REL_PATH);
    const raw = await readFile(providersPath, 'utf-8').catch((err) => {
      if (err.code === 'ENOENT') return null;
      throw err;
    });
    if (raw == null) {
      console.log(`📄 ${PROVIDERS_REL_PATH} not present — skipping (fresh install seeds Kimi from data.reference without the dead flags)`);
      return;
    }

    let config;
    try {
      config = JSON.parse(raw);
    } catch (err) {
      console.log(`⚠️ ${PROVIDERS_REL_PATH}: invalid JSON, skipping (${err.message})`);
      return;
    }

    let changed = 0;
    for (const id of TARGET_IDS) {
      const provider = config?.providers?.[id];
      if (!provider || !Array.isArray(provider.args)) continue;
      const kept = provider.args.filter((arg) => !DEAD_FLAGS.has(arg));
      if (kept.length === provider.args.length) continue;
      const dropped = provider.args.filter((arg) => DEAD_FLAGS.has(arg));
      provider.args = kept;
      changed++;
      console.log(`📝 ${PROVIDERS_REL_PATH}: ${id} dropped ${dropped.join(' ')} (not real kimi flags)`);
    }

    if (changed === 0) {
      console.log(`✅ ${PROVIDERS_REL_PATH}: Kimi providers carry no dead flags — no change`);
      return;
    }

    await writeFile(providersPath, `${JSON.stringify(config, null, 2)}\n`);
  },
};
