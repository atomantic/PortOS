// Real-browser acceptance for the bounded production stages (#9389): a synthetic
// original short is staged, rendered and measured by real Chrome, repaired into a
// new revision, and finally encoded by the real renderer and ffmpeg. PostgreSQL
// (portos_test) holds the project and run records; no provider is called.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { execFileSync, spawn } from 'node:child_process';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../../lib/mockPathsDataRoot.js';
import { findFfmpeg, findFfprobe } from '../../lib/ffmpeg.js';
import { _cleanupTestBrowser, _waitForTestChrome } from '../htmlComposition/testBrowserCleanup.js';

let endpoint;
vi.mock('../browserService.js', () => ({ cdpRequest: path => fetch(`${endpoint}${path}`) }));
vi.mock('../socket.js', () => ({ emitCodeAnimationChanged: vi.fn() }));
vi.mock('../../lib/fileUtils.js', async importOriginal => makePathsProxy(await importOriginal(), {
  dataRoot: () => lazyTempDataRoot('portos-code-animation-stages-'),
}));
vi.mock('../../lib/paths.js', async importOriginal => makePathsProxy(await importOriginal(), {
  dataRoot: () => lazyTempDataRoot('portos-code-animation-stages-'),
}));

const { checkHealth, ensureSchema, query, close } = await import('../../lib/db.js');
const { requireDbOrSkip } = await import('../../lib/dbTestGate.js');
const { createCodeAnimationPackage } = await import('../../lib/codeAnimationPackage.js');
const { createProductionProject, getProductionHistory, importProductionPackage } = await import('./projects.js');
const { startProductionStageRun } = await import('./stages.js');
const { renderComposition } = await import('../htmlComposition/index.js');
const { PATHS } = await import('../../lib/fileUtils.js');

const health = await checkHealth().catch(error => ({ connected: false, error: error.message }));
const dbReady = requireDbOrSkip('codeAnimation/stages.realBrowser.db.test', health.connected, health.error);
if (dbReady) await ensureSchema();

const chrome = [process.env.CHROME_PATH, chromium.executablePath(),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].find(path => path && existsSync(path));
const ffmpeg = await findFfmpeg();
const ffprobe = await findFfprobe();

const FILM = motion => `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0">
<canvas id="film" width="1280" height="720"></canvas><script>
window.ANIMATION_META = { title: 'Original short', duration: 2, fps: 12, width: 1280, height: 720 };
const MOVE = ${motion};
window.renderFrame = (t) => {
  const context = document.getElementById('film').getContext('2d');
  context.fillStyle = '#223'; context.fillRect(0, 0, 1280, 720);
  context.fillStyle = '#fc3'; context.fillRect(20 + (MOVE ? t * 200 : 0), 120, 80, 80);
};
</script></body></html>`;
const manifest = {
  title: 'Original short', brief: { concept: 'A square slides across a dark field.', cast: '', onScreenText: '' },
  styleGuide: 'Flat shapes', renderer: { kind: 'browser', version: 'synthetic-v1', engine: null },
  format: { width: 1280, height: 720, fps: 12, durationSeconds: 2 }, seed: 1,
  entrypoints: [{ role: 'preview', path: 'index.html' }], assets: [], shots: [], events: [],
  audio: { kind: 'silence' }, execution: { requested: null, effective: null },
};

let proc;
let browser;
let projectId;

describe.skipIf(!dbReady || !chrome || !ffmpeg || !ffprobe)('Production stages with real Chrome and ffmpeg', () => {
  beforeAll(async () => {
    const profile = join(lazyTempDataRoot('portos-code-animation-stages-'), 'chrome-test-profile');
    proc = spawn(chrome, ['--headless=new', '--no-sandbox', '--no-first-run', '--disable-background-networking', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
    try {
      const ws = await _waitForTestChrome(proc);
      endpoint = new URL(ws).origin.replace('ws:', 'http:');
      browser = await chromium.connectOverCDP(endpoint);
    } catch (error) {
      await _cleanupTestBrowser({ browser, proc, cleanup: cleanupTempDataRoots });
      proc = undefined;
      throw error;
    }
  }, 30000);

  afterAll(async () => {
    if (projectId) await query('DELETE FROM code_animation_projects WHERE id = $1', [projectId]);
    await _cleanupTestBrowser({ browser, proc, cleanup: cleanupTempDataRoots });
    await close();
  });

  it('turns a frozen original into measured findings, a repaired revision and a real MP4, with a real style frame and pilot', async () => {
    projectId = (await createProductionProject({ manifest })).id;
    await importProductionPackage(projectId, createCodeAnimationPackage(manifest, [{ path: 'index.html', content: FILM(false) }]));
    const repair = vi.fn(async ({ files, entryPath }) => ({
      files: [{ path: entryPath, content: files.find(file => file.path === entryPath).content.replace('const MOVE = false;', 'const MOVE = true;') }],
    }));
    const { done } = await startProductionStageRun(projectId, {}, {
      repair, render: ({ directory }) => renderComposition({ directory, jobId: 'stages-acceptance' }),
    });
    expect(await done).toBe('completed');

    const [{ data }] = (await getProductionHistory(projectId, { limit: 1, offset: 0 })).items;
    const inspections = data.stages.filter(stage => stage.key === 'inspect');
    expect(inspections[0].findings.map(finding => finding.kind)).toContain('frozen-film');
    expect(inspections[0].verdict.status).toBe('fail');
    expect(inspections[1]).toMatchObject({ findings: [], verdict: { status: 'pass' } });
    expect(repair).toHaveBeenCalledTimes(1);

    // Real, measured evidence: three distinct style frames and a pilot of distinct renders.
    const styleFrame = data.stages.filter(stage => stage.key === 'style-frame')[1];
    expect(styleFrame.artifacts).toHaveLength(3);
    for (const artifact of styleFrame.artifacts) {
      const bytes = await readFile(join(PATHS.data, artifact.relativePath));
      expect([...bytes.subarray(1, 4)].map(byte => String.fromCharCode(byte)).join('')).toBe('PNG');
    }
    expect(new Set(styleFrame.artifacts.map(artifact => artifact.sha256)).size).toBe(3);
    const pilot = data.stages.filter(stage => stage.key === 'pilot')[1];
    expect(new Set(pilot.samples.map(sample => sample.renderHash)).size).toBe(pilot.samples.length);

    // The final output is a real H.264 file of exactly duration × fps frames.
    const video = join(PATHS.videos, data.output.filename);
    const frames = Number(execFileSync(ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-count_frames', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', video]).toString().trim());
    expect(frames).toBe(24);
    expect(data.output.revisionId).toBe(data.currentRevisionId);
  }, 180000);
});
