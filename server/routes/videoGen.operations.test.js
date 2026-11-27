import {
  updateVideoPoster,
  probeVideoGeometry,
  mediaUsage,
  installProcess,
  runtimeProbes,
  videoGenLeaves,
  sseDownload,
  federatedPeerId,
  app,
  installVideoRouteHooks,
} from './videoGen.test.fixture.js';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { request } from '../lib/testHelper.js';
import { stat } from 'fs/promises';
import { invalidateSetupCheck } from '../services/imageGen/setup.js';
import * as videoGenService from '../services/videoGen/local.js';
import * as mediaRemoteDelete from '../services/mediaRemoteDelete.js';
import * as upscaleJobService from '../services/videoGen/upscaleJob.js';
import * as stitchJobService from '../services/videoGen/stitchJob.js';
import { enqueueVertical } from '../services/videoGen/verticalJob.js';
import { trimHistoryItem } from '../services/videoGen/trim.js';
import * as mediaJobQueue from '../services/mediaJobQueue/index.js';
import { listIcLoraRemixModes, IC_LORA_MODES, icLoraWeightKey } from '../lib/icLoraWeights.js';

describe('videoGen routes', () => {
  installVideoRouteHooks();

  it('rejects a repeated query key with 400 (runtime-install, #16428)', async () => {
    const res = await request(app).post('/api/video-gen/setup/runtime-install?runtime=a&runtime=b');
    expect(res.status).toBe(400);
  });

  it('validates poster edits and allows an explicit reset', async () => {
    const id = '00000000-0000-4000-8000-000000000001';
    updateVideoPoster.mockResolvedValue({ id, thumbnail: 'poster.jpg', posterSec: 12.4 });
    const saved = await request(app).patch(`/api/video-gen/history/${id}/poster`).send({ atSec: 12.4 });
    expect(saved.status).toBe(200);
    expect(saved.body.posterSec).toBe(12.4);
    expect(updateVideoPoster).toHaveBeenCalledWith(id, 12.4);
    const reset = await request(app).patch(`/api/video-gen/history/${id}/poster`).send({ atSec: null });
    expect(reset.status).toBe(200);
    expect(updateVideoPoster).toHaveBeenCalledWith(id, null);
    for (const body of [{}, { atSec: '12.4' }]) {
      expect((await request(app).patch(`/api/video-gen/history/${id}/poster`).send(body)).status).toBe(400);
    }
  });

  describe('GET /status', () => {
    beforeEach(() => {
      // A stat-able interpreter lets the memo key resolve (an unstatable path skips the cache by design).
      stat.mockResolvedValue({ mtimeMs: 1 });
      invalidateSetupCheck();
    });
    afterEach(() => {
      stat.mockImplementation(async () => { throw Object.assign(new Error('not found'), { code: 'ENOENT' }); });
      invalidateSetupCheck();
    });

    it('spawns the interpreter probe once for two calls inside the memo window, and again for fresh=true', async () => {
      const { probePythonHealth } = await import('../lib/pythonSetup.js');
      probePythonHealth.mockClear();
      expect((await request(app).get('/api/video-gen/status')).status).toBe(200);
      const second = await request(app).get('/api/video-gen/status');
      expect(second.body.connected).toBe(true);
      expect(probePythonHealth).toHaveBeenCalledTimes(1);
      expect((await request(app).get('/api/video-gen/status?fresh=true')).status).toBe(200);
      expect(probePythonHealth).toHaveBeenCalledTimes(2);
      expect((await request(app).get('/api/video-gen/status?fresh=maybe')).status).toBe(400);
    });

    it('re-probes after an install invalidates the memo for the interpreter', async () => {
      const { probePythonHealth } = await import('../lib/pythonSetup.js');
      probePythonHealth.mockClear();
      await request(app).get('/api/video-gen/status');
      invalidateSetupCheck('/usr/bin/python3');
      await request(app).get('/api/video-gen/status');
      expect(probePythonHealth).toHaveBeenCalledTimes(2);
    });

    it('reports connected when pythonPath is set AND required packages all import', async () => {
      const r = await request(app).get('/api/video-gen/status');
      expect(r.status).toBe(200);
      expect(r.body.connected).toBe(true);
      expect(r.body.pythonPath).toBe('/usr/bin/python3');
      expect(r.body.missingPackages).toEqual([]);
      expect(r.body.defaultModel).toBe('ltx2_unified');
      // systemMemoryGb drives the client's a2v auto-select (largest model
      // that fits in `systemMemoryGb - 16 GB` headroom). Pin the field's
      // presence + type so a future accidental removal is caught here.
      expect(typeof r.body.systemMemoryGb).toBe('number');
      expect(r.body.systemMemoryGb).toBeGreaterThan(0);
      // fflfLtx2PixelBudget lets the client mirror the FFLF keyframe-index
      // clamp without hardcoding the constant. Pin presence + type.
      expect(typeof r.body.fflfLtx2PixelBudget).toBe('number');
      expect(r.body.fflfLtx2PixelBudget).toBeGreaterThan(0);
      // runtime fingerprint block — host chip/os + per-runtime resolved
      // versions so the UI (and bug reports) can show the exact stack (#1325).
      expect(r.body.runtime?.host?.chip).toBe('Apple M5 Max');
      expect(r.body.runtime?.runtimes?.ltx2?.versions?.mlx).toBe('0.22.0');
    });

    it('reports disconnected with reason + missingPackages when packages fail to import', async () => {
      const { probePythonHealth } = await import('../lib/pythonSetup.js');
      probePythonHealth.mockResolvedValueOnce({
        installed: ['numpy', 'tqdm'],
        missing: ['mflux', 'mlx', 'mlx_video'],
        missingPip: ['mflux', 'mlx', 'mlx_video'],
      });
      const r = await request(app).get('/api/video-gen/status');
      expect(r.status).toBe(200);
      expect(r.body.connected).toBe(false);
      expect(r.body.pythonPath).toBe('/usr/bin/python3');
      expect(r.body.missingPackages).toEqual(['mflux', 'mlx', 'mlx_video']);
      expect(r.body.reason).toMatch(/3 python packages missing/);
    });

    // #3674 — the backend policy-scope wording is server-owned so the UI can't
    // drift into ranking language ("less restrictive", "uncensored", …).
    it('serializes the local + hosted backend disclosures', async () => {
      const r = await request(app).get('/api/video-gen/status');
      expect(r.body.backendDisclosures.map((b) => b.id)).toEqual(['local', 'grok']);
      const local = r.body.backendDisclosures.find((b) => b.id === 'local');
      expect(local.execution).toBe('local');
      expect(local.facts.join(' ')).toMatch(/does not send your prompt/i);
      expect(local.facts.join(' ')).toMatch(/no model-level prompt filter/i);
      expect(local.facts.join(' ')).toMatch(/license/i);
      const grok = r.body.backendDisclosures.find((b) => b.id === 'grok');
      expect(grok.execution).toBe('hosted');
      expect(grok.provider).toBe('xAI');
      expect(grok.facts.join(' ')).toMatch(/sent to xAI/i);
      for (const link of grok.links) expect(link.url).toMatch(/^https:\/\//);
      for (const backend of r.body.backendDisclosures) {
        expect([backend.summary, ...backend.facts].join(' '))
          .not.toMatch(/uncensored|unrestricted|less restrictive/i);
      }
    });

    // #5872 — the page warns the user BEFORE the screen goes dark, which it can
    // only do if the server says whether THIS install will actually sleep it.
    // The predicate is stubbed rather than exercised for real: it is
    // macOS-only, so a live call returns false on every other runner and the
    // assertions would pass against a hardcoded false — pinning nothing.
    it('reports whether a render will sleep the display, and passes the videoGen slice', async () => {
      const { isDisplaySleepEnabled } = await import('../services/videoGen/displayPower.js');
      const { getSettings } = await import('../services/settings.js');

      isDisplaySleepEnabled.mockReturnValueOnce(true);
      getSettings.mockResolvedValueOnce({
        imageGen: { local: { pythonPath: '/usr/bin/python3' } },
        videoGen: { displaySleep: true },
      });
      const on = await request(app).get('/api/video-gen/status');
      expect(on.body.displaySleepOnRender).toBe(true);
      // The videoGen slice, not the whole settings object — the predicate reads
      // `.displaySleep` off what it is handed.
      expect(isDisplaySleepEnabled).toHaveBeenCalledWith({ displaySleep: true });

      isDisplaySleepEnabled.mockReturnValueOnce(false);
      const off = await request(app).get('/api/video-gen/status');
      expect(off.body.displaySleepOnRender).toBe(false);
    });

    // #6304-follow-up — falEnabled/reactorEnabled must reflect the SAME
    // resolver a render is gated on (isVideoModeUsable), which honors the
    // FAL_KEY/REACTOR_API_KEY env vars. Re-deriving "has a key" from the raw
    // settings object client-side missed the env-var case entirely, so a key
    // set only via env var never surfaced the backend switcher.
    it('reports fal/reactor usable when a settings key is stored', async () => {
      const { getSettings } = await import('../services/settings.js');
      getSettings.mockResolvedValueOnce({
        imageGen: { local: { pythonPath: '/usr/bin/python3' } },
        videoGen: { fal: { apiKey: 'settings-fal-key' }, reactor: { apiKey: 'settings-reactor-key' } },
      });
      const r = await request(app).get('/api/video-gen/status');
      expect(r.body.falEnabled).toBe(true);
      expect(r.body.reactorEnabled).toBe(true);
    });

    it('reports fal/reactor usable from FAL_KEY/REACTOR_API_KEY env vars with no settings key', async () => {
      const prevFal = process.env.FAL_KEY;
      const prevReactor = process.env.REACTOR_API_KEY;
      process.env.FAL_KEY = 'env-fal-key';
      process.env.REACTOR_API_KEY = 'env-reactor-key';
      try {
        const r = await request(app).get('/api/video-gen/status');
        expect(r.body.falEnabled).toBe(true);
        expect(r.body.reactorEnabled).toBe(true);
      } finally {
        if (prevFal === undefined) delete process.env.FAL_KEY; else process.env.FAL_KEY = prevFal;
        if (prevReactor === undefined) delete process.env.REACTOR_API_KEY; else process.env.REACTOR_API_KEY = prevReactor;
      }
    });

    it('reports fal/reactor unusable when neither a settings key nor an env var is present', async () => {
      const prevFal = process.env.FAL_KEY;
      const prevReactor = process.env.REACTOR_API_KEY;
      delete process.env.FAL_KEY;
      delete process.env.REACTOR_API_KEY;
      try {
        const r = await request(app).get('/api/video-gen/status');
        expect(r.body.falEnabled).toBe(false);
        expect(r.body.reactorEnabled).toBe(false);
      } finally {
        if (prevFal !== undefined) process.env.FAL_KEY = prevFal;
        if (prevReactor !== undefined) process.env.REACTOR_API_KEY = prevReactor;
      }
    });

    it('passes each model entry through with its registry disclosure block', async () => {
      videoGenService.listVideoModels.mockReturnValueOnce([
        {
          id: 'ltx2_unified',
          name: 'LTX-2 Unified',
          runtime: 'ltx2',
          disclosure: { modelCardUrl: 'https://huggingface.co/example-org/example-video', reviewedAt: '2026-08-09' },
        },
        { id: 'custom', name: 'Custom', runtime: 'ltx2', source: 'user' },
      ]);
      const r = await request(app).get('/api/video-gen/status');
      expect(r.body.models[0].disclosure.modelCardUrl).toBe('https://huggingface.co/example-org/example-video');
      // Custom models carry no disclosure — the UI renders Unknown rather than
      // inheriting a shipped model's licensing.
      expect('disclosure' in r.body.models[1]).toBe(false);
    });
  });

  describe('GET /setup/runtime-status', () => {
    it('reports a missing runtime without probing readiness or revision', async () => {
      const r = await request(app).get('/api/video-gen/setup/runtime-status?runtime=wan22');
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({
        runtime: 'wan22', installed: false, binaryPresent: false,
        packagesReady: false, current: false, upgradeAvailable: false,
      });
      expect(videoGenService.isByovRuntimeReady).not.toHaveBeenCalled();
      expect(videoGenService.isByovRuntimeCurrent).not.toHaveBeenCalled();
    });

    it('reports a ready runtime as installed only when its checkout is current', async () => {
      videoGenService.isByovRuntimeInstalled.mockReturnValueOnce(true);
      videoGenService.isByovRuntimeReady.mockResolvedValueOnce(true);
      videoGenService.isByovRuntimeCurrent.mockResolvedValueOnce(true);
      const r = await request(app).get('/api/video-gen/setup/runtime-status?runtime=wan22');
      expect(r.body).toMatchObject({
        installed: true, binaryPresent: true, packagesReady: true,
        current: true, upgradeAvailable: false,
      });
    });

    it('offers an upgrade without importing an outdated checkout', async () => {
      videoGenService.isByovRuntimeInstalled.mockReturnValueOnce(true);
      videoGenService.isByovRuntimeCurrent.mockResolvedValueOnce(false);
      const r = await request(app).get('/api/video-gen/setup/runtime-status?runtime=wan22');
      expect(r.body).toMatchObject({
        installed: false, binaryPresent: true, packagesReady: false,
        current: false, upgradeAvailable: true,
      });
      expect(videoGenService.isByovRuntimeReady).not.toHaveBeenCalled();
    });

    // The install banner renders "PortOS can fetch and install it from X". For a
    // runtime that clones its repoUrl, X is that URL; for minimax_h3_cuda the
    // repoUrl is DOCUMENTATION (there is no checkout, only a venv), so the label
    // has to reach the client or the banner tells the user PortOS downloads the
    // runtime from a docs page.
    it.each([
      ['wan22', undefined],
      ['minimax_h3_cuda', 'pinned PyPI wheels'],
    ])('surfaces the install source label for %s', async (runtime, expected) => {
      const r = await request(app).get(`/api/video-gen/setup/runtime-status?runtime=${runtime}`);
      expect(r.status).toBe(200);
      expect(r.body.installSourceLabel).toBe(expected);
    });
  });

  describe('/setup/runtime-install', () => {
    it('retains the dependency stage and actionable installer failure in the final SSE error', async () => {
      const diagnostic = 'LTX-2.5 MLX dependency sync failed (exit 2). Check application firewall access for the private uv, then retry Install/Repair.';
      installProcess.spawn.mockImplementationOnce(() => installProcess.makeChild({
        code: 2,
        stdout: '📦 Syncing LTX-2.5 MLX wheels from requirements-ltx25-mlx.lock.txt...\n',
        stderr: `fixture: download failed\n❌ ${diagnostic}`,
      }));
      const r = await request(app).post('/api/video-gen/setup/runtime-install?runtime=ltx25');
      const events = r.text.split('\n').filter((line) => line.startsWith('data: '))
        .map((line) => JSON.parse(line.slice(6)));
      expect(events).toContainEqual(expect.objectContaining({ type: 'stage', stage: 'dependencies' }));
      expect(events.at(-1)).toMatchObject({ type: 'error', message: diagnostic });
      expect(events.some((event) => event.type === 'complete')).toBe(false);
    });

    it('keeps other package errors in the log without inventing a network diagnosis', async () => {
      installProcess.spawn.mockImplementationOnce(() => installProcess.makeChild({
        code: 1, stderr: 'fixture: wheel hash mismatch\n',
      }));
      const r = await request(app).post('/api/video-gen/setup/runtime-install?runtime=wan22');
      expect(r.text).toContain('wheel hash mismatch');
      expect(r.text).toContain('Installer exited with code 1.');
      expect(r.text).not.toContain('firewall');
    });

    it('keeps GET read-only and returns the current runtime status', async () => {
      const r = await request(app).get('/api/video-gen/setup/runtime-install?runtime=wan22');
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({
        runtime: 'wan22', installed: false, binaryPresent: false,
        packagesReady: false, current: false,
      });
      expect(installProcess.spawn).not.toHaveBeenCalled();
    });

    it('short-circuits only when the runtime packages and pinned revision are current', async () => {
      videoGenService.isByovRuntimeInstalled.mockReturnValueOnce(true);
      videoGenService.isByovRuntimeReady.mockResolvedValueOnce(true);
      videoGenService.isByovRuntimeCurrent.mockResolvedValueOnce(true);
      const r = await request(app).post('/api/video-gen/setup/runtime-install?runtime=wan22');
      expect(r.status).toBe(200);
      expect(r.text).toContain('"type":"complete"');
      expect(r.text).toContain('Already installed');
      expect(videoGenService.invalidateByovReadyCache).not.toHaveBeenCalled();
    });

    it('upgrades an outdated checkout with the pinned revision in the installer environment', async () => {
      videoGenService.isByovRuntimeInstalled
        .mockReturnValueOnce(true)
        .mockReturnValueOnce(true);
      videoGenService.isByovRuntimeReady
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(true);
      videoGenService.isByovRuntimeCurrent
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true);
      const r = await request(app).post('/api/video-gen/setup/runtime-install?runtime=wan22');
      expect(r.status).toBe(200);
      expect(r.text).toContain('"type":"complete"');
      expect(r.text).toContain('Wan 2.2 MLX ready');
      const [bin, argv, opts] = installProcess.spawn.mock.calls.at(-1);
      // A bash, but never the WSL one PM2's PATH may resolve first, and never a
      // backslash path — bash reads those as escapes and exits 127.
      expect(bin).toMatch(/bash(.exe)?$/i);
      expect(bin.toLowerCase()).not.toContain('system32');
      expect(argv).toEqual(['/mock/scripts/setup-image-video.sh']);
      expect(opts).toMatchObject({
        detached: process.platform !== 'win32',
        env: expect.objectContaining({
          INSTALL_WAN22: '1',
          WAN22_PIN: '2452f0c12edcc8886eebf15772205ce9c417a618',
        }),
      });
    });
  });

  describe('GET /models', () => {
    it('returns the static catalog', async () => {
      const r = await request(app).get('/api/video-gen/models');
      expect(r.status).toBe(200);
      expect(r.body).toEqual([{
        id: 'ltx2_unified', name: 'LTX-2 Unified', runtime: 'ltx2', supportedModes: ['text', 'image', 'fflf'],
      }]);
    });
  });

  describe('GET /model-context', () => {
    it('reports the backend usability flags from env-only keys, same as /status', async () => {
      const prevFal = process.env.FAL_KEY;
      process.env.FAL_KEY = 'env-fal-key';
      try {
        const ctx = await request(app).get('/api/video-gen/model-context');
        const status = await request(app).get('/api/video-gen/status');
        expect(ctx.body.falEnabled).toBe(true);
        const enabledKeys = ['falEnabled', 'geminiEnabled', 'googleEnabled', 'higgsfieldEnabled', 'reactorEnabled', 'runwayEnabled'];
        expect(Object.keys(status.body).filter(key => key.endsWith('Enabled')).sort()).toEqual(enabledKeys);
        for (const key of enabledKeys) {
          expect(typeof ctx.body[key]).toBe('boolean');
          expect(status.body[key]).toBe(ctx.body[key]);
        }
      } finally {
        if (prevFal === undefined) delete process.env.FAL_KEY; else process.env.FAL_KEY = prevFal;
      }
    });

    it('serves the model list and its auto-select numbers without probing python', async () => {
      const { probePythonHealth } = await import('../lib/pythonSetup.js');
      probePythonHealth.mockClear();

      const r = await request(app).get('/api/video-gen/model-context');
      expect(r.status).toBe(200);
      // The picker's whole input set, in one probe-free answer.
      expect(r.body.models.map((m) => m.id)).toEqual(['ltx2_unified']);
      expect(r.body.defaultModel).toBe('ltx2_unified');
      expect(typeof r.body.systemMemoryGb).toBe('number');
      expect(r.body.systemMemoryGb).toBeGreaterThan(0);
      expect(typeof r.body.fflfLtx2PixelBudget).toBe('number');
      expect(r.body.fflfLtx2PixelBudget).toBeGreaterThan(0);
      // The point of the route: no interpreter subprocess in the request path.
      expect(probePythonHealth).not.toHaveBeenCalled();
      // The hosted-backend flags, runtime list and render-time disclosures the form
      // needs to render also ride this probe-free route.
      for (const key of ['falEnabled', 'reactorEnabled', 'runwayEnabled', 'geminiEnabled', 'higgsfieldEnabled', 'googleEnabled']) {
        expect(typeof r.body[key]).toBe('boolean');
      }
      expect(Array.isArray(r.body.byovRuntimes)).toBe(true);
      expect(r.body.backendDisclosures.map((b) => b.id)).toContain('local');
      expect(typeof r.body.displaySleepOnRender).toBe('boolean');
    });

    it('uses the saved local video model as the form default when available', async () => {
      const { getSettings } = await import('../services/settings.js');
      getSettings.mockResolvedValueOnce({ videoGen: { defaultModelId: 'preferred-video-model' } });
      videoGenService.defaultVideoModelId.mockImplementationOnce((capabilities, preferredId) => (
        preferredId || 'ltx2_unified'
      ));

      const r = await request(app).get('/api/video-gen/model-context');

      expect(r.status).toBe(200);
      expect(r.body.defaultModel).toBe('preferred-video-model');
      expect(videoGenService.defaultVideoModelId).toHaveBeenCalledWith(expect.any(Object), 'preferred-video-model');
    });

    // The payload's `runtimeLoraCapable` is only as good as the probe having
    // ANSWERED first — the reason is on warmByovLoraCapabilities in
    // services/videoGen/runtimes.js. Calling the warm is not enough: the list
    // must be built after it SETTLES, so the warm here resolves on a later tick
    // and a route that fired it without awaiting reads `probed` as false.
    it('builds the model list only after the LoRA warm has settled', async () => {
      let probed = false;
      runtimeProbes.warmByovLoraCapabilities.mockImplementationOnce(async () => {
        await new Promise((resolve) => { setImmediate(resolve); });
        probed = true;
      });
      // Stands in for decorateVideoModel, which stamps the sync read at the
      // moment the list is built.
      videoGenService.listVideoModels.mockImplementationOnce(() => [{
        id: 'minimax_h3_8bit', name: 'MiniMax H3 MLX 8-bit', runtime: 'minimax_h3',
        supportedModes: ['text'], runtimeLoraCapable: probed,
      }]);

      const r = await request(app).get('/api/video-gen/model-context');
      expect(r.status).toBe(200);
      expect(r.body.models[0].runtimeLoraCapable).toBe(true);
    });

    it('agrees with /status on every field the two share', async () => {
      const [context, status] = await Promise.all([
        request(app).get('/api/video-gen/model-context'),
        request(app).get('/api/video-gen/status'),
      ]);
      for (const field of ['models', 'defaultModel', 'systemMemoryGb', 'fflfLtx2PixelBudget']) {
        expect(status.body[field]).toEqual(context.body[field]);
      }
    });
  });

  describe('POST /models/:modelId/download — MiniMax H3 snapshots', () => {
    const h3CheckpointFiles = ['LICENSE', 'FL2VA/model_index.json', 'FL2VA/video_vae/source/model.safetensors'];
    const h3 = {
      id: 'minimax_h3_8bit',
      name: 'MiniMax H3 MLX 8-bit',
      runtime: 'minimax_h3',
      repo: 'pipenetwork/MiniMax-H3-MLX-8bit',
      revision: '3ac52081470b0488921c3ec3ba84a39097bf2361',
      supportedModes: ['text'],
      defaultFrames: 124,
      frameOptions: [107, 124, 141, 158],
      fpsOptions: [24],
      defaultWidth: 1344,
      defaultHeight: 768,
      resolutionStep: 32,
      steps: 8,
      guidance: 0,
      samplerLocked: true,
      requiredWeights: [{
        repo: 'MiniMaxAI/MiniMax-H3',
        revision: '6818f6c32d12b210915e44ad56a4228c2608f160',
        files: h3CheckpointFiles,
      }],
    };

    it('downloads both exact snapshots', async () => {
      videoGenService.listVideoModels.mockReturnValueOnce([h3]);
      const accepted = await request(app).post('/api/video-gen/models/minimax_h3_8bit/download');
      expect(accepted.status).toBe(200);
      expect(sseDownload.start).toHaveBeenCalledWith(expect.objectContaining({
        repos: [
          {
            repo: 'pipenetwork/MiniMax-H3-MLX-8bit',
            revision: '3ac52081470b0488921c3ec3ba84a39097bf2361',
            only: [],
          },
          {
            repo: 'MiniMaxAI/MiniMax-H3',
            revision: '6818f6c32d12b210915e44ad56a4228c2608f160',
            only: h3CheckpointFiles,
          },
        ],
      }));
    });

    it('downloads Ref2VA through PortOS with the pinned snapshot and saved HF token path', async () => {
      const ref2va = {
        id: 'minimax_h3_ref2va_8bit',
        name: 'MiniMax H3 Ref2VA MLX 8-bit',
        runtime: 'minimax_h3_ref2va',
        repo: 'Sawfwair/MiniMax-H3-Ref2VA-MLX-8bit',
        revision: '61dc387ef1a7166425cdacd63c2340598dcc364f',
        supportedModes: ['a2v'],
      };
      videoGenService.listVideoModels.mockReturnValueOnce([ref2va]);

      const accepted = await request(app).post(`/api/video-gen/models/${ref2va.id}/download`);

      expect(accepted.status).toBe(200);
      expect(sseDownload.start).toHaveBeenCalledWith(expect.objectContaining({
        repos: [{
          repo: ref2va.repo,
          revision: ref2va.revision,
          only: [],
        }],
        pythonPath: null,
        force: false,
      }));
      expect(videoGenService.isByovRuntimeReady).not.toHaveBeenCalled();
    });

    it('queues an H3 render without a recorded acknowledgement', async () => {
      videoGenService.listVideoModels.mockReturnValue([h3]);
      const render = await request(app).post('/api/video-gen/').send({
        prompt: 'a fox watches the rain',
        modelId: h3.id,
        mode: 'text',
        numFrames: 107,
        fps: 24,
        width: 1536,
        height: 672,
      });
      expect(render.status).toBe(200);
      expect(mediaJobQueue.enqueueJob).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'video',
        params: expect.objectContaining({
          modelId: h3.id,
          numFrames: 107,
          fps: 24,
          width: 1536,
          height: 672,
        }),
      }));
      videoGenService.listVideoModels.mockReset();
    });
  });

  describe('Higgsfield references', () => {
    it('refuses the complete over-cap shot reference set before enqueueing', async () => {
      const { getSettings } = await import('../services/settings.js');
      getSettings.mockResolvedValueOnce({ videoGen: { higgsfield: { apiKey: 'example-key' } } });
      const response = await request(app).post('/api/video-gen/').send({
        backend: 'higgsfield', mode: 'text', prompt: '  A dancer turns  ',
        referenceImageFiles: Array.from({ length: 31 }, (_, i) => `ref-${i}.png`),
      });
      expect(response.status).toBe(400);
      expect(response.body.error).toMatch(/at most 30 reference images.*received 31/);
      expect(mediaJobQueue.enqueueJob).not.toHaveBeenCalled();
    });
  });

  describe('GET /active', () => {
    const listJobsByFilter = (jobs) => ({ status, kind } = {}) => jobs.filter((j) => {
      if (status && j.status !== status) return false;
      if (kind && j.kind !== kind) return false;
      return true;
    });

    it('returns { activeJob: null } when no video jobs exist', async () => {
      mediaJobQueue.listJobs.mockReturnValue([]);
      const r = await request(app).get('/api/video-gen/active');
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ activeJob: null });
    });

    it('returns all running activeJobs with limit and memory-governed indicator for local', async () => {
      mediaJobQueue.listJobs.mockImplementation(listJobsByFilter([
        { id: 'running-1', kind: 'video', status: 'running', position: 1, params: { prompt: 'P1', mode: 'text' } },
        { id: 'running-2', kind: 'video', status: 'running', position: 2, params: { prompt: 'P2', mode: 'text' } },
      ]));
      const r = await request(app).get('/api/video-gen/active');
      expect(r.status).toBe(200);
      expect(r.body.activeJobs).toHaveLength(2);
      expect(r.body.activeJobs[0].jobId).toBe('running-1');
      expect(r.body.activeJobs[1].jobId).toBe('running-2');
      expect(r.body.limit).toBe(1);
      expect(r.body.memoryGoverned).toBe(true);
      expect(r.body.limitReason).toBe('memory-governed');
    });

    it('prefers the running job over queued jobs', async () => {
      mediaJobQueue.listJobs.mockImplementation(listJobsByFilter([
        { id: 'running-1', kind: 'video', status: 'running', position: 1, params: { prompt: 'P running' } },
        { id: 'queued-1',  kind: 'video', status: 'queued',  position: 2, params: { prompt: 'P queued' } },
      ]));
      const r = await request(app).get('/api/video-gen/active');
      expect(r.status).toBe(200);
      expect(r.body.activeJob.jobId).toBe('running-1');
      expect(r.body.activeJob.status).toBe('running');
      expect(r.body.activeJob.params.prompt).toBe('P running');
    });

    it('echoes batchSize, resolution and generateAudio for reload restore', async () => {
      mediaJobQueue.listJobs.mockImplementation(listJobsByFilter([
        { id: 'local-1', kind: 'video', status: 'running', params: { prompt: 'p', batchSize: 3 } },
        { id: 'fal-1', kind: 'video', status: 'running', params: { prompt: 'p', mode: 'fal', resolution: '720p', generateAudio: true } },
      ]));
      const r = await request(app).get('/api/video-gen/active');
      expect(r.status).toBe(200);
      const byId = Object.fromEntries(r.body.activeJobs.map((j) => [j.jobId, j.params]));
      expect(byId['local-1'].batchSize).toBe(3);
      expect(byId['fal-1']).toMatchObject({ resolution: '720p', generateAudio: true });
    });

    it('restores only gallery-backed reference images into the editable picker', async () => {
      mediaJobQueue.listJobs.mockImplementation(listJobsByFilter([{
        id: 'running-refs', kind: 'video', status: 'running', params: {
          referenceImagePaths: ['/mock/images/cast.png', '/mock/image-refs/guide.png', '/mock/image-refs/cast.png'],
        },
      }]));
      const r = await request(app).get('/api/video-gen/active');
      expect(r.status).toBe(200);
      expect(r.body.activeJob.params.referenceImageFiles).toEqual(['cast.png']);
      expect(r.body.activeJob.params.unavailableReferenceImageNames).toEqual(['guide.png', 'cast.png']);
      expect(JSON.stringify(r.body)).not.toContain('/mock/');
    });

    it('does not restore any IC stills as gallery picks if a cast guide is outside the gallery', async () => {
      mediaJobQueue.listJobs.mockImplementation(listJobsByFilter([{
        id: 'running-ic', kind: 'video', status: 'running', params: {
          mode: 'ic-ingredients-25', icReferencePaths: ['/mock/images/rider.png', '/mock/image-refs/rider.png'],
        },
      }]));
      const r = await request(app).get('/api/video-gen/active');
      expect(r.status).toBe(200);
      expect(r.body.activeJob.params.icReferenceNames).toEqual(['rider.png', 'rider.png']);
      expect(r.body.activeJob.params).not.toHaveProperty('icReferenceImageFiles');
      expect(JSON.stringify(r.body)).not.toContain('/mock/');
    });

    it('restores a complete gallery-backed IC still set', async () => {
      mediaJobQueue.listJobs.mockImplementation(listJobsByFilter([{
        id: 'running-ic-gallery', kind: 'video', status: 'running', params: {
          mode: 'ic-ingredients-25', icReferencePaths: ['/mock/images/rider.png', '/mock/images/bike.png'],
        },
      }]));
      const r = await request(app).get('/api/video-gen/active');
      expect(r.body.activeJob.params.icReferenceImageFiles).toEqual(['rider.png', 'bike.png']);
    });

    it.each([
      ['/mock/images/start.png', { sourceImageFile: 'start.png' }],
      ['/mock/uploads/start.png', { unavailableSourceImageName: 'start.png' }],
    ])('restores or marks the IC opening frame from %s', async (path, expected) => {
      mediaJobQueue.listJobs.mockImplementation(listJobsByFilter([{
        id: 'running-ic-frame', kind: 'video', status: 'running', params: {
          mode: 'ic-ingredients-25', sourceImagePath: path,
        },
      }]));
      const r = await request(app).get('/api/video-gen/active');
      expect(r.status).toBe(200);
      expect(r.body.activeJob.params).toMatchObject(expected);
      expect(JSON.stringify(r.body)).not.toContain('/mock/');
    });

    it('resumes a federated render from its marker, not the blanked local fields', async () => {
      // The routed job's top-level prompt/model are blanked so a downgraded
      // build fails closed (#4683). Without reading through to the wire
      // request, a reload mid-render would repopulate the form with an empty
      // prompt and the LOCAL default model instead of the peer's.
      mediaJobQueue.listJobs.mockImplementation(listJobsByFilter([{
        id: 'remote-running',
        kind: 'video',
        status: 'running',
        position: 1,
        params: {
          prompt: '',
          modelId: null,
          pythonPath: null,
          remoteMedia: {
            wireVersion: 1,
            peerId: federatedPeerId,
            request: {
              kind: 'video', engine: 'local', modelId: 'ltx2', prompt: 'a slow pan across a harbour',
            },
          },
        },
      }]));
      const r = await request(app).get('/api/video-gen/active');
      expect(r.status).toBe(200);
      expect(r.body.activeJob.params.prompt).toBe('a slow pan across a harbour');
      expect(r.body.activeJob.params.modelId).toBe('ltx2');
      // The marker itself stays off this surface — it carries peer routing state.
      expect(r.body.activeJob.params).not.toHaveProperty('remoteMedia');
    });

    // Selection of the newest queued (not oldest) matches /cancel's fallback
    // selection — see the surrounding comment in routes/videoGen.js. Diverging
    // would mean Cancel from a resumed-queued page targets a different job.
    it('returns newest queued when nothing is running (matches /cancel order)', async () => {
      mediaJobQueue.listJobs.mockImplementation(listJobsByFilter([
        { id: 'queued-old', kind: 'video', status: 'queued', position: 1, params: { prompt: 'P old' } },
        { id: 'queued-new', kind: 'video', status: 'queued', position: 2, params: { prompt: 'P new' } },
      ]));
      const r = await request(app).get('/api/video-gen/active');
      expect(r.status).toBe(200);
      expect(r.body.activeJob.jobId).toBe('queued-new');
      expect(r.body.activeJob.status).toBe('queued');
    });

    // params is a whitelist — never leak server-internal absolute file paths
    // (sourceImagePath, audioFilePath, uploadedTempPath(s), extendFromVideoPath)
    // or the resolved pythonPath to the browser.
    it('whitelists params and never leaks server-internal file paths', async () => {
      const continuation = { requestedStrategy: 'window', effectiveStrategy: 'window', contextFrames: 17,
        actualHistoryFrames: null, runtime: 'ltx2', capability: true, backendPin: null, unavailableReason: null };
      mediaJobQueue.listJobs.mockImplementation(listJobsByFilter([
        { id: 'running-1', kind: 'video', status: 'running', position: 1, params: {
          prompt: 'safe prompt',
          modelId: 'ltx2_unified',
          width: 768, height: 512,
          numFrames: 121, fps: 24,
          steps: 25, guidanceScale: 3, seed: 42,
          tiling: 'auto', disableAudio: false, mode: 'text', chunks: 1,
          continuityStrategy: 'window',
          continuation: { ...continuation, sourceVideoPath: '/private/original.mp4' },
          // sensitive fields that must NOT round-trip:
          pythonPath: '/Users/secret/venv/bin/python',
          sourceImagePath: '/Users/secret/data/uploads/source.png',
          audioFilePath: '/Users/secret/data/uploads/voice.wav',
          uploadedTempPath: '/tmp/upload-xyz',
          uploadedTempPaths: ['/tmp/last-abc'],
          extendFromVideoPath: '/Users/secret/data/videos/prev.mp4',
        } },
      ]));
      const r = await request(app).get('/api/video-gen/active');
      expect(r.status).toBe(200);
      const p = r.body.activeJob.params;
      expect(p.prompt).toBe('safe prompt');
      expect(p.modelId).toBe('ltx2_unified');
      expect(p.width).toBe(768);
      expect(p.continuityStrategy).toBe('window');
      expect(p.continuation).toEqual(continuation);
      expect(p.pythonPath).toBeUndefined();
      expect(p.sourceImagePath).toBeUndefined();
      expect(p.audioFilePath).toBeUndefined();
      expect(p.uploadedTempPath).toBeUndefined();
      expect(p.uploadedTempPaths).toBeUndefined();
      expect(p.extendFromVideoPath).toBeUndefined();
    });

    // keyframes are stored as { path, index } (absolute gallery paths) but
    // must surface to the resuming client as { file, index } (basename only)
    // — same internal-path-leak rule as sourceImagePath, plus the client
    // picker's submit shape uses gallery filenames.
    it('maps stored keyframes { path, index } -> { file, index } without leaking the absolute path', async () => {
      mediaJobQueue.listJobs.mockImplementation(listJobsByFilter([
        { id: 'running-kf', kind: 'video', status: 'running', position: 1, params: {
          prompt: 'kf prompt', modelId: 'ltx2_unified', mode: 'fflf',
          keyframes: [
            { path: '/Users/secret/data/images/a.png', index: 0 },
            { path: '/Users/secret/data/images/b.png', index: 24 },
          ],
        } },
      ]));
      const r = await request(app).get('/api/video-gen/active');
      expect(r.status).toBe(200);
      const p = r.body.activeJob.params;
      expect(p.keyframes).toEqual([
        { file: 'a.png', index: 0 },
        { file: 'b.png', index: 24 },
      ]);
      // The absolute server path must never round-trip.
      expect(JSON.stringify(p.keyframes)).not.toMatch(/secret/);
    });

    // Defensive: malformed keyframe entries (missing path / non-integer index)
    // are dropped rather than surfaced as half-formed picker rows. When every
    // entry is malformed, keyframes is omitted entirely (no empty array).
    it('drops malformed keyframe entries and omits keyframes when none survive', async () => {
      mediaJobQueue.listJobs.mockImplementation(listJobsByFilter([
        { id: 'running-bad-kf', kind: 'video', status: 'running', position: 1, params: {
          prompt: 'p', modelId: 'ltx2_unified',
          keyframes: [{ index: 0 }, { path: '/x/y.png', index: 'nope' }, null],
        } },
      ]));
      const r = await request(app).get('/api/video-gen/active');
      expect(r.status).toBe(200);
      expect(r.body.activeJob.params.keyframes).toBeUndefined();
    });
  });

  describe('GET /:jobId/events', () => {
    it('returns 404 when the job is unknown', async () => {
      mediaJobQueue.attachSseClient.mockReturnValue(false);
      const r = await request(app).get('/api/video-gen/unknown-job/events');
      expect(r.status).toBe(404);
      expect(r.body.error).toMatch(/not found/i);
    });
  });

  describe('POST /cancel', () => {
    it('reports nothing to cancel when no video render is running', async () => {
      mediaJobQueue.listJobs.mockReturnValue([]);
      const r = await request(app).post('/api/video-gen/cancel').send({});
      expect(r.status).toBe(404);
      expect(r.body).toMatchObject({ code: 'NOT_FOUND' });
    });

    it('cancels the running video render through the queue', async () => {
      mediaJobQueue.listJobs.mockReturnValue([{ id: 'running-job', kind: 'video', status: 'running' }]);
      mediaJobQueue.cancelJob.mockResolvedValue({ ok: true, status: 'canceling' });
      const r = await request(app).post('/api/video-gen/cancel').send({});
      expect(r.status).toBe(200);
      expect(r.body.ok).toBe(true);
      expect(mediaJobQueue.cancelJob).toHaveBeenCalledWith('running-job');
    });

    // jobId in the body cancels a specific job, even if it's still queued.
    it('cancels a specific queued job when jobId is supplied', async () => {
      const jobs = [
        { id: 'running-1', kind: 'video', status: 'running' },
        { id: 'queued-2',  kind: 'video', status: 'queued' },
      ];
      // The route calls listJobs({ kind: 'video' }) — replicate the production
      // queue's filter semantics (status filter is optional).
      mediaJobQueue.listJobs.mockImplementation(({ status, kind } = {}) => jobs.filter((j) => {
        if (status && j.status !== status) return false;
        if (kind && j.kind !== kind) return false;
        return true;
      }));
      mediaJobQueue.cancelJob.mockResolvedValue({ ok: true, status: 'canceled' });
      const r = await request(app).post('/api/video-gen/cancel').send({ jobId: 'queued-2' });
      expect(r.status).toBe(200);
      expect(r.body.ok).toBe(true);
      expect(mediaJobQueue.cancelJob).toHaveBeenCalledWith('queued-2');
    });

    // A supplied-but-malformed jobId must NOT degrade to "absent" (which cancels
    // the running render) — it would kill a render the caller never named (#9932).
    it.each([
      ['array', []],
      ['object', {}],
      ['null', null],
      ['whitespace', '   '],
      ['number', 7],
    ])('rejects a %s jobId with 400 and cancels nothing', async (_label, jobId) => {
      mediaJobQueue.listJobs.mockReturnValue([{ id: 'running-b', kind: 'video', status: 'running' }]);
      const r = await request(app).post('/api/video-gen/cancel').send({ jobId });
      expect(r.status).toBe(400);
      expect(r.body.code).toBe('VALIDATION_ERROR');
      expect(mediaJobQueue.cancelJob).not.toHaveBeenCalled();
    });

    it('does not fall back to the running job when the named id is stale', async () => {
      mediaJobQueue.listJobs.mockImplementation(({ status, kind } = {}) => [
        { id: 'finished-a', kind: 'video', status: 'completed' },
        { id: 'running-b', kind: 'video', status: 'running' },
      ].filter((j) => (!status || j.status === status) && (!kind || j.kind === kind)));
      const r = await request(app).post('/api/video-gen/cancel').send({ jobId: 'finished-a' });
      expect(r.status).toBe(409);
      expect(r.body.code).toBe('ALREADY_TERMINAL');
      expect(mediaJobQueue.cancelJob).not.toHaveBeenCalled();
    });

    it('returns 404 NOT_FOUND for a named id the queue does not know', async () => {
      mediaJobQueue.listJobs.mockReturnValue([{ id: 'running-b', kind: 'video', status: 'running' }]);
      const r = await request(app).post('/api/video-gen/cancel').send({ jobId: 'ghost' });
      expect(r.status).toBe(404);
      expect(r.body.code).toBe('NOT_FOUND');
      expect(mediaJobQueue.cancelJob).not.toHaveBeenCalled();
    });

    it.each([
      ['ALREADY_TERMINAL', 409],
      ['NOT_FOUND', 404],
    ])('maps a queue refusal %s to %i instead of 200', async (code, status) => {
      mediaJobQueue.listJobs.mockReturnValue([{ id: 'running-b', kind: 'video', status: 'running' }]);
      mediaJobQueue.cancelJob.mockResolvedValue({ ok: false, code });
      const r = await request(app).post('/api/video-gen/cancel').send({ jobId: 'running-b' });
      expect(r.status).toBe(status);
      expect(r.body.code).toBe(code);
    });

    // No running job and no jobId — fall back to newest queued so the user
    // can pull back a recent submission before it starts.
    it('falls back to newest queued video when no jobId and nothing is running', async () => {
      const jobs = [
        { id: 'queued-old', kind: 'video', status: 'queued' },
        { id: 'queued-new', kind: 'video', status: 'queued' },
      ];
      mediaJobQueue.listJobs.mockImplementation(({ status, kind } = {}) => jobs.filter((j) => {
        if (status && j.status !== status) return false;
        if (kind && j.kind !== kind) return false;
        return true;
      }));
      mediaJobQueue.cancelJob.mockResolvedValue({ ok: true, status: 'canceled' });
      const r = await request(app).post('/api/video-gen/cancel').send({});
      expect(r.status).toBe(200);
      expect(r.body.ok).toBe(true);
      expect(mediaJobQueue.cancelJob).toHaveBeenCalledWith('queued-new');
    });
  });

  describe('GET /history', () => {
    it('returns the full history list', async () => {
      videoGenService.loadHistory.mockResolvedValue([{ id: 'a' }, { id: 'b' }]);
      const r = await request(app).get('/api/video-gen/history');
      expect(r.status).toBe(200);
      expect(r.body).toHaveLength(2);
    });

    it('validates the opt-in query and returns a bounded page', async () => {
      videoGenLeaves.readHistorySnapshot.mockResolvedValue(Object.freeze([
        Object.freeze({ id: 'a', createdAt: '2026-01-01' }),
        Object.freeze({ id: 'b', createdAt: '2026-02-01' }),
      ]));
      const page = await request(app).get('/api/video-gen/history?limit=1&compact=true');
      expect(page.status).toBe(200);
      expect(page.body.map((i) => i.id)).toEqual(['b']);
      expect(videoGenService.loadHistory).not.toHaveBeenCalled();
      expect((await request(app).get('/api/video-gen/history?limit=999')).status).toBe(400);
    });
  });

  describe('GET /history/:id', () => {
    it('returns the exact final file and its encoded song timing together', async () => {
      const entry = { id: 'music-final', filename: 'final.mp4', fps: 24, songStartSec: 49 / 24, songDurationSec: 8 };
      videoGenService.getHistoryItem.mockResolvedValue(entry);
      const response = await request(app).get('/api/video-gen/history/music-final');
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject(entry);
      expect(videoGenService.getHistoryItem).toHaveBeenCalledWith('music-final');
    });

    // Hosted clips lack stored geometry; the animatic needs the cadence the renderer measures.
    it('measures geometry only when requested and missing, without changing the stored entry', async () => {
      const entry = Object.freeze({ id: 'hosted', filename: 'hosted.mp4' });
      videoGenService.getHistoryItem.mockResolvedValue(entry);
      probeVideoGeometry.mockResolvedValue({ width: 1280, height: 720, fps: 30, numFrames: 60 });
      const plain = await request(app).get('/api/video-gen/history/hosted');
      expect(plain.body).toEqual(entry);
      expect(probeVideoGeometry).not.toHaveBeenCalled();
      const measured = await request(app).get('/api/video-gen/history/hosted?geometry=true');
      expect(measured.status).toBe(200);
      expect(measured.body).toEqual({ ...entry, width: 1280, height: 720, fps: 30, numFrames: 60 });
      expect(probeVideoGeometry).toHaveBeenCalledTimes(1);
      expect(entry).toEqual({ id: 'hosted', filename: 'hosted.mp4' });
      videoGenService.getHistoryItem.mockResolvedValue(measured.body);
      await request(app).get('/api/video-gen/history/hosted?geometry=true');
      expect(probeVideoGeometry).toHaveBeenCalledTimes(1);
    });

    it('refuses unavailable geometry, unsafe filenames and malformed geometry requests', async () => {
      videoGenService.getHistoryItem.mockResolvedValue({ id: 'hosted', filename: 'hosted.mp4' });
      probeVideoGeometry.mockResolvedValue(null);
      expect((await request(app).get('/api/video-gen/history/hosted?geometry=true')).status).toBe(422);
      videoGenService.getHistoryItem.mockResolvedValue({ id: 'hosted', filename: '../outside.mp4' });
      expect((await request(app).get('/api/video-gen/history/hosted?geometry=true')).status).toBe(422);
      expect(probeVideoGeometry).toHaveBeenCalledTimes(1);
      expect((await request(app).get('/api/video-gen/history/hosted?geometry=maybe')).status).toBe(400);
    });

    // The point of the route (#4165): a timeline render's history id is a
    // randomUUID() that has nothing to do with its `timeline-*.mp4` filename,
    // so a client holding only the id learns the real file from HERE instead of
    // downloading the whole history list to find one row.
    it('returns the one entry, resolving an id whose filename is unrelated to it', async () => {
      const entry = { id: 'final-1', filename: 'timeline-abcd1234-1700000000000.mp4', thumbnail: 'final-1.jpg' };
      videoGenService.getHistoryItem.mockResolvedValueOnce(entry);
      const r = await request(app).get('/api/video-gen/history/final-1');
      expect(r.status).toBe(200);
      expect(r.body).toEqual(entry);
      expect(videoGenService.getHistoryItem).toHaveBeenCalledWith('final-1');
      // Never the full list — that fan-out is exactly what this replaced.
      expect(videoGenService.loadHistory).not.toHaveBeenCalled();
    });

    it('returns the full generated clip record', async () => {
      const entry = Object.freeze({ id: 'clip-1', filename: 'clip-1.mp4', prompt: 'Full prompt', provider: 'local', fps: 24 });
      videoGenService.getHistoryItem.mockResolvedValueOnce(entry);
      const r = await request(app).get('/api/video-gen/history/clip-1');
      expect(r.status).toBe(200);
      expect(r.body).toEqual(entry);
    });

    it('404s for an id that is not in history', async () => {
      videoGenService.getHistoryItem.mockResolvedValueOnce(null);
      const r = await request(app).get('/api/video-gen/history/gone-1');
      expect(r.status).toBe(404);
      expect(videoGenService.getHistoryItem).toHaveBeenCalledWith('gone-1');
    });

    it('decodes a percent-encoded id before looking it up', async () => {
      videoGenService.getHistoryItem.mockResolvedValueOnce(null);
      await request(app).get('/api/video-gen/history/a%2Eb-c');
      expect(videoGenService.getHistoryItem).toHaveBeenCalledWith('a.b-c');
    });

    it('rejects an absurdly long id without touching the service', async () => {
      const r = await request(app).get(`/api/video-gen/history/${'x'.repeat(201)}`);
      expect(r.status).toBe(400);
      expect(videoGenService.getHistoryItem).not.toHaveBeenCalled();
    });

    // The lookup schema is deliberately looser than the UUID gate on
    // /last-frame and /upscale, because history rows also arrive from a
    // caller-supplied download id and from federated peers (#5713).
    it('accepts a legitimate non-UUID federated id', async () => {
      const entry = { id: 'dl-abc_123', filename: 'peer.mp4' };
      videoGenService.getHistoryItem.mockResolvedValueOnce(entry);
      const r = await request(app).get('/api/video-gen/history/dl-abc_123');
      expect(r.status).toBe(200);
      expect(videoGenService.getHistoryItem).toHaveBeenCalledWith('dl-abc_123');
    });
  });

  describe('DELETE /history/:id', () => {
    it('deletes through the owner-aware delete and returns its status', async () => {
      mediaRemoteDelete.deleteMediaAnywhere.mockResolvedValueOnce({ status: 'pending', pendingDelete: { peerId: 'peer-a', queuedAt: '2026-01-01T00:00:00.000Z' } });
      const r = await request(app).delete('/api/video-gen/history/abc');
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ ok: true, status: 'pending' });
      expect(mediaRemoteDelete.deleteMediaAnywhere).toHaveBeenCalledWith('video', 'abc');
      expect(mediaUsage.assertMediaDeletable).toHaveBeenLastCalledWith('video:abc', { force: false });
      await request(app).delete('/api/video-gen/history/abc?force=1');
      expect(mediaUsage.assertMediaDeletable).toHaveBeenLastCalledWith('video:abc', { force: true });
    });

    it('deletes a legitimate non-UUID federated id', async () => {
      const r = await request(app).delete('/api/video-gen/history/dl-abc_123');
      expect(r.status).toBe(200);
      expect(r.body.status).toBe('deleted');
      expect(mediaRemoteDelete.deleteMediaAnywhere).toHaveBeenCalledWith('video', 'dl-abc_123');
    });

    // The destructive verb shipped with NO id validation, so a value carrying a
    // path segment reached deleteHistoryItem — which interpolates the id into
    // nine `${id}-fN.jpg` thumbnail unlinks. Gate it at the boundary (#5713).
    it('rejects an id carrying a path segment without touching the service', async () => {
      mediaRemoteDelete.deleteMediaAnywhere.mockClear();
      const r = await request(app).delete(`/api/video-gen/history/${encodeURIComponent('../../etc/passwd')}`);
      expect(r.status).toBe(400);
      expect(r.body.code).toBe('VALIDATION_ERROR');
      expect(mediaRemoteDelete.deleteMediaAnywhere).not.toHaveBeenCalled();
    });

    it('cancels a pending delete', async () => {
      const r = await request(app).post('/api/video-gen/history/abc/cancel-delete');
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ ok: true, cancelled: true });
      expect(mediaRemoteDelete.cancelPendingDelete).toHaveBeenCalledWith('video', 'abc');
    });
  });

  describe('POST /history/:id/visibility', () => {
    it('forwards the requested hidden flag', async () => {
      videoGenService.setHistoryItemHidden.mockResolvedValue({ ok: true, hidden: true });
      const r = await request(app).post('/api/video-gen/history/abc/visibility').send({ hidden: true });
      expect(r.status).toBe(200);
      expect(videoGenService.setHistoryItemHidden).toHaveBeenCalledWith('abc', true);
    });

    // `!!req.body?.hidden` read a missing body as "unhide", so a malformed
    // request silently un-hid the row instead of failing (#5713).
    it('rejects a body without a boolean hidden rather than unhiding', async () => {
      const r = await request(app).post('/api/video-gen/history/abc/visibility').send({});
      expect(r.status).toBe(400);
      expect(r.body.code).toBe('VALIDATION_ERROR');
      expect(videoGenService.setHistoryItemHidden).not.toHaveBeenCalled();
    });

    it('rejects an id carrying a path segment', async () => {
      const r = await request(app)
        .post(`/api/video-gen/history/${encodeURIComponent('../../etc/passwd')}/visibility`)
        .send({ hidden: true });
      expect(r.status).toBe(400);
      expect(videoGenService.setHistoryItemHidden).not.toHaveBeenCalled();
    });
  });

  describe('POST /history/:id/trim', () => {
    const id = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaa1';

    it('returns the new trimmed clip', async () => {
      trimHistoryItem.mockResolvedValue({ id: 'new-clip', trimStartSec: 1.25 });
      const r = await request(app).post(`/api/video-gen/history/${id}/trim`).send({ startSec: 1.25 });
      expect(r.status).toBe(200);
      expect(r.body.video).toEqual({ id: 'new-clip', trimStartSec: 1.25 });
      expect(trimHistoryItem).toHaveBeenCalledWith(id, { startSec: 1.25 });
    });

    it('rejects a missing, non-positive or inverted range before trimming', async () => {
      for (const body of [{}, { startSec: 0 }, { startSec: '2' }, { endSec: 0 }, { startSec: 2, endSec: 1 }]) {
        const r = await request(app).post(`/api/video-gen/history/${id}/trim`).send(body);
        expect(r.status).toBe(400);
      }
      expect(trimHistoryItem).not.toHaveBeenCalled();
    });
  });

  describe('POST /last-frame/:id', () => {
    it('forwards a shared-gallery upload id to extractLastFrame', async () => {
      const uploadId = 'upload-ab12cd34';
      videoGenService.extractLastFrame.mockResolvedValue({ filename: `anchor-${uploadId}.png` });

      const r = await request(app).post(`/api/video-gen/last-frame/${uploadId}`).send({});

      expect(r.status).toBe(200);
      expect(videoGenService.extractLastFrame).toHaveBeenCalledWith(uploadId);
    });

    it('rejects malformed ids before extracting a frame', async () => {
      const r = await request(app).post('/api/video-gen/last-frame/not-a-history-id').send({});

      expect(r.status).toBe(400);
      expect(videoGenService.extractLastFrame).not.toHaveBeenCalled();
    });
  });

  describe('POST /stitch', () => {
    const validId = (n) => `aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaa${n}`;

    it('rejects when videoIds is not an array', async () => {
      const r = await request(app).post('/api/video-gen/stitch').send({ videoIds: 'not-array' });
      expect(r.status).toBe(400);
    });

    it('rejects when videoIds contains malformed history ids', async () => {
      const r = await request(app).post('/api/video-gen/stitch').send({ videoIds: ['../etc/passwd', 'b'] });
      expect(r.status).toBe(400);
    });

    it('rejects when videoIds has fewer than 2 entries', async () => {
      const r = await request(app).post('/api/video-gen/stitch').send({ videoIds: [validId(1)] });
      expect(r.status).toBe(400);
    });

    it('queues the stitch and answers with the job before ffmpeg runs', async () => {
      stitchJobService.enqueueStitch.mockResolvedValue({ jobId: 'job-s1', position: 1, status: 'queued' });
      const r = await request(app).post('/api/video-gen/stitch').send({ videoIds: [validId(1), validId(2)] });
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ ok: true, job: { jobId: 'job-s1', position: 1, status: 'queued' } });
      expect(stitchJobService.enqueueStitch).toHaveBeenCalledWith([validId(1), validId(2)]);
      expect(videoGenService.stitchVideos).not.toHaveBeenCalled();
    });

    it('accepts a shared-gallery upload history id', async () => {
      stitchJobService.enqueueStitch.mockResolvedValue({ jobId: 'job-s2', position: 1, status: 'queued' });
      const uploadId = 'upload-ab12cd34';
      const r = await request(app).post('/api/video-gen/stitch').send({ videoIds: [uploadId, validId(2)] });
      expect(r.status).toBe(200);
      expect(stitchJobService.enqueueStitch).toHaveBeenCalledWith([uploadId, validId(2)]);
    });
  });

  describe('POST /history/:id/vertical', () => {
    const id = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaa1';

    it('rejects an unknown ratio', async () => {
      const r = await request(app).post(`/api/video-gen/history/${id}/vertical`).send({ ratio: '16:9' });
      expect(r.status).toBe(400);
      expect(enqueueVertical).not.toHaveBeenCalled();
    });

    it('queues the export and returns the job', async () => {
      enqueueVertical.mockResolvedValue({ jobId: 'job-v1', position: 1, status: 'queued' });
      const r = await request(app).post(`/api/video-gen/history/${id}/vertical`).send({ ratio: '4:5' });
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ ok: true, job: { jobId: 'job-v1', position: 1, status: 'queued' } });
      expect(enqueueVertical).toHaveBeenCalledWith(id, '4:5');
    });
  });

  describe('POST /upscale/:id', () => {
    const validHistoryId = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaa1';
    const otherValidId = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbb2';

    it('rejects history ids outside known render and upload shapes', async () => {
      const r = await request(app).post('/api/video-gen/upscale/not-a-uuid').send({});
      expect(r.status).toBe(400);
      expect(videoGenService.upscaleHistoryItem).not.toHaveBeenCalled();
    });

    it('forwards id to upscaleHistoryItem and wraps the new entry', async () => {
      const upscaled = { id: otherValidId, filename: `${otherValidId}.mp4`, width: 1536, height: 1024, upscaledFrom: validHistoryId };
      videoGenService.upscaleHistoryItem.mockResolvedValue(upscaled);
      const r = await request(app).post(`/api/video-gen/upscale/${validHistoryId}`).send({});
      expect(r.status).toBe(200);
      expect(r.body.ok).toBe(true);
      expect(r.body.video).toEqual(upscaled);
      expect(videoGenService.upscaleHistoryItem).toHaveBeenCalledWith(validHistoryId, { method: 'lanczos' });
    });

    it('forwards a shared-gallery upload id to upscaleHistoryItem', async () => {
      const uploadId = 'upload-ab12cd34';
      videoGenService.upscaleHistoryItem.mockResolvedValue({ id: otherValidId, filename: `${otherValidId}.mp4`, upscaledFrom: uploadId });
      const r = await request(app).post(`/api/video-gen/upscale/${uploadId}`).send({});
      expect(r.status).toBe(200);
      expect(videoGenService.upscaleHistoryItem).toHaveBeenCalledWith(uploadId, { method: 'lanczos' });
    });

    it('returns the ServerError status when the service rejects', async () => {
      videoGenService.upscaleHistoryItem.mockRejectedValue(
        Object.assign(new Error('Video not found'), { status: 404, code: 'NOT_FOUND' }),
      );
      const r = await request(app).post(`/api/video-gen/upscale/${validHistoryId}`).send({});
      expect(r.status).toBe(404);
      expect(r.body.error).toMatch(/not found/i);
    });

    // Method selection (#6509). The whole point of the default is that a client
    // written before the option existed keeps its exact behavior, so the
    // no-body request and the explicit Lanczos request must be indistinguishable
    // at the service boundary.
    it('sends an explicit lanczos request identically to a no-body request', async () => {
      videoGenService.upscaleHistoryItem.mockResolvedValue({ id: otherValidId });
      await request(app).post(`/api/video-gen/upscale/${validHistoryId}`).send({});
      await request(app).post(`/api/video-gen/upscale/${validHistoryId}`).send({ method: 'lanczos' });
      const [noBody, explicit] = videoGenService.upscaleHistoryItem.mock.calls;
      expect(explicit).toEqual(noBody);
    });

    // The generative method answers with a QUEUED JOB, not a finished row: it
    // is a multi-minute GPU render, so running it inline would hold the request
    // open and skip cancellation/watchdog/partial-output cleanup (#6511).
    it('queues the generative method instead of running it inline', async () => {
      upscaleJobService.enqueueLtxUpscale.mockResolvedValue({ jobId: 'job-1', position: 2, status: 'queued' });
      const r = await request(app).post(`/api/video-gen/upscale/${validHistoryId}`).send({ method: 'ltx' });
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ ok: true, job: { jobId: 'job-1', position: 2, status: 'queued' } });
      expect(upscaleJobService.enqueueLtxUpscale).toHaveBeenCalledWith(validHistoryId);
      expect(videoGenService.upscaleHistoryItem).not.toHaveBeenCalled();
    });

    it('rejects an unknown method with a 400 and never reaches the service', async () => {
      const r = await request(app).post(`/api/video-gen/upscale/${validHistoryId}`).send({ method: 'realesrgan' });
      expect(r.status).toBe(400);
      expect(videoGenService.upscaleHistoryItem).not.toHaveBeenCalled();
    });

    it('surfaces the 501 capability error the service raises for an unavailable runtime', async () => {
      upscaleJobService.enqueueLtxUpscale.mockRejectedValue(
        Object.assign(new Error('needs LTX-2.5 MLX (ltx25)'), { status: 501, code: 'UNSUPPORTED_RUNTIME' }),
      );
      const r = await request(app).post(`/api/video-gen/upscale/${validHistoryId}`).send({ method: 'ltx' });
      expect(r.status).toBe(501);
      expect(r.body.error).toMatch(/ltx25/);
    });
  });

  describe('GET /upscale/:id/plan', () => {
    const validHistoryId = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaa1';

    it('rejects history ids outside known render and upload shapes', async () => {
      const r = await request(app).get('/api/video-gen/upscale/not-a-uuid/plan');
      expect(r.status).toBe(400);
      expect(videoGenService.planUpscaleHistoryItem).not.toHaveBeenCalled();
    });

    it('defaults to lanczos and wraps the plan', async () => {
      const plan = { id: validHistoryId, method: 'lanczos', scale: 2 };
      videoGenService.planUpscaleHistoryItem.mockResolvedValue(plan);
      const r = await request(app).get(`/api/video-gen/upscale/${validHistoryId}/plan`);
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ ok: true, plan });
      expect(videoGenService.planUpscaleHistoryItem).toHaveBeenCalledWith(validHistoryId, { method: 'lanczos' });
    });

    it('forwards the requested method', async () => {
      videoGenService.planUpscaleHistoryItem.mockResolvedValue({ method: 'ltx' });
      await request(app).get(`/api/video-gen/upscale/${validHistoryId}/plan?method=ltx`);
      expect(videoGenService.planUpscaleHistoryItem).toHaveBeenCalledWith(validHistoryId, { method: 'ltx' });
    });

    it('rejects an unknown method with a 400', async () => {
      const r = await request(app).get(`/api/video-gen/upscale/${validHistoryId}/plan?method=realesrgan`);
      expect(r.status).toBe(400);
      expect(videoGenService.planUpscaleHistoryItem).not.toHaveBeenCalled();
    });

    // #6502: nothing may be queued or downloaded before the user submits.
    it('never touches the upscale action', async () => {
      videoGenService.planUpscaleHistoryItem.mockResolvedValue({ method: 'ltx' });
      await request(app).get(`/api/video-gen/upscale/${validHistoryId}/plan?method=ltx`);
      expect(videoGenService.upscaleHistoryItem).not.toHaveBeenCalled();
    });
  });

  // The IC-LoRA provisioning endpoints span the whole weight registry, not just
  // the remix modes — the LTX-2.5 upscale adapter (#6502) is downloadable and
  // repairable without ever being a render mode. These pin that split.
  describe('IC-LoRA provisioning endpoints', () => {
    const upscaler = IC_LORA_MODES['pixel-upscale'];

    it('downloads only the gated LTX 2.5 Ingredients adapter file', async () => {
      const spec = IC_LORA_MODES['ingredients-25'];
      const res = await request(app).post('/api/video-gen/ic-loras/ic-ingredients-25/download');
      expect(res.status).toBe(200);
      const [{ fallbacks, repo }] = sseDownload.start.mock.calls[0];
      expect(repo).toBeUndefined();
      expect(fallbacks).toEqual([{ repo: spec.repo, only: [spec.filename], revision: spec.revision }]);
    });

    it('downloads a pinned weight single-file, at its pinned revision', async () => {
      const res = await request(app).post(`/api/video-gen/ic-loras/${icLoraWeightKey(upscaler)}/download`);
      expect(res.status).toBe(200);
      const [{ fallbacks, repo }] = sseDownload.start.mock.calls[0];
      // Never a whole-repo snapshot: the pin names one commit and one file, and
      // a bare `repo` argument would ignore both.
      expect(repo).toBeUndefined();
      expect(fallbacks).toEqual([{
        repo: upscaler.repo,
        only: [upscaler.filename],
        revision: upscaler.revision,
      }]);
    });

    it('keeps an unpinned, un-mirrored weight on the cheap whole-repo path', async () => {
      const res = await request(app).post('/api/video-gen/ic-loras/ic-control/download');
      expect(res.status).toBe(200);
      const [args] = sseDownload.start.mock.calls[0];
      expect(args.repo).toBe(IC_LORA_MODES.control.repo);
      expect(args.fallbacks).toBeUndefined();
    });

    it('404s an unknown weight key and names the real ones', async () => {
      const res = await request(app).post('/api/video-gen/ic-loras/not-a-weight/download');
      expect(res.status).toBe(404);
      expect(res.body.error).toMatch(/pixel-upscale/);
      expect(res.body.error).toMatch(/ic-control/);
    });

    it('rejects the upscale adapter as a render mode', async () => {
      // The registry entry exists, so the only thing keeping it out of a render
      // is the mode enum. Every spelling must 400 rather than reaching the
      // LTX-2.3 remix pipeline it cannot be fused into.
      expect(listIcLoraRemixModes()).not.toContain(upscaler);
      for (const mode of ['pixel-upscale', 'ic-pixel-upscale']) {
        const res = await request(app).post('/api/video-gen/').send({ prompt: 'Example shot', mode });
        expect(res.status).toBe(400);
      }
    });
  });
});
