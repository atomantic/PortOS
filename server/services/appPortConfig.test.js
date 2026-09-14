/**
 * Port write-back fidelity against a REAL multi-process ecosystem config.
 *
 * These go through the filesystem deliberately: issue #7357 was a mis-attributed
 * label that produced a successful-looking write into a SIBLING process's port
 * literal, and the route suite mocks `writeEcosystemPortEdits` away, so nothing
 * above this layer can observe what actually landed on disk. The assertion that
 * uniquely catches the regression is "the config file is byte-identical".
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { applyEcosystemPortEdits } from './appPortConfig.js';

/**
 * The shape PortOS's own config has: a served-by-API primary (`PORT` env, no
 * `ports.ui` literal), a Vite dev UI, and a SIBLING daemon pair whose `-ui`
 * process is the only `ports.ui` in the whole file. Names are placeholders; the
 * structure is what reproduces #7357.
 */
const SIBLING_UI_CONFIG = `const PORTS = {
  API: 6000,        // Example API server
  UI: 6001,         // Vite dev server
  HELPER: 6002,     // Helper daemon API
  HELPER_UI: 6003,  // Helper daemon UI
};

module.exports = {
  apps: [
    { name: 'example-server', script: 'server/index.js', env: { PORT: PORTS.API } },
    { name: 'example-ui', script: 'npm', args: 'run dev', env: { VITE_PORT: PORTS.UI } },
    { name: 'example-helper', script: 'helper/index.js', env: { PORT: PORTS.HELPER } },
    { name: 'example-helper-ui', script: 'helper/ui.js', env: { PORT: PORTS.HELPER_UI } }
  ]
};
`;

/**
 * Same defect, one sibling process instead of a pair: `admin-ui` owns the only
 * `ports.ui` and has no `admin` sibling to prove it is a separate surface.
 */
const SOLO_SIBLING_UI_CONFIG = `const PORTS = {
  API: 6000,     // Example API server
  UI: 6001,      // Vite dev server
  ADMIN: 6004,   // Standalone admin console
};

module.exports = {
  apps: [
    { name: 'example-server', script: 'server/index.js', env: { PORT: PORTS.API } },
    { name: 'example-ui', script: 'npm', args: 'run dev', env: { VITE_PORT: PORTS.UI } },
    { name: 'admin-ui', script: 'admin/index.js', env: { PORT: PORTS.ADMIN } }
  ]
};
`;

/** Two-process app with unconventional names — neither shares a surface. */
const UNCONVENTIONAL_CONFIG = `const PORTS = {
  API: 7000,
  WEBAPP: 7001,
};

module.exports = {
  apps: [
    { name: 'backend', script: 'server/index.js', env: { PORT: PORTS.API } },
    { name: 'frontend', script: 'web/index.js', env: { UI_PORT: PORTS.WEBAPP } }
  ]
};
`;

describe('applyEcosystemPortEdits', () => {
  let repoPath;

  beforeEach(async () => {
    repoPath = await mkdtemp(join(tmpdir(), 'portos-appPortConfig-'));
  });

  afterEach(async () => {
    await rm(repoPath, { recursive: true, force: true });
  });

  const writeConfig = async (content) => {
    await writeFile(join(repoPath, 'ecosystem.config.cjs'), content, 'utf-8');
    return content;
  };

  const readConfig = () => readFile(join(repoPath, 'ecosystem.config.cjs'), 'utf-8');

  it('leaves a sibling process\'s UI port untouched when the drawer echoes the derived uiPort', async () => {
    // #7357: `example-helper-ui` owns the only `ports.ui` in the file, so the
    // old first-carrier-wins resolution read uiPort as 6003, defeated the
    // served-by-API derivation, and rewrote HELPER_UI to the API server's 6000.
    const before = await writeConfig(SIBLING_UI_CONFIG);
    const existing = {
      id: 'example',
      name: 'Example',
      repoPath,
      type: 'node',
      processes: [{ name: 'example-server' }, { name: 'example-ui' }, { name: 'example-helper' }, { name: 'example-helper-ui' }],
    };

    // Exactly what EditAppModal submits on ANY save of this record (a rename,
    // an archive toggle): every port field, echoing the stored derived uiPort.
    const result = await applyEcosystemPortEdits(existing, { apiPort: 6000, uiPort: 6000, devUiPort: 6001 });

    expect(await readConfig()).toBe(before);
    expect(result.changedKeys).toEqual([]);
    // uiPort is derived (served-by-API), so it is pinned to the API port.
    expect(result.uiPortOverride).toBe(6000);
    expect(result.persistFailed).toBe(false);
  });

  it('rejects an edit that would take a port another process already holds, writing nothing', async () => {
    const before = await writeConfig(SIBLING_UI_CONFIG);
    const existing = {
      id: 'example',
      name: 'Example',
      repoPath,
      type: 'node',
      processes: [{ name: 'example-server' }, { name: 'example-ui' }],
    };

    // 6002 belongs to `example-helper`. Writing it into the dev UI port would
    // produce a correct-looking config that collides at the next PM2 restart.
    const result = await applyEcosystemPortEdits(existing, { apiPort: 6000, uiPort: 6000, devUiPort: 6002 });

    expect(await readConfig()).toBe(before);
    expect(result.portCollision).toMatchObject({ newPort: 6002, heldBy: 'example-helper' });
  });

  it('still persists a genuine port change that collides with nothing', async () => {
    // The bypass probe for the two guards above: a normal edit must still write,
    // or both assertions would be satisfied by a service that never writes.
    await writeConfig(SIBLING_UI_CONFIG);
    const existing = {
      id: 'example',
      name: 'Example',
      repoPath,
      type: 'node',
      processes: [{ name: 'example-server' }, { name: 'example-ui' }],
    };

    const result = await applyEcosystemPortEdits(existing, { apiPort: 6010, uiPort: 6000, devUiPort: 6001 });

    const after = await readConfig();
    expect(result.changedKeys).toEqual(['apiPort']);
    expect(result.persistFailed).toBe(false);
    expect(after).toContain('API: 6010,');
    // …and only the API port moved.
    expect(after).toContain('HELPER_UI: 6003,');
    expect(after).toContain('UI: 6001,');
  });


  it('picks the app\'s own surface even when the record lists sibling processes first', async () => {
    // An app record claims every process it supervises, siblings included, and
    // nothing guarantees the app's own process is listed first (a sorted list
    // puts `example-helper` before `example-server`). The primary is resolved in
    // CONFIG order for that reason — reading it from the record's order here
    // would name the helper as primary and invert the whole attribution,
    // recreating #7357.
    const before = await writeConfig(SIBLING_UI_CONFIG);
    const existing = {
      id: 'example',
      name: 'Example',
      repoPath,
      type: 'node',
      pm2ProcessNames: ['example-helper', 'example-helper-ui', 'example-server', 'example-ui'],
    };

    const result = await applyEcosystemPortEdits(existing, { apiPort: 6000, uiPort: 6000, devUiPort: 6001 });

    expect(await readConfig()).toBe(before);
    expect(result.changedKeys).toEqual([]);
    expect(result.uiPortOverride).toBe(6000);
  });

  it('ignores a single-process sibling whose name declares another surface\'s role', async () => {
    // `admin-ui` is the only `ports.ui` in the file and has no sibling of its
    // own, so a "is this surface multi-process?" test would read it as this
    // app's UI and rewrite its literal. The name itself is the evidence: it
    // declares a role on surface `admin`, which is not this app's.
    const before = await writeConfig(SOLO_SIBLING_UI_CONFIG);
    const existing = { id: 'example', name: 'Example', repoPath, type: 'node', processes: [{ name: 'example-server' }, { name: 'example-ui' }] };

    const result = await applyEcosystemPortEdits(existing, { apiPort: 6000, uiPort: 6000, devUiPort: 6001 });

    expect(await readConfig()).toBe(before);
    expect(result.changedKeys).toEqual([]);
    expect(result.uiPortOverride).toBe(6000);
  });

  it('still attributes a UI port to a process that shares no naming convention with the primary', async () => {
    // `frontend` is not on `backend`'s surface, but nothing else in the config
    // claims surface `frontend` — so it is this app's UI, not a sibling's, and a
    // real edit to it must still persist.
    await writeConfig(UNCONVENTIONAL_CONFIG);
    const existing = { id: 'example', name: 'Example', repoPath, type: 'node', processes: [{ name: 'backend' }, { name: 'frontend' }] };

    const result = await applyEcosystemPortEdits(existing, { apiPort: 7000, uiPort: 7010 });

    expect(result.changedKeys).toEqual(['uiPort']);
    // Not treated as derived — the app has a real UI port literal.
    expect(result.uiPortOverride).toBeUndefined();
    expect(await readConfig()).toContain('WEBAPP: 7010,');
  });
});
