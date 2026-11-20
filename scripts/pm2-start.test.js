import { describe, expect, it, vi } from 'vitest';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { appsNeedingStart, startProductionApps } from './pm2-start.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const root = join(repoRoot, 'fixture-root');
const apps = ['portos-server', 'portos-cos'];
const proc = (name, status = 'online', execPath = join(root, 'server', 'start.js')) => ({
  name,
  pm2_env: { status, pm_exec_path: execPath },
});

describe('appsNeedingStart', () => {
  it('reports nothing to start when every app is online from this checkout', () => {
    const { missing } = appsNeedingStart({ processes: apps.map((name) => proc(name)), expectedApps: apps, root });
    expect(missing).toEqual([]);
  });

  it('flags apps that are unregistered, down, or launched from another checkout', () => {
    const { missing, reasons } = appsNeedingStart({
      processes: [proc('portos-server', 'stopped'), proc('portos-cos', 'online', join(repoRoot, '..', 'elsewhere', 'cos.js'))],
      expectedApps: [...apps, 'portos-browser'],
      root,
    });
    expect(missing).toEqual(['portos-server', 'portos-cos', 'portos-browser']);
    expect(reasons).toEqual([
      'portos-server is stopped',
      'portos-cos runs from a different checkout',
      'portos-browser is not registered',
    ]);
  });

  it('does not treat a sibling directory sharing the root prefix as inside the checkout', () => {
    const { missing } = appsNeedingStart({
      processes: [proc('portos-server', 'online', `${root}-other${join('/server', 'start.js')}`)],
      expectedApps: ['portos-server'],
      root,
    });
    expect(missing).toEqual(['portos-server']);
  });
});

describe('production PM2 startup', () => {
  const monitor = 'portos-autofixer';
  const expectedApps = [...apps, monitor, 'portos-browser'];
  const production = port => expectedApps.map(name => name === monitor
    ? {
      name,
      pm2_env: { status: 'online', pm_exec_path: join(root, 'autofixer', 'server.js'), env: { PORT: port } },
    }
    : proc(name));
  const legacyDashboard = (checkout, id) => ({
    ...proc('portos-autofixer-ui', 'online', join(checkout, 'autofixer', 'ui.js')),
    pm_id: id,
  });
  const foreignDashboard = legacyDashboard(join(repoRoot, 'other-checkout'), 12);
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

  it('recovers a legacy monitor after the retired dashboard was already removed', async () => {
    const { pm2, start } = setup([...production('5559'), foreignDashboard]);
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

  it('refuses to restart by name when a second monitor belongs to another checkout', async () => {
    const foreignMonitor = proc(monitor, 'online', join(repoRoot, 'other-checkout', 'autofixer', 'server.js'));
    const { pm2, start } = setup([foreignMonitor, ...production(5559), legacyDashboard(root, 0)]);
    await expect(start()).rejects.toThrow('Multiple PM2 Autofixer monitors');
    expect(pm2).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', production(5559).filter(({ name }) => name !== 'portos-cos')],
    ['stopped', [...production(5559).filter(({ name }) => name !== 'portos-cos'), proc('portos-cos', 'stopped')]],
  ])('runs full recovery when a production service is %s', async (_case, before) => {
    const { pm2, start } = setup([...before, foreignDashboard, legacyDashboard(root, 7)]);
    await start();
    expect(pm2.mock.calls).toEqual([
      ['delete', '7'],
      ['delete', 'ecosystem.config.cjs', '--silent'],
      ['start', 'ecosystem.config.cjs', '--only', expectedApps.join(',')],
      ['save'],
    ]);
  });
});
