/**
 * The Suno step with a fake browser page and a fake CDN. Pins what only this
 * layer knows: a signed-out page is a login-required park (not a generic
 * failure), songs already in the workspace are never mistaken for ours, audio
 * requires decoding and verified completion, and a retry reuses submitted songs.
 */

import { EventEmitter } from 'node:events';
import { mkdtemp, access } from 'fs/promises';
import { findFfmpeg } from '../../lib/ffmpeg.js';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { __testing, generateSunoSong } from './autonomousSuno.js';

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, mkdtemp: vi.fn(actual.mkdtemp) };
});
const ffmpegAvailable = Boolean(await findFfmpeg());
const completed = { checkCompletion: async () => 'complete', validateAudio: async () => true };

const { downloadSunoAudio, submitSunoSong } = __testing;

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

describe('downloadSunoAudio', () => {
  afterEach(() => vi.useRealTimers());
  const body = (size) => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(size) });

  it('selects stable candidates for decoding and verified completion', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce(body(1000)) // too small — a stub
      .mockResolvedValueOnce(body(300 * 1024)) // growing
      .mockResolvedValueOnce(body(400 * 1024))
      .mockResolvedValueOnce(body(400 * 1024)); // stable
    const bytes = await downloadSunoAudio(NEW_A, { ...completed, fetchImpl, sleep: noSleep, now: () => 0 });
    expect(bytes.length).toBe(400 * 1024);
    expect(fetchImpl).toHaveBeenCalledTimes(5);
    expect(fetchImpl).toHaveBeenCalledWith(`https://cdn1.suno.ai/${NEW_A}.mp3`, { signal: expect.any(AbortSignal) });
  });

  it('times out with bounded diagnostics when it never finishes', async () => {
    let t = 0;
    await expect(downloadSunoAudio(NEW_A, {
      fetchImpl: async () => ({ ok: false }), sleep: noSleep, intervalMs: 10, timeoutMs: 25, now: () => (t += 10),
    })).rejects.toMatchObject({ code: 'SUNO_AUDIO_TIMEOUT', context: expect.objectContaining({ platform: 'Suno' }) });
  });
  it.each(['headers', 'body'])('aborts stalled %s at the overall deadline without leaking timers', async (phase) => {
    vi.useFakeTimers();
    let requestSignal;
    let bodyAborted = false;
    const fetchImpl = async (_url, { signal }) => {
      requestSignal = signal;
      const hang = () => new Promise((_resolve, reject) => signal.addEventListener('abort', () => {
        bodyAborted = phase === 'body';
        reject(signal.reason);
      }, { once: true }));
      if (phase === 'headers') return hang();
      return { ok: true, status: 200, bodyUsed: true, arrayBuffer: hang };
    };
    const assertion = expect(downloadSunoAudio(NEW_A, { fetchImpl, timeoutMs: 100 })).rejects.toMatchObject({
      code: 'SUNO_AUDIO_TIMEOUT', context: { reason: 'deadline_exceeded' },
    });
    await vi.advanceTimersByTimeAsync(100);
    await assertion;
    expect(requestSignal.aborted).toBe(true);
    expect(bodyAborted).toBe(phase === 'body');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels unread HTTP error bodies before retrying', async () => {
    let time = 0;
    const cancel = vi.fn(async () => {});
    await expect(downloadSunoAudio(NEW_A, {
      fetchImpl: async () => ({ ok: false, status: 503, body: { cancel } }),
      now: () => time, sleep: async (ms) => { time += ms; }, timeoutMs: 25, intervalMs: 10,
    })).rejects.toMatchObject({ code: 'SUNO_AUDIO_TIMEOUT', context: { httpStatus: 503 } });
    expect(cancel).toHaveBeenCalledTimes(3);
  });

  it('never imports stable, decodable audio while generation is pending', async () => {
    let time = 0;
    const importAudio = vi.fn();
    await expect(generateSunoSong({}, {
      ...completed, checkCompletion: async () => 'pending', songIds: [NEW_A], importAudio,
      fetchImpl: async () => body(200 * 1024), now: () => time,
      sleep: async (ms) => { time += ms; }, timeoutMs: 25, intervalMs: 10,
    })).rejects.toMatchObject({ code: 'SUNO_AUDIO_TIMEOUT', context: { reason: 'generation_pending' } });
    expect(importAudio).not.toHaveBeenCalled();
  });

  it('imports bytes fetched after completion rather than certifying an earlier partial body', async () => {
    let checks = 0;
    let complete = false;
    const partial = Buffer.alloc(200 * 1024, 1);
    const finished = Buffer.alloc(200 * 1024, 2);
    const importAudio = vi.fn(async () => ({ filename: 'finished.mp3', sizeBytes: finished.length }));
    await generateSunoSong({}, {
      songIds: [NEW_A], importAudio, validateAudio: completed.validateAudio, sleep: noSleep,
      checkCompletion: async () => { complete = ++checks >= 2; return complete ? 'complete' : 'pending'; },
      fetchImpl: async () => new Response(complete ? finished : partial),
    });
    expect(importAudio).toHaveBeenCalledWith(finished);
  });

  it('preserves unknown completion explicitly and never resubmits on retry', async () => {
    const connect = vi.fn();
    const importAudio = vi.fn();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(generateSunoSong({}, {
        songIds: [NEW_A], connect, importAudio, validateAudio: completed.validateAudio,
        fetchImpl: async () => body(200 * 1024), sleep: noSleep,
      })).rejects.toMatchObject({ code: 'SUNO_AUDIO_COMPLETION_UNVERIFIED' });
    }
    expect(connect).not.toHaveBeenCalled();
    expect(importAudio).not.toHaveBeenCalled();
  });

  it('rejects large HTML responses and cancels unread content without importing', async () => {
    const importAudio = vi.fn();
    const cancel = vi.fn(async () => {});
    const arrayBuffer = vi.fn(async () => Buffer.alloc(200 * 1024, '<'));
    const error = await generateSunoSong({}, {
      ...completed, songIds: [NEW_A], importAudio,
      fetchImpl: async () => ({ ok: true, status: 200, headers: new Headers({ 'content-type': 'text/html' }), arrayBuffer, body: { cancel } }),
    }).catch(error => error);
    expect(error).toMatchObject({ code: 'SUNO_AUDIO_INVALID', context: { reason: 'non_audio_content' } });
    expect(importAudio).not.toHaveBeenCalled();
    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
    expect(JSON.stringify({ message: error.message, context: error.context })).not.toContain(NEW_A);
  });

});

describe('generateSunoSong', () => {
  const fields = { title: 't', style: 's', lyrics: 'l', instrumental: false };
  const audio = { ok: true, arrayBuffer: async () => new ArrayBuffer(200 * 1024) };
  const connect = async () => ({ browser: { close: async () => {} }, context: { newPage: async () => fakePage() } });

  it('submits once, downloads the first take and imports it', async () => {
    const importAudio = vi.fn(async () => ({ filename: 'music-x.mp3', sizeBytes: 204800 }));
    const onSubmitted = vi.fn();
    const out = await generateSunoSong(fields, { ...completed, connect, importAudio, onSubmitted, fetchImpl: async () => audio, sleep: noSleep, intervalMs: 0 });
    expect(out).toMatchObject({ songId: NEW_A, songIds: [NEW_A, NEW_B], filename: 'music-x.mp3' });
    expect(onSubmitted).toHaveBeenCalledWith([NEW_A, NEW_B]);
  });

  it('with songs already submitted, never opens the browser — a retry spends no new credits', async () => {
    const connectSpy = vi.fn(connect);
    const out = await generateSunoSong(fields, {
      ...completed, connect: connectSpy, importAudio: async () => ({ filename: 'm.mp3', sizeBytes: 1 }), songIds: [NEW_B],
      fetchImpl: async () => audio, sleep: noSleep, intervalMs: 0,
    });
    expect(connectSpy).not.toHaveBeenCalled();
    expect(out.songId).toBe(NEW_B);
  });
});

// Real decoder contract: synthetic PCM WAV avoids network calls and credits.
describe.skipIf(!ffmpegAvailable)('Suno audio decoding', () => {
  function wav() {
    const frames = 96_000;
    const bytes = Buffer.alloc(44 + frames * 2);
    bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
    bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
    bytes.writeUInt32LE(48_000, 24); bytes.writeUInt32LE(96_000, 28);
    bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
    bytes.write('data', 36); bytes.writeUInt32LE(frames * 2, 40);
    for (let i = 0; i < frames; i++) bytes.writeInt16LE(Math.round(8000 * Math.sin(i * Math.PI / 60)), 44 + i * 2);
    return bytes;
  }

  it.each(['valid', 'malformed', 'disguised-html'])('validates %s bytes before import and removes temporary artifacts', async (kind) => {
    const bytes = kind === 'valid' ? wav() : Buffer.alloc(200 * 1024, kind === 'malformed' ? 0 : '<html>private-body');
    const importAudio = vi.fn(async () => ({ filename: 'test.mp3', sizeBytes: bytes.length }));
    const firstTemp = mkdtemp.mock.results.length;
    const result = generateSunoSong({}, {
      songIds: [NEW_A], importAudio, checkCompletion: async () => 'complete',
      fetchImpl: async () => new Response(bytes, { headers: { 'content-type': 'audio/mpeg' } }), sleep: noSleep,
    });
    if (kind === 'valid') {
      await expect(result).resolves.toMatchObject({ filename: 'test.mp3' });
      expect(importAudio).toHaveBeenCalledWith(bytes);
    } else {
      const error = await result.catch(error => error);
      expect(error).toMatchObject({ code: 'SUNO_AUDIO_INVALID', context: { reason: 'decode_failed' } });
      expect(JSON.stringify({ message: error.message, context: error.context })).not.toMatch(/private-body|candidate|portos-suno-validation/);
      expect(importAudio).not.toHaveBeenCalled();
    }
    const temps = mkdtemp.mock.results.slice(firstTemp);
    expect(temps).toHaveLength(1);
    for (const temp of temps) await expect(access(await temp.value)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
