// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { brotliCompressSync, gzipSync } from 'node:zlib';
import { build } from 'vite';
import { describe, expect, it, vi } from 'vitest';
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

  it('writes compressed sizes for the emitted HTML and JS when analysis is enabled', async () => {
    const root = mkdtempSync(resolve(tmpdir(), 'portos-bundle-report-'));
    const outDir = resolve(root, 'dist');
    vi.stubEnv('ANALYZE', 'true');
    try {
      writeFileSync(resolve(root, 'index.html'), '<meta charset="utf-8"><script type="module" src="/entry.js"></script>');
      writeFileSync(resolve(root, 'entry.js'), 'document.body.textContent = "café";');
      await build({
        root,
        configFile: resolve(CLIENT_DIR, 'vite.config.js'),
        configLoader: 'native',
        logLevel: 'error',
        build: { outDir },
      });

      const report = JSON.parse(readFileSync(resolve(outDir, 'bundle-report.json'), 'utf8'));
      expect(report.map(({ fileName }) => fileName)).toEqual([expect.stringMatching(/^assets\/index-.*\.js$/), 'index.html']);
      for (const file of report) {
        const bytes = readFileSync(resolve(outDir, file.fileName));
        expect(file).toEqual({
          fileName: file.fileName,
          rawBytes: bytes.length,
          gzipBytes: gzipSync(bytes).length,
          brotliBytes: brotliCompressSync(bytes).length,
        });
      }
    } finally {
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
