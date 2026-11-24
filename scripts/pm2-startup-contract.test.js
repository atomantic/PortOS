import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { createRequire } from 'module';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => readFileSync(join(repoRoot, file), 'utf8');
const packageScripts = JSON.parse(read('package.json')).scripts;
const ecosystem = require(join(repoRoot, 'ecosystem.config.cjs'));
const appNames = ecosystem.apps.map(({ name }) => name);
const productionApps = appNames.filter((name) => name !== 'portos-ui');

describe('PM2 startup app sets', () => {
  it('keeps Vite in the development set and out of every production package command', () => {
    const devStart = read('scripts/dev-start.js');
    const devAppsSource = devStart.match(/const DEV_PM2_APPS = \[([\s\S]*?)\];/);
    const devApps = [...(devAppsSource?.[1] ?? '').matchAll(/'([^']+)'/g)].map(([, name]) => name);

    expect(devAppsSource).not.toBeNull();
    expect(devApps).toEqual(appNames);
    expect(devApps).toContain('portos-ui');
    expect(devStart).toContain("pm2('start', ECO, '--only', DEV_PM2_APPS.join(','));");

    const productionSelection = packageScripts.start.match(/pm2-start\.js ([\w,-]+)$/);
    expect(productionSelection?.[1].split(',')).toEqual(productionApps);
    for (const command of ['pm2:start', 'pm2:restart']) {
      const selection = packageScripts[command].match(/--only "([^"]+)"/);
      expect(selection?.[1].split(','), command).toEqual(productionApps);
    }
  });

  it('lets npm start inspect PM2 before Vite retirement and keeps the explicit PM2 commands separate', () => {
    const start = packageScripts.start;
    expect(start).not.toContain('pm2 delete portos-ui');
    expect(start).toContain('node scripts/pm2-start.js');

    for (const command of ['pm2:start', 'pm2:restart']) {
      expect(packageScripts[command].indexOf('pm2 delete portos-ui')).toBeGreaterThan(-1);
      const startAction = command === 'pm2:start' ? 'pm2 start ecosystem.config.cjs' : 'pm2 restart ecosystem.config.cjs';
      expect(packageScripts[command].indexOf('pm2 delete portos-ui')).toBeLessThan(packageScripts[command].indexOf(startAction));
      expect(packageScripts[command].indexOf('pm2 save')).toBeGreaterThan(packageScripts[command].indexOf(startAction));
    }
  });

  it('directs fresh production installs to the build-producing npm start command', () => {
    const setupSh = read('setup.sh');
    const setupPs1 = read('setup.ps1');
    const shellProduction = setupSh.match(/echo "\s*Production:\s+([^"]+)"/)?.[1];
    const psProduction = setupPs1.match(/Write-Host "\s*Production:\s+"[^;]*;\s*Write-Host "([^"]+)"/)?.[1];

    expect(shellProduction).toBe('npm start');
    expect(psProduction).toBe('npm start');
    expect(setupSh).not.toContain('pm2:start');
    expect(setupPs1).not.toContain('pm2:start');
  });
});
