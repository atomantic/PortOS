import { describe, expect, it, vi } from 'vitest';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { startProductionApps } from './pm2-start.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const root = join(repoRoot, 'fixture-root');
const apps = ['portos-server', 'portos-cos'];
const proc = (name, status = 'online', execPath = join(root, 'server', 'start.js'), cwd = root) => ({
  name,
  pm2_env: { status, pm_exec_path: execPath, pm_cwd: cwd },
});

describe('production PM2 startup', () => {
  const monitor = 'portos-autofixer';
  const expectedApps = [...apps, monitor, 'portos-browser'];
  const production = port => expectedApps.map(name => name === monitor
    ? {
      name,
      pm2_env: {
        status: 'online', pm_exec_path: join(root, 'autofixer', 'server.js'), pm_cwd: root, env: { PORT: port },
      },
    }
    : proc(name));
  const legacyDashboard = (checkout, id) => ({
    ...proc('portos-autofixer-ui', 'online', join(checkout, 'autofixer', 'ui.js'), checkout),
    pm_id: id,
  });
  const otherRoot = `${root}-other`;
  const foreignDashboard = legacyDashboard(otherRoot, 12);
  const vite = (checkout, id) => ({
    name: 'portos-ui',
    pm_id: id,
    pm2_env: {
      pm_cwd: join(checkout, 'client'),
      pm_exec_path: join(checkout, 'client', 'node_modules', 'vite', 'bin', 'vite.js'),
    },
  });
  const foreignBrowser = proc('portos-browser', 'stopped', join(otherRoot, 'browser', 'server.js'), otherRoot);
  const nestedRoot = join(root, 'data', 'cos', 'worktrees', 'other');
  const nestedBrowser = proc('portos-browser', 'online', join(nestedRoot, 'browser', 'server.js'), nestedRoot);
  const only = names => ['start', 'ecosystem.config.cjs', '--only', names.join(',')];
  const restart = ['restart', 'ecosystem.config.cjs', '--only', monitor];
  const setup = (before, after = production(5560)) => {
    const list = vi.fn().mockResolvedValueOnce(before).mockResolvedValue(after);
    const pm2 = vi.fn();
    return { pm2, list, start: () => startProductionApps({ expectedApps, root, list, pm2 }) };
  };

  it('deletes only the current checkout dashboard by ID, restarts only Autofixer and saves', async () => {
    const { pm2, start } = setup([...production(5559), foreignDashboard, legacyDashboard(root, 0)]);
    await start();
    expect(pm2.mock.calls).toEqual([['delete', '0'], restart, ['save']]);
  });

  it.each(['5559', undefined])('recovers a monitor with saved port %j after the dashboard was removed', async (port) => {
    const { pm2, start } = setup([...production(port), foreignDashboard]);
    await start();
    expect(pm2.mock.calls).toEqual([restart, ['save']]);
  });

  it('retires a leftover dashboard without restarting a monitor already on 5560', async () => {
    const { pm2, start } = setup([...production(5560), legacyDashboard(root, 4)]);
    await start();
    expect(pm2.mock.calls).toEqual([['delete', '4'], ['save']]);
  });

  it.each([
    ['with no legacy entries', []],
    ['with a foreign dashboard', [foreignDashboard]],
    ['with a stopped duplicate', [proc('portos-cos', 'stopped')]],
    ['with a same-name foreign entry', [foreignBrowser]],
  ])('leaves a healthy current install alone %s', async (_case, foreignEntries) => {
    const { pm2, start } = setup([...foreignEntries, ...production(5560)]);
    await start();
    expect(pm2).not.toHaveBeenCalled();
  });

  it('fails a scoped upgrade if PM2 returns success without applying the configuration', async () => {
    const { pm2, start } = setup(production(5559), production(5559));
    await expect(start()).rejects.toThrow('did not apply the combined Autofixer');
    expect(pm2.mock.calls).toEqual([restart]);
  });

  it('retries just the monitor after a failed restart followed retirement of the dashboard', async () => {
    const { pm2, list, start } = setup([...production(undefined), legacyDashboard(root, 5)]);
    list.mockResolvedValueOnce(production(undefined));
    pm2.mockImplementationOnce(() => {}).mockImplementationOnce(() => {
      throw new Error('PM2 restart failed');
    });
    await expect(start()).rejects.toThrow('PM2 restart failed');
    expect(pm2.mock.calls).toEqual([['delete', '5'], restart]);
    pm2.mockClear();
    await start();
    expect(pm2.mock.calls).toEqual([restart, ['save']]);
  });

  it('refuses to restart by name when a second monitor belongs to another checkout', async () => {
    const foreignMonitor = proc(monitor, 'online', join(otherRoot, 'autofixer', 'server.js'), otherRoot);
    const { pm2, start } = setup([foreignMonitor, ...production(5559), legacyDashboard(root, 0)]);
    await expect(start()).rejects.toThrow('Multiple PM2 entries for portos-autofixer');
    expect(pm2).not.toHaveBeenCalled();
  });

  it('starts only the missing browser and ignores a stopped duplicate of a healthy service', async () => {
    const before = production(5560).filter(({ name }) => name !== 'portos-browser');
    const { pm2, list, start } = setup([...before, proc('portos-cos', 'stopped')]);
    await start();
    expect(pm2.mock.calls).toEqual([only(['portos-browser']), ['save']]);
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('restarts only the stopped current-checkout app by PM2 ID', async () => {
    const before = production(5560).filter(({ name }) => name !== 'portos-cos');
    const { pm2, start } = setup(
      [...before, { ...proc('portos-cos', 'stopped'), pm_id: 3 }],
      [...before, { ...proc('portos-cos'), pm_id: 3 }],
    );
    await start();
    expect(pm2.mock.calls).toEqual([['restart', '3'], ['save']]);
  });

  it('starts and verifies the complete production set from an empty inventory', async () => {
    const { pm2, list, start } = setup([]);
    await start();
    expect(pm2.mock.calls).toEqual([only(expectedApps), ['save']]);
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('upgrades Autofixer and starts the missing browser without touching healthy services', async () => {
    const before = production(5559).filter(({ name }) => name !== 'portos-browser');
    const { pm2, start } = setup([...before, foreignDashboard, legacyDashboard(root, 7)]);
    await start();
    expect(pm2.mock.calls).toEqual([['delete', '7'], only(['portos-browser']), restart, ['save']]);
  });

  it('retires only this checkout’s Vite entry', async () => {
    const foreignUi = vite(otherRoot, 10);
    const { pm2, start } = setup([...production(5560), vite(root, 9), foreignUi], [...production(5560), foreignUi]);
    await start();
    expect(pm2.mock.calls).toEqual([['delete', '9'], ['save']]);
  });

  const stoppedBrowser = { ...proc('portos-browser', 'stopped'), pm_id: 6 };
  it.each([
    [[foreignBrowser], 'portos-browser runs from a different checkout'],
    [[nestedBrowser], 'portos-browser runs from a different checkout'],
    [[stoppedBrowser, foreignBrowser], 'Multiple PM2 entries for portos-browser'],
    [[{ name: 'portos-browser' }], 'Cannot verify checkout ownership for PM2 app portos-browser'],
    [[proc('portos-browser', '')], 'Cannot verify status for PM2 app portos-browser'],
    [[{ ...stoppedBrowser, pm_id: undefined }], 'portos-browser has no unique valid PM2 ID'],
  ])('validates recovery ownership before any PM2 mutation (%s)', async (entries, message) => {
    const before = production(5559).filter(({ name }) => name !== 'portos-browser');
    const { pm2, start } = setup([...before, ...entries, legacyDashboard(root, 7)]);
    await expect(start()).rejects.toThrow(message);
    expect(pm2).not.toHaveBeenCalled();
  });

  it('fails closed when PM2 cannot list its processes', async () => {
    const { pm2, list, start } = setup([]);
    list.mockReset().mockRejectedValueOnce(new Error('connection failed'));
    await expect(start()).rejects.toThrow('could not inspect PM2 (connection failed)');
    expect(pm2).not.toHaveBeenCalled();
  });

  it('rejects a malformed inventory before mutating PM2', async () => {
    const { pm2, start } = setup(null);
    await expect(start()).rejects.toThrow('could not inspect PM2 (invalid process inventory)');
    expect(pm2).not.toHaveBeenCalled();
  });

  it('does not save if PM2 fails to start selected apps', async () => {
    const { pm2, start } = setup([]);
    pm2.mockImplementationOnce(() => { throw new Error('PM2 start command failed'); });
    await expect(start()).rejects.toThrow('PM2 start command failed');
    expect(pm2.mock.calls).toEqual([only(expectedApps)]);
  });

  it('does not save if the selected app remains stopped despite PM2 success', async () => {
    const before = [...production(5560).filter(({ name }) => name !== 'portos-browser'), stoppedBrowser];
    const { pm2, start } = setup(before, [...before, { ...proc('portos-browser'), pm_id: 11 }]);
    await expect(start()).rejects.toThrow('PM2 did not bring portos-browser online from this checkout');
    expect(pm2.mock.calls).toEqual([['restart', '6']]);
  });

  it('does not save if a retired entry is still registered', async () => {
    const before = [...production(5560), legacyDashboard(root, 7)];
    const { pm2, start } = setup(before, before);
    await expect(start()).rejects.toThrow('PM2 did not retire portos-autofixer-ui');
    expect(pm2.mock.calls).toEqual([['delete', '7']]);
  });
});
