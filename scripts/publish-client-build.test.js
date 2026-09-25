import { createRequire } from 'node:module';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  cleanAbandonedStages,
  publishClientBuild,
  validateStagedBuild,
} from './publish-client-build.js';

const requireFromServer = createRequire(new URL('../server/package.json', import.meta.url));
const express = requireFromServer('express');

function writeBuild(directory, name) {
  mkdirSync(join(directory, 'assets'), { recursive: true });
  writeFileSync(join(directory, 'index.html'), `<!doctype html><script type="module" src="/assets/${name}.js"></script>`);
  writeFileSync(join(directory, 'assets', `${name}.js`), `window.BUILD = '${name}';`);
}

describe('staged client build publication', () => {
  let root;
  let clientDir;
  let distDir;
  let server;
  let baseUrl;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'portos-client-publish-'));
    clientDir = join(root, 'client');
    distDir = join(clientDir, 'dist');
    writeBuild(distDir, 'old');

    const app = express();
    app.use('/assets', express.static(join(distDir, 'assets')));
    app.use(express.static(distDir, { index: false }));
    app.use((req, res) => res.sendFile(join(distDir, 'index.html')));
    server = await new Promise((resolvePromise) => {
      const listening = app.listen(0, '127.0.0.1', () => resolvePromise(listening));
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  afterEach(async () => {
    if (server) await new Promise((resolvePromise) => server.close(resolvePromise));
    rmSync(root, { recursive: true, force: true });
  });

  it('keeps the previous page and chunks served until every new chunk is published', async () => {
    const oldChunk = join(distDir, 'assets', 'old.js');
    const oldChunkMtime = statSync(oldChunk).mtimeMs;
    await publishClientBuild({
      clientDir,
      distDir,
      runBuild: async (stageDir) => {
        writeBuild(stageDir, 'new');
        writeFileSync(join(stageDir, 'assets', 'old.js'), "window.BUILD = 'old';");
        expect(await fetch(baseUrl).then((response) => response.text())).toContain('/assets/old.js');
        expect(await fetch(`${baseUrl}/assets/old.js`).then((response) => response.text())).toContain("'old'");
      },
      beforeIndexPublish: () => {
        expect(readFileSync(join(distDir, 'index.html'), 'utf8')).toContain('/assets/old.js');
        expect(readFileSync(join(distDir, 'assets', 'new.js'), 'utf8')).toContain("'new'");
        expect(statSync(oldChunk).mtimeMs).toBe(oldChunkMtime);
      },
    });

    expect(await fetch(baseUrl).then((response) => response.text())).toContain('/assets/new.js');
    expect(await fetch(`${baseUrl}/assets/new.js`).then((response) => response.text())).toContain("'new'");
    expect(await fetch(`${baseUrl}/assets/old.js`).then((response) => response.text())).toContain("'old'");
  });

  it('keeps a shared old chunk intact when publication fails before the index switch', async () => {
    const oldChunk = join(distDir, 'assets', 'old.js');
    const oldChunkMtime = statSync(oldChunk).mtimeMs;
    await expect(publishClientBuild({
      clientDir,
      distDir,
      runBuild: async (stageDir) => {
        writeBuild(stageDir, 'new');
        writeFileSync(join(stageDir, 'assets', 'old.js'), "window.BUILD = 'old';");
      },
      beforeIndexPublish: () => {
        throw new Error('injected publication failure');
      },
    })).rejects.toThrow('injected publication failure');

    expect(await fetch(baseUrl).then((response) => response.text())).toContain('/assets/old.js');
    expect(await fetch(`${baseUrl}/assets/old.js`).then((response) => response.text())).toContain("'old'");
    expect(statSync(oldChunk).mtimeMs).toBe(oldChunkMtime);
  });

  it('leaves the complete previous build served when rendering fails', async () => {
    await expect(publishClientBuild({
      clientDir,
      distDir,
      runBuild: async (stageDir) => {
        writeBuild(stageDir, 'broken');
        expect(await fetch(baseUrl).then((response) => response.text())).toContain('/assets/old.js');
        throw new Error('injected render failure');
      },
    })).rejects.toThrow('injected render failure');

    expect(await fetch(baseUrl).then((response) => response.text())).toContain('/assets/old.js');
    expect(await fetch(`${baseUrl}/assets/old.js`).then((response) => response.text())).toContain("'old'");
    expect(readFileSync(join(distDir, 'index.html'), 'utf8')).toContain('/assets/old.js');
    expect(readdirSync(clientDir).filter((name) => name.startsWith('.dist-stage-'))).toEqual([]);
  });

  it('keeps the newest three builds and gives unreferenced assets a 24-hour grace period', async () => {
    for (let index = 0; index < 3; index += 1) {
      await publishClientBuild({
        clientDir,
        distDir,
        runBuild: async (stageDir) => writeBuild(stageDir, `build-${index}`),
      });
      const asset = join(distDir, 'assets', `build-${index}.js`);
      if (index === 0) {
        const oldSeconds = (Date.now() - 25 * 60 * 60 * 1000) / 1000;
        utimesSync(asset, oldSeconds, oldSeconds);
      }
    }

    const youngOrphan = join(distDir, 'assets', 'young-orphan.js');
    const oldOrphan = join(distDir, 'assets', 'old-orphan.js');
    writeFileSync(youngOrphan, 'young');
    writeFileSync(oldOrphan, 'old');
    const oldSeconds = (Date.now() - 25 * 60 * 60 * 1000) / 1000;
    utimesSync(oldOrphan, oldSeconds, oldSeconds);

    // The fourth publish prunes against the previous three build records.
    await publishClientBuild({ clientDir, distDir, runBuild: async (stageDir) => writeBuild(stageDir, 'build-3') });

    expect(() => statSync(join(distDir, 'assets', 'build-0.js'))).toThrow();
    for (const index of [1, 2, 3]) expect(statSync(join(distDir, 'assets', `build-${index}.js`)).isFile()).toBe(true);
    expect(statSync(youngOrphan).isFile()).toBe(true);
    expect(() => statSync(oldOrphan)).toThrow();
    const builds = JSON.parse(readFileSync(join(distDir, '.published-builds.json'), 'utf8'));
    expect(builds).toHaveLength(3);
    expect(builds.flatMap((build) => build.assets)).toEqual(expect.arrayContaining([
      'assets/build-1.js', 'assets/build-2.js', 'assets/build-3.js',
    ]));
  });

  it('does not fail a successful publish when pruning throws', async () => {
    await publishClientBuild({
      clientDir,
      distDir,
      runBuild: async (stageDir) => writeBuild(stageDir, 'published-before-prune-failure'),
      pruneAssets: () => { throw new Error('injected prune failure'); },
    });

    expect(readFileSync(join(distDir, 'index.html'), 'utf8')).toContain('/assets/published-before-prune-failure.js');
    expect(statSync(join(distDir, 'assets', 'published-before-prune-failure.js')).isFile()).toBe(true);
  });

  it('retains assets from overlapping publishes in the manifest', async () => {
    await Promise.all(['overlap-a', 'overlap-b'].map((name) => publishClientBuild({
      clientDir,
      distDir,
      runBuild: async (stageDir) => {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
        writeBuild(stageDir, name);
      },
    })));

    const builds = JSON.parse(readFileSync(join(distDir, '.published-builds.json'), 'utf8'));
    const retained = new Set(builds.flatMap((build) => build.assets));
    expect(retained.has('assets/overlap-a.js')).toBe(true);
    expect(retained.has('assets/overlap-b.js')).toBe(true);
    expect(statSync(join(distDir, 'assets', 'overlap-a.js')).isFile()).toBe(true);
    expect(statSync(join(distDir, 'assets', 'overlap-b.js')).isFile()).toBe(true);
  });

  it('rejects a staged index with a missing local asset before publication', async () => {
    await expect(publishClientBuild({
      clientDir,
      distDir,
      runBuild: async (stageDir) => {
        mkdirSync(stageDir, { recursive: true });
        writeFileSync(join(stageDir, 'index.html'), '<script src="/assets/missing.js"></script>');
      },
    })).rejects.toThrow('missing staged asset');

    expect(readFileSync(join(distDir, 'index.html'), 'utf8')).toContain('/assets/old.js');
  });

  it('validates local boot assets while allowing external references', () => {
    const stageDir = join(clientDir, '.fixture');
    writeBuild(stageDir, 'valid');
    writeFileSync(
      join(stageDir, 'index.html'),
      '<link href="https://example.com/font.css"><script src="/assets/valid.js"></script>',
    );
    expect(validateStagedBuild(stageDir).references).toEqual([
      'https://example.com/font.css',
      '/assets/valid.js',
    ]);
  });

  it('removes abandoned stage directories without touching a recent build', () => {
    const stale = join(clientDir, '.dist-stage-stale');
    const recent = join(clientDir, '.dist-stage-recent');
    mkdirSync(stale);
    mkdirSync(recent);
    const now = Date.now();
    const oldSeconds = (now - 25 * 60 * 60 * 1000) / 1000;
    utimesSync(stale, oldSeconds, oldSeconds);

    cleanAbandonedStages(clientDir, now);

    expect(() => statSync(stale)).toThrow();
    expect(statSync(recent).isDirectory()).toBe(true);
  });
});
