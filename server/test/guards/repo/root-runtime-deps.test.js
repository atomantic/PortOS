import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { PM2_BIN_PATH } from '../../../../scripts/lib/pm2Resolve.js';

const rootManifest = JSON.parse(readFileSync(new URL('../../../../package.json', import.meta.url)));
const serverManifest = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url)));

it('runs root PM2 commands using the server production dependency (#3454, #19460)', () => {
  expect(rootManifest.dependencies).toBeUndefined();
  expect(rootManifest.devDependencies).toBeUndefined();
  expect(rootManifest.overrides).toBeUndefined();
  expect(Object.values(rootManifest.scripts).join('\n')).not.toMatch(/\.\/node_modules\//);
  expect(serverManifest.dependencies.pm2).toMatch(/^\d+\.\d+\.\d+$/);
  const names = Object.keys(rootManifest.scripts).filter(name => name.startsWith('pm2:'));
  expect(names).toContain('pm2:start');
  for (const name of [...names, 'dev:stop']) {
    expect(rootManifest.scripts[name]).toContain(`node ./${PM2_BIN_PATH}`);
  }
});
