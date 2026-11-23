/**
 * The runner's reading of what real-Chromium fixtures served (#17616): one
 * `{ roots, files }` per test, repo-relative, with every path the memo must
 * not key (outside the repository, installed packages, gone files) dropped.
 */

import { get as httpGet } from 'node:http';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SERVED_FILES_ENV, SERVED_FILES_VERSION, buildRecordedViteFixture, createRecordedStaticServer,
  readServedFiles, startRecordedViteServer,
} from './browserServedFiles.js';

describe('readServedFiles', () => {
  const temps = [];
  afterEach(() => { for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true }); });
  const tempDir = (prefix) => { const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix))); temps.push(dir); return dir; };
  const touch = (path) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, 'x\n'); };

  it('unions each test\'s fixtures and keeps only present repository files outside installs, linked ones included', () => {
    const repo = tempDir('served-repo-');
    const outside = tempDir('served-outside-');
    const records = tempDir('served-records-');
    for (const rel of ['client/src/A.browser.test.js', 'client/src/A.jsx', 'client/src/B.jsx', 'server/lib/nav.js', 'client/node_modules/react/index.js']) touch(join(repo, rel));
    touch(join(outside, 'elsewhere.js'));
    // A worktree's install is a link to the primary checkout's, so its files resolve outside the repository.
    touch(join(outside, 'primary/server/node_modules/vite/client.mjs'));
    symlinkSync(join(outside, 'primary/server/node_modules'), join(repo, 'server/node_modules'));
    // A worktree reached through a symlink still maps onto the real paths Vite reports.
    const link = join(tempDir('served-link-'), 'repo');
    symlinkSync(repo, link);
    const record = (name, value) => writeFileSync(join(records, name), JSON.stringify(value));
    const test = join(repo, 'client/src/A.browser.test.js');
    const root = join(repo, 'client');
    record('1.json', { version: SERVED_FILES_VERSION, test, root,
      files: [join(repo, 'client/src/A.jsx'), join(repo, 'client/node_modules/react/index.js'), join(repo, 'server/node_modules/vite/client.mjs'),
        join(outside, 'primary/server/node_modules/vite/client.mjs'), join(outside, 'gone.js'), join(repo, 'client/src/Gone.jsx')] });
    record('2.json', { version: SERVED_FILES_VERSION, test, root, files: [join(repo, 'client/src/B.jsx'), join(repo, 'server/lib/nav.js'), 'relative/path.js'] });
    // Ignored: another format, a test outside the repository, the repository root as the root, unreadable JSON.
    record('3.json', { version: SERVED_FILES_VERSION + 1, test, root, files: [join(repo, 'client/src/Gone.jsx')] });
    record('4.json', { version: SERVED_FILES_VERSION, test: join(outside, 'elsewhere.js'), root, files: [] });
    record('5.json', { version: SERVED_FILES_VERSION, test, root: repo, files: [join(repo, 'server/lib/nav.js')] });
    writeFileSync(join(records, '6.json'), '{ torn');

    expect(readServedFiles(records, link)).toEqual(new Map([['client/src/A.browser.test.js', {
      roots: ['client'], files: ['client/src/A.jsx', 'client/src/B.jsx', 'server/lib/nav.js'],
    }]]));
    expect(readServedFiles(null, repo)).toEqual(new Map());
    // A served file outside the repository that is no installed package cannot be keyed: no record for that test.
    record('7.json', { version: SERVED_FILES_VERSION, test, root, files: [join(outside, 'elsewhere.js')] });
    expect(readServedFiles(records, repo)).toEqual(new Map());
    expect(readServedFiles(join(records, 'missing'), repo)).toEqual(new Map());
  });
});

describe('instrumented Vite and Express served-file helpers (#17894)', () => {
  const temps = [];
  afterEach(() => { for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true }); });
  const tempDir = (prefix) => { const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix))); temps.push(dir); return dir; };
  const touch = (path, content = 'x\n') => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content); };

  it('buildRecordedViteFixture records loaded/transformed modules and copied publicDir assets while ignoring temp staging files', async () => {
    const repo = tempDir('build-repo-');
    const staging = tempDir('build-staging-');
    const records = tempDir('build-records-');
    const testFile = join(repo, 'server/services/example.browser.test.js');
    const client = join(repo, 'client');
    const publicDir = join(client, 'public');
    touch(testFile);
    touch(join(client, 'src/Widget.jsx'));
    touch(join(client, 'src/Unrelated.jsx'));
    touch(join(publicDir, 'fonts/Inter.woff2'));
    touch(join(publicDir, 'logo.svg'));
    touch(join(staging, 'entry.jsx'));

    const build = vi.fn(async (cfg) => {
      const plugin = cfg.plugins.flat().at(-1);
      if (typeof plugin?.load === 'function') {
        plugin.load(`${join(staging, 'entry.jsx')}?import`);
        plugin.load(`${join(client, 'src/Widget.jsx')}?v=1`);
        plugin.transform('', '\0virtual:entry');
      }
      return { output: [] };
    });

    // Disabled when SERVED_FILES_ENV is unset: passes config.plugins untouched and writes nothing.
    await buildRecordedViteFixture({
      build, recordedRoot: client, temp: staging, env: {}, testFile,
      config: { configFile: false, root: staging, publicDir, plugins: ['react'], build: { outDir: join(staging, 'dist') } },
    });
    expect(build.mock.calls[0][0].plugins).toEqual(['react']);
    expect(readdirSync(records)).toEqual([]);

    // Enabled: records repo modules + copied publicDir assets under both client and client/public, ignoring staging.
    const env = { [SERVED_FILES_ENV]: records };
    await buildRecordedViteFixture({
      build, recordedRoot: client, temp: staging, env, testFile,
      config: { configFile: false, root: staging, publicDir, plugins: ['react'], build: { outDir: join(staging, 'dist') } },
    });
    expect(readServedFiles(records, repo)).toEqual(new Map([
      ['server/services/example.browser.test.js', {
        roots: ['client', 'client/public'],
        files: ['client/public/fonts/Inter.woff2', 'client/public/logo.svg', 'client/src/Widget.jsx'],
      }],
    ]));

    // A failed build writes no record.
    const failingRecords = tempDir('build-fail-records-');
    const failingBuild = vi.fn(async () => { throw new Error('boom'); });
    await expect(buildRecordedViteFixture({
      build: failingBuild, recordedRoot: client, temp: staging, env: { [SERVED_FILES_ENV]: failingRecords }, testFile,
      config: { configFile: false, root: staging, publicDir, plugins: ['react'] },
    })).rejects.toThrow('boom');
    expect(readdirSync(failingRecords)).toEqual([]);
  });

  it('startRecordedViteServer attaches the recorder, ignores cacheDir, writes once on close, and closes on listen failure', async () => {
    const repo = tempDir('vite-repo-');
    const cacheDir = tempDir('vite-cache-');
    const records = tempDir('vite-records-');
    const testFile = join(repo, 'server/services/greybox.browser.test.js');
    const client = join(repo, 'client');
    touch(testFile);
    touch(join(client, 'src/Capture.jsx'));
    touch(join(cacheDir, 'deps/three.js'));

    const close = vi.fn(async () => {});
    const listen = vi.fn(async () => {});
    const createServer = vi.fn(async (cfg) => {
      const plugin = cfg.plugins.flat().at(-1);
      plugin.load(join(client, 'src/Capture.jsx'));
      plugin.load(join(cacheDir, 'deps/three.js'));
      return { listen, close, resolvedUrls: { local: ['http://127.0.0.1:1234/'] } };
    });

    const server = await startRecordedViteServer({
      createServer, temp: cacheDir, env: { [SERVED_FILES_ENV]: records }, testFile,
      config: { configFile: false, root: client, cacheDir, plugins: ['react'] },
    });
    expect(listen).toHaveBeenCalledTimes(1);
    expect(readdirSync(records)).toEqual([]);

    await server.close();
    await server.close();
    expect(close).toHaveBeenCalledTimes(2);
    expect(readdirSync(records)).toHaveLength(1);
    expect(readServedFiles(records, repo)).toEqual(new Map([
      ['server/services/greybox.browser.test.js', { roots: ['client'], files: ['client/src/Capture.jsx'] }],
    ]));

    // Listen failure cleans up the Vite server without writing a record.
    const failRecords = tempDir('vite-fail-records-');
    const failClose = vi.fn(async () => {});
    const failCreate = vi.fn(async () => ({ listen: async () => { throw new Error('EADDRINUSE'); }, close: failClose }));
    await expect(startRecordedViteServer({
      createServer: failCreate, env: { [SERVED_FILES_ENV]: failRecords }, testFile,
      config: { configFile: false, root: client, plugins: [] },
    })).rejects.toThrow('EADDRINUSE');
    expect(failClose).toHaveBeenCalledTimes(1);
    expect(readdirSync(failRecords)).toEqual([]);
  });

  it('createRecordedStaticServer records only requested files per mounted root and flushes on server close', async () => {
    const repo = tempDir('static-repo-');
    const dist = tempDir('static-dist-');
    const records = tempDir('static-records-');
    const testFile = join(repo, 'server/routes/review.browser.test.js');
    const fontsDir = join(repo, 'client/public/fonts');
    const engineDir = join(repo, 'server/lib/engine');
    touch(testFile);
    touch(join(fontsDir, 'Inter.woff2'), 'font-bytes');
    touch(join(fontsDir, 'Unused.woff2'), 'unused-font');
    touch(join(engineDir, 'index.html'), '<html>ok</html>');
    touch(join(dist, 'index.html'), '<html>app</html>');

    const app = express();
    const staticFiles = createRecordedStaticServer(express, { env: { [SERVED_FILES_ENV]: records }, testFile });
    app.use('/fonts', staticFiles.serve(fontsDir));
    app.use('/engine', staticFiles.serve(engineDir));
    app.use(staticFiles.serve(dist));
    const server = await staticFiles.start(app);
    const base = `http://127.0.0.1:${server.address().port}`;
    const fetchPath = (path) => new Promise((done, fail) => {
      httpGet(`${base}${path}`, (res) => { res.resume(); res.on('end', () => done(res.statusCode)); }).on('error', fail);
    });
    try {
      expect(await fetchPath('/fonts/Inter.woff2')).toBe(200);
      expect(await fetchPath('/fonts/missing.woff2')).toBe(404);
      expect(await fetchPath('/engine/')).toBe(200);
      expect(await fetchPath('/')).toBe(200);
    } finally {
      await new Promise((done, reject) => server.close((err) => (err ? reject(err) : done())));
    }

    // Temp dist mount is outside the repo and skipped by readServedFiles without poisoning repo mounts.
    expect(readServedFiles(records, repo)).toEqual(new Map([
      ['server/routes/review.browser.test.js', {
        roots: ['client/public/fonts', 'server/lib/engine'],
        files: ['client/public/fonts/Inter.woff2', 'server/lib/engine/index.html'],
      }],
    ]));
  });
});
