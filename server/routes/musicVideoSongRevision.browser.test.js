/** Real UI, HTTP persistence and sockets; Suno only is a test double. */
import { afterAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { Server } from 'socket.io';
import { existsSync } from 'node:fs';
import { mkdir, writeFile, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { chromium } from 'playwright-core';
import { makePathsProxy, lazyTempDataRoot, cleanupTempDataRoots } from '../lib/mockPathsDataRoot.js';
import { errorMiddleware } from '../lib/errorHandler.js';
vi.mock('../lib/paths.js', async original => makePathsProxy(await original(), { dataRoot: () => lazyTempDataRoot('mv-song-browser-') }));
vi.mock('../services/settings.js', () => ({ getSettings: async () => ({}) }));
const { PATHS } = await import('../lib/paths.js');
const { default: router } = await import('./musicVideo.js');
const store = await import('../services/musicVideo/projects.js');
const songs = await import('../services/musicVideo/songRevision.js');
const { musicVideoEvents } = await import('../services/musicVideo/events.js');
const { _testChromeCaptureArgs, _waitForTestChrome, _cleanupTestBrowser } = await import('../services/htmlComposition/testBrowserCleanup.js');
const chrome = [process.env.CHROME_PATH, chromium.executablePath(), '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome'].find(p => p && existsSync(p));
const client = resolve(import.meta.dirname, '../../client');
const requireClient = createRequire(join(client, 'package.json'));
let bundler;
try { bundler = ['vite', '@vitejs/plugin-react', '@tailwindcss/postcss'].map(name => requireClient.resolve(name)); }
catch (err) { if (err.code !== 'MODULE_NOT_FOUND') throw err; }
let browser, proc, server, io;
const broadcast = event => io.emit('music-video:song-revision', event);
afterAll(async () => {
  musicVideoEvents.off('song-revision', broadcast);
  await songs.__testing.settle(); songs.__setSongRevisionDepsForTests();
  await _cleanupTestBrowser({ browser, proc, cleanup: () => {} });
  if (io) await new Promise(resolve => io.close(resolve));
  else if (server) await new Promise(resolve => server.close(resolve));
  cleanupTempDataRoots();
});

describe.skipIf(!chrome || !bundler)('song revision in Chrome (client dependencies required)', () => {
  it('forks, edits, generates, listens and selects without altering the previous version', async () => {
    await mkdir(PATHS.music, { recursive: true });
    const wav = Buffer.alloc(44 + 32000);
    wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
    wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28);
    wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(32000, 40);
    for (let i = 0; i < 16000; i++) wav.writeInt16LE(Math.round(Math.sin(i * Math.PI * 440 / 16000) * 1000), 44 + i * 2);
    await writeFile(join(PATHS.music, 'synthetic.wav'), wav);
    const original = await store.createProject({ name: 'Example film', uploadedAudioFilename: 'original.wav', composition: { mode: 'code' } });
    await store.updateProject(original.id, { lyricCues: [{ id: 'line', text: 'Old lyric' }] });
    const before = await store.getProject(original.id);
    let creates = 0;
    songs.__setSongRevisionDepsForTests({ generate: async (_fields, opts) => {
      if (!opts.songIds) { creates++; await opts.onSubmitted(['candidate-a', 'candidate-b']); }
      return { songId: opts.songIds?.[0] || 'candidate-b', filename: 'synthetic.wav' };
    } });
    const ui = join(PATHS.data, 'ui'); await mkdir(ui, { recursive: true });
    await symlink(join(client, 'node_modules'), join(ui, 'node_modules'), 'dir');
    const entry = `import React,{useState} from 'react';import{createRoot}from'react-dom/client';import{BrowserRouter,useNavigate}from'react-router';import Panel from '${client}/src/components/musicVideo/SongRevisionPanel.jsx';import{cloneMusicVideoProject}from'${client}/src/services/apiMusicVideo.js';function App(){const[p,setP]=useState(${JSON.stringify(before)});const nav=useNavigate();return <main style={{maxWidth:1000,margin:'auto',padding:20}}><Panel key={p.id} project={p} onUpdated={setP} onFork={()=>cloneMusicVideoProject(p.id).then(next=>{setP(next);nav('/music-video/'+next.id+'/setup')})}/></main>}createRoot(document.getElementById('root')).render(<BrowserRouter><App/></BrowserRouter>);`;
    await writeFile(join(ui, 'entry.jsx'), `import ${JSON.stringify(join(client, 'src/index.css'))};\n` + entry);
    await writeFile(join(ui, 'index.html'), '<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/entry.jsx"></script></body></html>');
    const { build } = await import(bundler[0]); const { default: react } = await import(bundler[1]); const { default: tailwind } = await import(bundler[2]);
    await build({ configFile: false, root: ui, plugins: [react()], css: { postcss: { plugins: [tailwind({ base: client })] } }, build: { outDir: join(ui, 'dist') }, logLevel: 'warn' });
    const app = express(); app.use(express.json()); app.use('/api/music-video', router); app.use('/data/music', express.static(PATHS.music)); app.use(express.static(join(ui, 'dist'))); app.use(errorMiddleware);
    server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
    io = new Server(server); musicVideoEvents.on('song-revision', broadcast);
    proc = spawn(chrome, _testChromeCaptureArgs(join(PATHS.data, 'chrome')), { stdio: ['ignore', 'ignore', 'pipe'] });
    browser = await chromium.connectOverCDP(await _waitForTestChrome(proc));
    const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.getByRole('button', { name: 'Fork & revise song' }).click();
    await page.getByLabel('Suno musical style').fill('Bright synth pop');
    await page.getByLabel('Revision lyrics').fill('[Verse]\nNew lyric');
    await page.getByRole('button', { name: 'Save song draft' }).click();
    await page.getByText('Song revision: draft', { exact: true }).waitFor(); expect(creates).toBe(0);
    await page.getByRole('button', { name: 'Generate with Suno — uses credits' }).click();
    await page.getByText('Song revision: review', { exact: true }).waitFor();
    expect(await page.getByRole('button', { name: 'Use candidate 1' }).isDisabled()).toBe(true);
    await page.getByLabel('Listen to candidate 1').evaluate(audio => audio.play());
    await page.getByRole('button', { name: 'Use candidate 1' }).click();
    await page.getByText('Song revision: selected', { exact: true }).waitFor(); expect(creates).toBe(1);
    const selected = await store.getProject(new URL(page.url()).pathname.split('/')[2]);
    expect(selected).toMatchObject({ uploadedAudioFilename: 'synthetic.wav', audioAnalysis: null, trackId: null });
    expect(selected.lyricCues[0].text).toBe('New lyric'); expect(await store.getProject(original.id)).toEqual(before);
    for (const width of [1000, 360]) {
      await page.setViewportSize({ width, height: 900 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
    expect(errors).toEqual([]);
  }, 60000);
});
