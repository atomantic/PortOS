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

    for (const command of ['start', 'pm2:start', 'pm2:restart']) {
      const selection = packageScripts[command].match(/--only "([^"]+)"/);
      expect(selection?.[1].split(','), command).toEqual(productionApps);
    }
  });

  it('removes a stale Vite entry before production startup', () => {
    const start = packageScripts.start;
    expect(start.indexOf('pm2 delete ecosystem.config.cjs')).toBeGreaterThan(-1);
    expect(start.indexOf('pm2 delete ecosystem.config.cjs')).toBeLessThan(start.indexOf('pm2 start ecosystem.config.cjs'));

    for (const command of ['pm2:start', 'pm2:restart']) {
      expect(packageScripts[command].indexOf('pm2 delete portos-ui')).toBeGreaterThan(-1);
      const startAction = command === 'pm2:start' ? 'pm2 start ecosystem.config.cjs' : 'pm2 restart ecosystem.config.cjs';
      expect(packageScripts[command].indexOf('pm2 delete portos-ui')).toBeLessThan(packageScripts[command].indexOf(startAction));
      expect(packageScripts[command].indexOf('pm2 save')).toBeGreaterThan(packageScripts[command].indexOf(startAction));
    }
  });

  it('uses only production apps in both update scripts and their recovery starts', () => {
    const expectedApps = productionApps.join(',');
    const updateSh = read('update.sh');
    const shellStarts = updateSh.split('\n')
      .map((line) => line.trim())
      .filter((line) => line.includes('start ecosystem.config.cjs') && !line.startsWith('#') && !line.startsWith('log '));
    expect(updateSh).toContain(`PRODUCTION_PM2_APPS='${expectedApps}'`);
    expect(updateSh).toContain('delete portos-ui --silent || true');
    expect(shellStarts.length).toBeGreaterThanOrEqual(3);
    expect(shellStarts.every((line) => line.includes('--only "$PRODUCTION_PM2_APPS"'))).toBe(true);

    const updatePs1 = read('update.ps1');
    const powershellStarts = updatePs1.split('\n')
      .map((line) => line.trim())
      .filter((line) => line.includes('Invoke-Logged') && line.includes('start ecosystem.config.cjs'));
    expect(updatePs1).toContain(`$script:ProductionPm2Apps = '${expectedApps}'`);
    expect(updatePs1).toContain('delete portos-ui --silent');
    expect(updatePs1).toContain("@('start', $ecosystem, '--only', $script:ProductionPm2Apps)");
    expect(powershellStarts.length).toBeGreaterThanOrEqual(2);
    expect(powershellStarts.every((line) => line.includes('--only $script:ProductionPm2Apps'))).toBe(true);
  });
});
