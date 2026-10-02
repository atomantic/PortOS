import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { findFfmpeg } from '../../lib/ffmpeg.js';

const { decode } = vi.hoisted(() => ({ decode: vi.fn(async () => ({ stdout: 'out_time_us=12000000\n' })) }));
vi.mock('../../lib/childProcess.js', () => ({ execFile: Object.assign(() => {}, { [Symbol.for('nodejs.util.promisify.custom')]: decode }) }));

vi.mock('../../lib/ffmpeg.js', () => ({ findFfmpeg: vi.fn(async () => 'ffmpeg') }));
import { __testing, generateSunoSong } from './autonomousSuno.js';

const { submitSunoSong } = __testing;

const OLD = '11111111-1111-1111-1111-111111111111';
const NEW_A = '22222222-2222-2222-2222-222222222222';
const NEW_B = '33333333-3333-3333-3333-333333333333';
const noSleep = async () => {};

/** A just-enough Playwright page: tracks fills/clicks and exposes song links that appear after Create. */
function fakePage({ url = 'https://suno.com/create', hasForm = true, modern = true, newTitleMatches = true, afterCreate = [NEW_A, NEW_B], onCreate, refusalSignals = { inspected: true, captcha: false, credits: false, signIn: false, contentPolicy: false } } = {}) {
  const fills = {};
  const events = new EventEmitter();
  let created = false;
  const locator = (selector) => {
    const handle = {
      count: async () => selector === 'textarea' ? (hasForm ? 1 : 0) : selector === '[role="textbox"][aria-label="Lyrics editor"]' ? (modern ? 1 : 0) : 1,
      waitFor: async () => {},
      fill: async (v) => { fills[selector] = v; },
      click: async () => {},
    };
    return { ...handle, first: () => handle };
  };
  const button = (role, options) => ({
    count: async () => role === 'textbox' || role === 'tab' ? (modern ? 1 : 0) : /instrumental|custom/.test(String(options.name)) ? (modern ? 0 : 1) : 1,
    first: () => ({ click: async () => {}, fill: async v => { fills[options.name] = v; } }),
    last: () => ({ click: async () => { created = true; onCreate?.(events); } }),
  });
  return {
    fills,
    on: events.on.bind(events),
    once: events.once.bind(events),
    emit: events.emit.bind(events),
    off: events.off.bind(events),
    listenerCount: events.listenerCount.bind(events),
    goto: vi.fn(async () => {}),
    url: () => url,
    locator,
    getByRole: button,
    evaluate: async (_fn, title) => title === undefined ? refusalSignals : [
      ...(title === null ? [`/song/${OLD}`] : []),
      ...(created && (title === null || newTitleMatches) ? afterCreate.map((id) => `/song/${id}`) : []),
    ],
    close: async () => {},
  };
}

describe('submitSunoSong', () => {
  const fields = { title: 'Neon Rain', style: 'synthwave', lyrics: '[verse]\nrain', instrumental: false };

  it('fills the custom form and returns only the songs that appeared after Create', async () => {
    const page = fakePage();
    const ids = await submitSunoSong(page, fields, { sleep: noSleep });
    expect(ids).toEqual([NEW_A, NEW_B]);
    expect(page.listenerCount('request')).toBe(0);
    expect(page.fills['[role="textbox"][aria-label="Lyrics editor"],textarea[placeholder*="lyrics" i]']).toBe('[verse]\nrain');
    expect(page.fills['textarea:not([aria-label]):not([placeholder="Describe the sound you want"])']).toBe('synthwave');
    expect(page.fills['input[placeholder*="title" i]:visible']).toBe('Neon Rain');
  });

  it('leaves the lyrics empty for an instrumental song', async () => {
    const page = fakePage();
    await submitSunoSong(page, { ...fields, instrumental: true, lyrics: '' }, { sleep: noSleep });
    expect(page.fills['[role="textbox"][aria-label="Lyrics editor"],textarea[placeholder*="lyrics" i]']).toBe('');
  });

  it('does not accept unrelated workspace rows that load after Create', async () => {
    let time = 0;
    await expect(submitSunoSong(fakePage({ newTitleMatches: false }), fields, {
      sleep: noSleep, now: () => (time += 30_000),
    })).rejects.toMatchObject({ code: 'SUNO_NO_SONG' });
  });

  it('distinguishes a click with no observed POST without inventing a refusal', async () => {
    let time = 0;
    const page = fakePage({ afterCreate: [] });
    await expect(submitSunoSong(page, fields, { sleep: noSleep, now: () => (time += 30_000) }))
      .rejects.toMatchObject({ code: 'SUNO_NO_SONG', context: {
        network: { observedPosts: 0, httpStatuses: [], failedPosts: 0, pendingPosts: 0, truncated: false },
        refusalSignals: { inspected: true, captcha: false, credits: false, signIn: false, contentPolicy: false },
      } });
    expect(page.listenerCount('request')).toBe(0);
    expect(page.listenerCount('response')).toBe(0);
    expect(page.listenerCount('requestfailed')).toBe(0);
  });

  it('reports bounded HTTP/failure evidence without private URLs or response bodies', async () => {
    let time = 0;
    const request = (url) => ({ method: () => 'POST', resourceType: () => 'fetch', url: () => url });
    const page = fakePage({ afterCreate: [], refusalSignals: { inspected: true, credits: true }, onCreate: (events) => {
      events.emit('request', request('https://suno.com.attacker.example/api?token=private-token'));
      const rejected = request('https://studio-api.prod.suno.com/api/generate/?token=private-token');
      events.emit('request', rejected);
      events.emit('response', { request: () => rejected, status: () => 403, text: () => 'private-body' });
      const failed = request('https://studio-api.prod.suno.com/private-account');
      events.emit('request', failed);
      events.emit('requestfailed', failed);
      for (let i = 0; i < 20; i += 1) events.emit('request', request('https://suno.com/api'));
    } });
    const error = await submitSunoSong(page, fields, { sleep: noSleep, now: () => (time += 30_000) }).catch((err) => err);
    expect(error).toMatchObject({ code: 'SUNO_NO_SONG', context: {
      network: { observedPosts: 16, httpStatuses: [403], failedPosts: 1, pendingPosts: 14, truncated: true },
      refusalSignals: { inspected: true, credits: true },
    } });
    expect(JSON.stringify({ message: error.message, context: error.context })).not.toMatch(/private-|studio-api|attacker/);
    expect(page.listenerCount('request')).toBe(0);
  });

  it('keeps the older Custom form compatible', async () => {
    const page = fakePage({ modern: false });
    await submitSunoSong(page, fields, { sleep: noSleep });
    expect(page.fills['[role="textbox"][aria-label="Lyrics editor"],textarea[placeholder*="lyrics" i]']).toBe(fields.lyrics);
    expect(page.fills['textarea[placeholder*="style" i]']).toBe(fields.style);
  });

  it('reports a signed-out page as login-required so the run parks for the operator', async () => {
    await expect(submitSunoSong(fakePage({ hasForm: false }), fields, { sleep: noSleep })).rejects.toMatchObject({ code: 'PUBLISH_LOGIN_REQUIRED' });
    await expect(submitSunoSong(fakePage({ url: 'https://accounts.suno.com/sign-in' }), fields, { sleep: noSleep })).rejects.toMatchObject({ code: 'PUBLISH_LOGIN_REQUIRED' });
  });
});

// Synthetic container signature; ffmpeg is mocked at its process boundary.
const m4a = Buffer.from([0, 0, 0, 24, 102, 116, 121, 112, 77, 52, 65, 32]);
function workflow({ bytes = m4a, stalled, failure = null, ignoreSelection = false, readyAfterMs = 0, landsInDir = null } = {}) {
  const page = fakePage();
  const baseRole = page.getByRole;
  const selected = new Set(['MP3', 'WAV', 'MP4 video asset']);
  const actions = [];
  let savedPath;
  const dirFiles = [];
  const listDownloads = vi.fn(async () => ({ downloadDir: landsInDir, files: [...dirFiles] }));
  const download = {
    saveAs: vi.fn(async (path) => {
      savedPath = path;
      await writeFile(path, bytes);
      if (stalled === 'save') return new Promise(() => {});
    }),
    failure: vi.fn(async () => failure),
    cancel: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
  };
  page.getByRole = (role, options) => {
    const name = options.name;
    if (typeof name === 'string' && ['M4A', 'MP3', 'WAV', 'MP4 video asset'].includes(name)) return {
      evaluate: async (fn) => fn({ classList: { contains: () => selected.has(name) } }),
      click: async () => { actions.push(name); if (ignoreSelection) return; selected.has(name) ? selected.delete(name) : selected.add(name); },
    };
    if (role === 'button' && String(name) === '/^(Unlock & Download|Download)$/') return { click: async () => {
      actions.push('export');
      expect(page.listenerCount('download')).toBe(1);
      if (landsInDir) {
        await writeFile(join(landsInDir, 'Example Song.m4a'), bytes);
        dirFiles.push({ name: 'Example Song.m4a', size: bytes.length, modified: '2026-01-01T00:00:00.000Z' });
      } else if (stalled !== 'event') page.emit('download', download);
    } };
    if (role === 'menuitem') return { click: async ({ timeout }) => {
      actions.push(name);
      if (readyAfterMs) {
        expect(timeout).toBeGreaterThan(readyAfterMs);
        await new Promise(resolve => setTimeout(resolve, readyAfterMs));
      }
    } };
    return baseRole(role, options);
  };
  page.close = vi.fn(async () => {});
  const browser = { close: vi.fn(async () => {}) };
  const connect = vi.fn(async () => ({ browser, context: { newPage: async () => page } }));
  const importAudio = vi.fn(async (path, name) => {
    expect(name).toBe('song.m4a');
    expect(await readFile(path)).toEqual(m4a);
    return { filename: 'music-example.m4a', sizeBytes: m4a.length };
  });
  return { page, selected, actions, download, savedPath: () => savedPath, browser, connect, importAudio, listDownloads, downloadPollMs: 5 };
}

describe('generateSunoSong M4A export', () => {
  const fields = { title: 'Example Song', style: 'synthwave', lyrics: 'example', instrumental: false };
  afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

  it('submits once, selects only M4A, saves the completed download, and imports the original file', async () => {
    const w = workflow();
    const onSubmitted = vi.fn();
    const out = await generateSunoSong(fields, { ...w, onSubmitted, sleep: noSleep });
    expect(out).toEqual({ songId: NEW_B, songIds: [NEW_A, NEW_B], filename: 'music-example.m4a', sizeBytes: m4a.length });
    expect(onSubmitted).toHaveBeenCalledWith([NEW_A, NEW_B]);
    expect(w.selected).toEqual(new Set(['M4A']));
    expect(w.actions.filter(x => x === 'export')).toHaveLength(1);
    expect(w.importAudio).toHaveBeenCalledTimes(1);
    expect(decode).toHaveBeenCalledWith('ffmpeg', expect.arrayContaining(['-protocol_whitelist', 'file', '-format_whitelist', 'mov', '-err_detect', 'explode']), expect.objectContaining({ timeout: 15_000, killSignal: 'SIGKILL', maxBuffer: 64 * 1024, signal: expect.any(AbortSignal) }));
    expect(w.page.listenerCount('download')).toBe(0);
    expect(w.page.close).toHaveBeenCalled();
    expect(w.browser.close).toHaveBeenCalled();
    await expect(stat(w.savedPath())).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reports each sub-step in order, skips generating on a resume, and survives a throwing reporter', async () => {
    const steps = [];
    await generateSunoSong(fields, { ...workflow(), sleep: noSleep, onProgress: (step) => steps.push(step) });
    expect(steps).toEqual(['opening', 'generating', 'exporting', 'validating', 'importing']);

    const resumed = [];
    await generateSunoSong(fields, { ...workflow(), songIds: [NEW_A], onProgress: (step) => resumed.push(step) });
    expect(resumed).toEqual(['opening', 'exporting', 'validating', 'importing']);

    const out = await generateSunoSong(fields, { ...workflow(), songIds: [NEW_A], onProgress: () => { throw new Error('reporter broke'); } });
    expect(out.filename).toBe('music-example.m4a');
  });

  it('imports an M4A the PortOS Browser saved to its download directory when Playwright emits no download event', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'portos-suno-test-'));
    try {
      const w = workflow({ landsInDir: dir });
      const out = await generateSunoSong(fields, { ...w, songIds: [NEW_A] });
      expect(out).toMatchObject({ filename: 'music-example.m4a' });
      expect(w.download.saveAs).not.toHaveBeenCalled();
      expect(w.actions.filter(x => x === 'export')).toHaveLength(1);
      expect(w.page.listenerCount('download')).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('never presses Create or imports when stopped while the form is opening', async () => {
    const w = workflow();
    const controller = new AbortController();
    w.page.goto.mockImplementationOnce(async () => controller.abort());
    const onSubmitted = vi.fn();
    await expect(generateSunoSong(fields, { ...w, signal: controller.signal, onSubmitted })).rejects.toThrow();
    expect(onSubmitted).not.toHaveBeenCalled();
    expect(w.page.listenerCount('request')).toBe(0);
    expect(w.actions).not.toContain('export');
    expect(w.importAudio).not.toHaveBeenCalled();
  });

  it('reopens an existing song for export without ever pressing Create', async () => {
    const w = workflow();
    const onSubmitted = vi.fn();
    const out = await generateSunoSong(fields, { ...w, songIds: [NEW_B], onSubmitted });
    expect(w.page.goto).toHaveBeenCalledExactlyOnceWith(`https://suno.com/song/${NEW_B}`, expect.any(Object));
    expect(w.page.fills).toEqual({});
    expect(onSubmitted).not.toHaveBeenCalled();
    expect(out.songId).toBe(NEW_B);
  });

  it.each(['event', 'save'])('bounds a stalled download %s and cleans up without importing or retrying the click', async (stalled) => {
    vi.useFakeTimers();
    const w = workflow({ stalled });
    const result = generateSunoSong(fields, { ...w, songIds: [NEW_A], timeoutMs: 1000 });
    const assertion = expect(result).rejects.toMatchObject({ code: 'SUNO_AUDIO_TIMEOUT', context: { reason: 'deadline-exceeded' } });
    await vi.waitFor(() => expect(w.actions).toContain('export'));
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
    expect(w.importAudio).not.toHaveBeenCalled();
    expect(w.page.listenerCount('download')).toBe(0);
    expect(w.actions.filter(x => x === 'export')).toHaveLength(1);
    expect(w.page.close).toHaveBeenCalled();
    if (stalled === 'save') {
      expect(w.download.cancel).toHaveBeenCalled();
      await expect(stat(w.savedPath())).rejects.toMatchObject({ code: 'ENOENT' });
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it('allows generation readiness to take longer than the ordinary browser step timeout', async () => {
    vi.useFakeTimers();
    const w = workflow({ readyAfterMs: 90_000 });
    const result = generateSunoSong(fields, { ...w, songIds: [NEW_A] });
    await vi.waitFor(() => expect(w.actions).toContain('Download'));
    await vi.advanceTimersByTimeAsync(90_000);
    await expect(result).resolves.toMatchObject({ filename: 'music-example.m4a' });
    expect(w.actions.filter(x => x === 'export')).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects a completed HTML response even when its body is song-sized', async () => {
    const w = workflow({ bytes: Buffer.from('<html>' + 'error'.repeat(30000)) });
    await expect(generateSunoSong(fields, { ...w, songIds: [NEW_A] })).rejects.toMatchObject({ code: 'SUNO_AUDIO_INVALID' });
    expect(w.importAudio).not.toHaveBeenCalled();
    expect(decode).not.toHaveBeenCalled();
    await expect(stat(w.savedPath())).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a successful decoder without positive audio frame evidence', async () => {
    const w = workflow();
    decode.mockResolvedValueOnce({ stdout: 'out_time_us=0\nprogress=end\n' });
    await expect(generateSunoSong(fields, { ...w, songIds: [NEW_A] })).rejects.toMatchObject({ code: 'SUNO_AUDIO_INVALID' });
    expect(w.importAudio).not.toHaveBeenCalled();
  });

  it('reports unavailable validation without importing when ffmpeg is absent', async () => {
    const w = workflow();
    findFfmpeg.mockResolvedValueOnce(null);
    await expect(generateSunoSong(fields, { ...w, songIds: [NEW_A] })).rejects.toMatchObject({ status: 503, code: 'SUNO_AUDIO_VALIDATION_UNAVAILABLE' });
    expect(w.importAudio).not.toHaveBeenCalled();
    expect(decode).not.toHaveBeenCalled();
  });

  it('cancels a pending save, removes listeners and staging files, and never imports', async () => {
    const w = workflow({ stalled: 'save' });
    const controller = new AbortController();
    const result = generateSunoSong(fields, { ...w, songIds: [NEW_A], signal: controller.signal });
    const assertion = expect(result).rejects.toMatchObject({ code: 'SUNO_AUDIO_CANCELLED' });
    await vi.waitFor(() => expect(w.download.saveAs).toHaveBeenCalled());
    controller.abort();
    await assertion;
    expect(w.download.cancel).toHaveBeenCalled();
    expect(w.importAudio).not.toHaveBeenCalled();
    expect(w.page.listenerCount('download')).toBe(0);
    await expect(stat(w.savedPath())).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('fails closed before unlock when the format selection no longer works', async () => {
    const w = workflow({ ignoreSelection: true });
    await expect(generateSunoSong(fields, { ...w, songIds: [NEW_A] })).rejects.toMatchObject({ context: { reason: 'format-selection-failed' } });
    expect(w.actions).not.toContain('export');
    expect(w.importAudio).not.toHaveBeenCalled();
  });

  it('rejects truncated audio even when its container metadata remains readable', async () => {
    const w = workflow();
    decode.mockRejectedValueOnce(new Error('private decoder output <user-home>/example.m4a'));
    await expect(generateSunoSong(fields, { ...w, songIds: [NEW_A] })).rejects.toMatchObject({ code: 'SUNO_AUDIO_INVALID' });
    expect(w.importAudio).not.toHaveBeenCalled();
  });

  it('finishes a timed-out export even when both browser close calls stall', async () => {
    vi.useFakeTimers();
    const w = workflow({ stalled: 'event' });
    w.page.close.mockImplementation(() => new Promise(() => {}));
    w.browser.close.mockImplementation(() => new Promise(() => {}));
    const result = generateSunoSong(fields, { ...w, songIds: [NEW_A], timeoutMs: 1000 });
    const assertion = expect(result).rejects.toMatchObject({ code: 'SUNO_AUDIO_TIMEOUT' });
    await vi.waitFor(() => expect(w.actions).toContain('export'));
    await vi.advanceTimersByTimeAsync(2000);
    await assertion;
    expect(w.page.listenerCount('download')).toBe(0);
    expect(w.importAudio).not.toHaveBeenCalled();
    expect(w.actions.filter(x => x === 'export')).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reports fixed browser failure metadata without private download details', async () => {
    const w = workflow({ failure: 'failed https://example.com/?token=example-secret <user-home>/downloads' });
    const error = await generateSunoSong(fields, { ...w, songIds: [NEW_A] }).catch(err => err);
    expect(error).toMatchObject({ code: 'SUNO_AUDIO_DOWNLOAD_FAILED', context: { stage: 'check-download', reason: 'browser-download-failed' } });
    expect(JSON.stringify({ message: error.message, context: error.context })).not.toMatch(/example-secret|https:|user-home/);
    expect(w.importAudio).not.toHaveBeenCalled();
  });
});
