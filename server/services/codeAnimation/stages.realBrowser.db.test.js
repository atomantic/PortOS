// Real-browser acceptance for the bounded production stages (#9389): a synthetic
// original short is staged, rendered and measured by real Chrome, repaired into a
// new revision, and finally encoded by the real renderer and ffmpeg. PostgreSQL
// (portos_test) holds the project and run records; no provider is called.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { channel } from 'node:diagnostics_channel';
import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { execFileSync, spawn } from 'node:child_process';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../../lib/mockPathsDataRoot.js';
import { findFfmpeg, findFfprobe } from '../../lib/ffmpeg.js';
import { _cleanupTestBrowser, _createTestArtifactsRoot, _startTestChromeWithRetry, _testChromeCaptureArgs, _waitForTestChrome } from '../htmlComposition/testBrowserCleanup.js';
import { resolveTestChrome } from '../../lib/browserSuiteGate.js';

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
const { cancelProductionStageRun, startProductionStageRun } = await import('./stages.js');
const { renderComposition } = await import('../htmlComposition/index.js');
const { PATHS } = await import('../../lib/fileUtils.js');

const health = await checkHealth().catch(error => ({ connected: false, error: error.message }));
const dbReady = requireDbOrSkip('codeAnimation/stages.realBrowser.db.test', health.connected, health.error);
if (dbReady) await ensureSchema();

const chrome = resolveTestChrome();
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
  audio: { kind: 'procedural', version: 1, events: [
    { label: 'Impact', atSeconds: 0.5, effect: 'impact', durationSeconds: 0.2, gain: 0.8 },
    { label: 'Reveal', atSeconds: 1.25, effect: 'reveal', durationSeconds: 0.4, gain: 0.6 },
  ] }, execution: { requested: null, effective: null },
};

let proc;
let browser;
let artifacts;
let projectId;
let startup;
// Keep only bounded phase/counter evidence; never stringify diagnostic payloads,
// which may later acquire paths or other private context.
const runs = [];
let stageProgress;
let renderProgress;
let diagnosticTimer;
const stageChannel = channel('portos.code-animation-stage.lifecycle');
const renderChannel = channel('portos.composition-render.lifecycle');
const observeStage = ({ stage, phase, elapsedMs }) => { stageProgress = { stage, phase, elapsedMs }; };
const observeRender = ({ phase, elapsedMs, encoderPid, frame, frames }) => {
  renderProgress = { phase, elapsedMs, encoderPid, frame, frames };
};
const reportPending = () => {
  const pending = runs.find(run => !run.settled);
  if (!pending) return;
  const stage = stageProgress;
  const render = renderProgress;
  console.log(`🔬 Production fixture run ${runs.indexOf(pending) + 1} pending: stage=${stage?.stage ?? 'starting'}/${stage?.phase ?? 'starting'} stageAtMs=${stage?.elapsedMs ?? 0} render=${render?.phase ?? 'none'} renderAtMs=${render?.elapsedMs ?? 0} browserPid=${proc?.pid ?? 'none'} browserExited=${proc?.exitCode != null || proc?.signalCode != null} encoderPid=${render?.encoderPid ?? 'none'} frame=${render?.frame ?? 'none'}/${render?.frames ?? 'none'}`);
};
async function startTrackedRun(input, deps) {
  stageProgress = null;
  renderProgress = null;
  const run = await startProductionStageRun(projectId, input, deps);
  runs.push(run);
  run.done.then(() => { run.settled = true; });
  return run;
}
const detachedChromeProcessGroupId = (child = proc) => process.platform === 'win32' ? undefined : child?.pid;

describe.skipIf(!dbReady || !chrome || !ffmpeg || !ffprobe)('Production stages with real Chrome and ffmpeg', () => {
  beforeAll(async () => {
    stageChannel.subscribe(observeStage);
    renderChannel.subscribe(observeRender);
    diagnosticTimer = setInterval(reportPending, 15000);
    const root = lazyTempDataRoot('portos-code-animation-stages-');
    try {
      const ws = await _startTestChromeWithRetry({
        launch: attempt => {
          const profile = join(root, `chrome-test-profile-${attempt}`);
          const child = spawn(chrome, _testChromeCaptureArgs(profile), { stdio: ['ignore', 'ignore', 'pipe'], detached: process.platform !== 'win32' });
          channel('portos.composition-browser.lifecycle').publish({ event: 'child', profile: root, child });
          startup = { source: 'test-chrome', executable: chrome, profile };
          return child;
        },
        onProc: child => { proc = child; },
        wait: child => _waitForTestChrome(child, 20000, startup),
        discard: child => _cleanupTestBrowser({ proc: child, cleanup: async () => {}, detachedProcessGroupId: detachedChromeProcessGroupId(child) }),
      });
      endpoint = new URL(ws).origin.replace('ws:', 'http:');
      artifacts = _createTestArtifactsRoot();
      browser = await chromium.connectOverCDP(endpoint, { artifactsDir: artifacts.path });
    } catch (error) {
      // Retain the owned handle for afterAll if termination itself fails.
      await _cleanupTestBrowser({ browser, proc, artifacts, cleanup: cleanupTempDataRoots, startupError: error, detachedProcessGroupId: detachedChromeProcessGroupId() });
    }
    // Enclose two startup attempts (2 x 20s), a discard (~20s), version probe (up to 3s), disconnect (5s), direct
    // child termination (10s), and detached-group drain (5s) budgets.
  }, 90000);

  afterAll(async () => {
    clearInterval(diagnosticTimer);
    reportPending();
    try {
      for (const run of runs.filter(run => !run.settled)) {
        try { cancelProductionStageRun(projectId, run.run.id); } catch (error) {
          if (!['CODE_ANIMATION_RUN_COMMITTING', 'CODE_ANIMATION_RUN_NOT_ACTIVE'].includes(error.code)) throw error;
        }
      }
      // A timed-out test leaves its async body alive. Drain its stage and
      // encoder before removing the rows/files they may still be using.
      await Promise.all(runs.map(run => run.done));
      await _cleanupTestBrowser({ browser, proc, artifacts, detachedProcessGroupId: detachedChromeProcessGroupId(), cleanup: async () => {
        if (projectId) await query('DELETE FROM code_animation_projects WHERE id = $1', [projectId]);
        await cleanupTempDataRoots();
      } });
      await close();
    } finally {
      stageChannel.unsubscribe(observeStage);
      renderChannel.unsubscribe(observeRender);
    }
  }, 25000);

  it('turns a frozen original into measured findings, a repaired revision and a real MP4, with a real style frame and pilot', async () => {
    projectId = (await createProductionProject({ manifest })).id;
    await importProductionPackage(projectId, createCodeAnimationPackage(manifest, [{ path: 'index.html', content: FILM(false) }]));
    const repair = vi.fn(async ({ files, entryPath }) => ({
      files: [{ path: entryPath, content: files.find(file => file.path === entryPath).content.replace('const MOVE = false;', 'const MOVE = true;') }],
    }));
    const { done } = await startTrackedRun({}, {
      repair, render: ({ directory, signal }) => renderComposition({ directory, signal, jobId: 'stages-acceptance' }),
    });
    const status = await done;
    const [{ data }] = (await getProductionHistory(projectId, { limit: 1, offset: 0 })).items;
    expect(status, JSON.stringify(data.findings)).toBe('completed');
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
    const sound = data.soundtrack;
    expect(sound.measured).toMatchObject({ sampleRate: 48000, frames: 96000, durationMs: 2000, nonFinite: 0 });
    const wav = await readFile(join(PATHS.data, sound.artifact.relativePath));
    const { synthesizeSoundtrack } = await import('../../lib/codeAnimationSound.js');
    expect(wav.equals(synthesizeSoundtrack(sound.timeline))).toBe(true);
    expect(createHash('sha256').update(wav).digest('hex')).toBe(data.output.audioHash);
    expect(data.output.audioEvidence).toMatchObject({ packageHash: sound.packageHash,
      stream: { codec_name: 'aac', sample_rate: '48000' }, verified: expect.arrayContaining(['audio-stream', 'audio-duration', 'audio-event-placement']) });
    const decoded = execFileSync(ffmpeg, ['-v', 'error', '-i', video, '-map', '0:a:0', '-ar', '48000', '-ac', '1', '-f', 's16le', 'pipe:1'], { maxBuffer: 1024 * 1024 });
    expect(decoded.length / 2 / 48000).toBeCloseTo(2, 1);
    for (const expected of [0.5, 1.25]) {
      // Independent decode: energy before the onset is silent, the authored window contains the event.
      let quietPeak = 0; let activePeak = 0;
      for (let i = Math.round((expected - 0.15) * 48000); i < Math.round((expected - 0.05) * 48000); i++) quietPeak = Math.max(quietPeak, Math.abs(decoded.readInt16LE(i * 2)));
      for (let i = Math.round(expected * 48000); i < Math.round((expected + 0.1) * 48000); i++) activePeak = Math.max(activePeak, Math.abs(decoded.readInt16LE(i * 2)));
      expect(quietPeak).toBeLessThan(100);
      expect(activePeak).toBeGreaterThan(1000);
    }
    expect(data.output.unverified.map(item => item.dimension)).toContain('hearing');
    // Renderer-independent library/upload snapshots survive a real final mux;
    // changing the original asset after staging cannot change the candidate.
    const { stageProductionSoundAsset } = await import('./soundAssets.js');
    for (const source of ['upload', 'library']) {
      const root = source === 'upload' ? PATHS.uploads : PATHS.music;
      await mkdir(root, { recursive: true });
      const { pcmToWavBuffer } = await import('../../lib/chiptuneRender.js');
      const left = new Float32Array(96000);
      for (let i = 0; i < left.length; i++) left[i] = wav.readInt16LE(44 + i * 2) / 32768;
      const stereo = pcmToWavBuffer([left, Float32Array.from(left, sample => -sample)], { sampleRate: 48000 });
      await writeFile(join(root, 'example.wav'), stereo);
      const staged = await stageProductionSoundAsset(projectId, { revisionId: data.currentRevisionId, source, filename: 'example.wav' });
      await writeFile(join(root, 'example.wav'), 'replaced');
      const next = await startTrackedRun({ revisionId: staged.revision.id }, {
        render: ({ directory, signal }) => renderComposition({ directory, signal, jobId: `sound-${source}-acceptance` }),
      });
      expect(await next.done).toBe('completed');
      const saved = (await getProductionHistory(projectId, { limit: 1, offset: 0 })).items[0].data;
      expect(saved.soundtrack.kind).toBe('file');
      expect(saved.soundtrack.measured.channels).toBe(2);
      expect(saved.output.audioEvidence.decodedChannels).toBe(2);
      expect(saved.output.audioEvidence.peak).toBeGreaterThan(0.1);
      expect(saved.output.audioEvidence.decodedDurationSeconds).toBeCloseTo(2, 1);
      expect(saved.output.audioEvidence.packageHash).toBe(staged.revision.packageHash);
    }
  }, 180000);
});
