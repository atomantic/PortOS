/**
 * Flip the managed-browser default from headless to headed for existing
 * installs.
 *
 * The whole point of the custom-Chrome-binary / Canary feature is a *visible*,
 * differentiated browser — but `data.reference/browser-config.json` historically
 * shipped `"headless": true`, so every install (and every Canary opt-in) ran the
 * managed browser invisibly. The seed now ships `"headless": false`; fresh
 * installs pick that up from data.reference automatically.
 *
 * Existing installs keep their old `data/browser-config.json`, so they need this
 * migration to flip the value. Conservative, matching migration 058's policy:
 *   - Only flip when `headless === true` — the exact old shipped default. A user
 *     who already set `headless: false`, removed the key, or stored some other
 *     value is left untouched.
 *   - Absent file → skip (fresh install seeds from data.reference, already false).
 *
 * Other browser-config keys (chromePath, userDataDir, cdpPort, …) are preserved.
 */

import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';

const CONFIG_REL_PATH = 'data/browser-config.json';

export default {
  async up({ rootDir }) {
    const configPath = join(rootDir, CONFIG_REL_PATH);
    const raw = await readFile(configPath, 'utf-8').catch((err) => {
      if (err.code === 'ENOENT') return null;
      throw err;
    });
    if (raw == null) {
      console.log(`📄 ${CONFIG_REL_PATH} not present — skipping (fresh install seeds headed from data.reference)`);
      return;
    }

    let config;
    try {
      config = JSON.parse(raw);
    } catch (err) {
      console.log(`⚠️ ${CONFIG_REL_PATH}: invalid JSON, skipping (${err.message})`);
      return;
    }

    if (config?.headless !== true) {
      console.log(`✅ ${CONFIG_REL_PATH}: headless already not the legacy default (${JSON.stringify(config?.headless)}) — left untouched`);
      return;
    }

    config.headless = false;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    console.log(`📝 ${CONFIG_REL_PATH}: flipped headless true → false (default HEADED)`);
  },
};
