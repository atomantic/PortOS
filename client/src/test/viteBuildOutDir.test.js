// @vitest-environment node
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import viteConfig, { resolveBuildOutDir } from '../../vite.config.js';

const CLIENT_DIR = resolve(import.meta.dirname, '../..');

describe('Vite build output directory', () => {
  it('never defaults to the live client/dist', () => {
    const dir = resolveBuildOutDir({}, CLIENT_DIR);
    expect(dir).toBe(resolve(CLIENT_DIR, '.dist-adhoc'));
    expect(dir).not.toBe(resolve(CLIENT_DIR, 'dist'));
  });

  it('redirects all output to PORTOS_CLIENT_BUILD_OUT_DIR when set', () => {
    expect(resolveBuildOutDir({ PORTOS_CLIENT_BUILD_OUT_DIR: '/scratch/stage' }, CLIENT_DIR)).toBe('/scratch/stage');
  });

  it('wires the resolved directory into build.outDir', () => {
    const config = viteConfig({ command: 'build', mode: 'production' });
    expect(config.build.outDir).toBe(resolveBuildOutDir(process.env, CLIENT_DIR));
  });
});
