import { afterAll, describe, expect, it, vi } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';
import { installUpdateTestSupervisor } from '../../scripts/lib/updateTestSupervisor.js';

vi.mock('../lib/paths.js', async original => makePathsProxy(await original(), {
  dataRoot: () => join(lazyTempDataRoot('update-service-'), 'data'),
  extraOverrides: data => ({ root: dirname(data), installRoot: dirname(data) }),
}));
vi.mock('./updateChecker.js', () => ({ recordUpdateResult: vi.fn(async () => {}), getCurrentVersion: vi.fn(async () => '0.0.0') }));
const { PATHS } = await import('../lib/paths.js');
const { createMaintenanceAdmission } = await import('../lib/maintenanceAdmission.js');
const { launchUpdate } = await import('./updateExecutor.js');
afterAll(cleanupTempDataRoots);

describe.skipIf(process.platform === 'win32')('service launch through the real detached supervisor', () => {
  it('replaces a prior waiting owner, refuses duplicate reuse, and waits for a racing render to save', async () => {
    installUpdateTestSupervisor(PATHS.root);
    const source = await readFile(new URL('../../update.sh', import.meta.url), 'utf8');
    const header = source.slice(0, source.indexOf('mkdir -p "$ROOT_DIR/data"'));
    await writeFile(join(PATHS.root, 'update.sh'), `${header}\ntouch applied\nnode scripts/deferred-update.mjs --terminal "$PORTOS_DEFERRED_UPDATE_ID" "$$" 0\n`);
    const admission = createMaintenanceAdmission(PATHS.data);
    const render = admission.admit('render:example', 'project-example');
    const previous = admission.deferredUpdate.request();
    const launch = await launchUpdate('v0.0.0', vi.fn(), { admission });
    expect(launch.started).toBe(true);
    try {
    await vi.waitFor(() => expect(admission.deferredUpdate.operation()?.phase).toBe('waiting'), { timeout: 10000 });
    expect(admission.deferredUpdate.operation().id).not.toBe(previous.id);
    expect(() => admission.deferredUpdate.acquire(previous.id)).toThrow(/ownership changed/);
    expect(() => admission.deferredUpdate.finish(previous.id, false)).toThrow(/ownership changed/);
    const duplicate = await launchUpdate('v0.0.0', vi.fn(), { admission });
    expect(duplicate.started).toBe(false);
    expect(existsSync(join(PATHS.root, 'applied'))).toBe(false);
    await render.finish();
    expect(await launch.completion).toMatchObject({ success: true });
    expect(existsSync(join(PATHS.root, 'applied'))).toBe(true);
    expect(admission.held()).toBe(false);
    } finally {
      await render.finish();
      await launch.completion;
    }
  });
});
