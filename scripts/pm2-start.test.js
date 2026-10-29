import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { appsNeedingStart } from './pm2-start.js';

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

describe('npm start wiring', () => {
  it('probes before deleting the ecosystem, so a healthy install is never restarted', () => {
    const start = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).scripts.start;
    const probe = start.indexOf('scripts/pm2-start.js');
    expect(probe).toBeGreaterThan(-1);
    expect(probe).toBeLessThan(start.indexOf('pm2 delete ecosystem.config.cjs'));
    expect(start.slice(probe)).toMatch(/pm2-start\.js [^|]+ \|\| \(/);
  });
});
