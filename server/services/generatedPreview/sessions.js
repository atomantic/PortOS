/**
 * Isolated generated-preview sessions (#11157).
 *
 * Music-video documents, code-rendered videos, and code animations execute in
 * the OS-jailed composition browser. The user's browser receives JPEG frames;
 * a recording the user asked for is saved to Media History as an MP4 and the
 * browser receives its library URL. It never receives executable generated
 * HTML or private media bytes.
 */
import { randomUUID } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { PATHS } from '../../lib/fileUtils.js';
import { PREVIEW_PAGE_CSP } from '../../lib/generatedPreviewSandbox.js';
import { createCooperativePlayback, playbackSchema } from './cooperativePlayback.js';
import { stageCodeAnimationPage, writeComposition as writeNamedComposition } from './codeAnimationPage.js';
import { saveRecordingToMediaHistory } from './recordingSave.js';

const MAX_SESSIONS = 3;
const IDLE_MS = 120_000;
const AUDIO_CAP = 12 * 1024 * 1024;
const MUSIC_URL = /^\/data\/music\/([^/]+)$/;

const sessions = new Map();
const opening = new Map();
const bySocket = new Map();

const openSchema = z.object({
  requestId: z.string().uuid(),
  kind: z.enum(['music-video', 'music-video-code', 'code-animation']),
  projectId: z.string().min(1).max(80).optional(),
  jobId: z.string().min(1).max(80).optional(),
  draft: z.boolean().optional(),
  lyrics: z.boolean().optional(),
  withAudio: z.boolean().optional(),
  revision: z.string().max(500).optional(),
  html: z.string().max(700_000).optional(),
  audioUrl: z.string().max(200).optional(),
  audioGlobal: z.string().max(64).optional(),
  width: z.number().int().min(16).max(1920).optional(),
  height: z.number().int().min(16).max(1080).optional(),
  look: z.record(z.string(), z.unknown()).nullable().optional(),
  card: z.record(z.string(), z.unknown()).nullable().optional(),
}).strict();

const seekSchema = z.object({
  requestId: z.string().uuid(),
  sessionId: z.string().uuid(),
  generation: z.number().int().nonnegative(),
  t: z.number().min(0).max(86400),
  playing: z.boolean().optional(),
}).strict();

const commandSchema = z.object({
  requestId: z.string().uuid(),
  sessionId: z.string().uuid(),
  generation: z.number().int().nonnegative().optional(),
  action: z.enum(['film-look', 'title-card', 'record']),
  look: z.record(z.string(), z.unknown()).nullable().optional(),
  card: z.record(z.string(), z.unknown()).nullable().optional(),
  message: z.object({ type: z.string().min(1).max(80) }).strict().optional(),
  title: z.string().max(200).optional(),
}).strict();

const closeSchema = z.object({
  requestId: z.string().uuid().optional(),
  sessionId: z.string().uuid().optional(),
}).strict();

function fail(socket, payload) {
  socket.emit('generated-preview:error', payload);
}

function publicFailure(error) {
  const code = error?.code;
  if (code === 'PREVIEW_ISOLATION_UNAVAILABLE') {
    return { code, message: 'Isolated preview is unavailable on this host. Generated HTML is not run in this browser.' };
  }
  const safe = new Set(['NOT_ANALYZED', 'NO_TIMED_LYRICS', 'NO_TIMELINE', 'COMPOSITION_DOCUMENT_MISSING', 'NOT_CODE_MODE', 'NOT_FOUND']);
  if (safe.has(code)) return { code, message: String(error.message || 'Preview unavailable').slice(0, 300) };
  console.error(`❌ Generated preview failed: ${error?.message || error}`);
  return { code: 'PREVIEW_FAILED', message: 'The isolated preview could not start.' };
}

function armIdle(session) {
  clearTimeout(session.idle);
  session.idle = setTimeout(() => {
    closeSession(session.id, 'idle').catch((error) => {
      console.error(`❌ Generated preview idle close failed: ${error.message}`);
    });
  }, IDLE_MS);
  session.idle.unref?.();
}

function reserveSlot(socket) {
  let ids = bySocket.get(socket.id) || [];
  let pending = [...opening.values()].filter((item) => item.socketId === socket.id);
  while (ids.length + pending.length >= MAX_SESSIONS) {
    if (ids.length > 0) {
      const oldest = ids.shift();
      bySocket.set(socket.id, ids);
      closeSession(oldest, 'replaced').catch((error) => {
        console.error(`❌ Generated preview replace close failed: ${error.message}`);
      });
    } else if (pending.length > 0) {
      const oldestPending = pending.shift();
      oldestPending.abort.abort();
      for (const [reqId, item] of opening) {
        if (item === oldestPending) opening.delete(reqId);
      }
    } else {
      break;
    }
    ids = bySocket.get(socket.id) || [];
    pending = [...opening.values()].filter((item) => item.socketId === socket.id);
  }
}

function remember(socket, session) {
  const ids = bySocket.get(socket.id) || [];
  if (!ids.includes(session.id)) ids.push(session.id);
  bySocket.set(socket.id, ids);
  while (ids.length > MAX_SESSIONS) {
    const oldest = ids.shift();
    closeSession(oldest, 'replaced').catch((error) => {
      console.error(`❌ Generated preview replace close failed: ${error.message}`);
    });
  }
}

export async function closeSession(sessionId, reason = 'closed') {
  const session = sessions.get(sessionId);
  if (!session || session.closed) return;
  session.closed = true;
  sessions.delete(sessionId);
  clearTimeout(session.idle);
  session.playback?.close();
  const ids = bySocket.get(session.socket.id);
  if (ids) {
    const next = ids.filter((id) => id !== sessionId);
    if (next.length) bySocket.set(session.socket.id, next);
    else bySocket.delete(session.socket.id);
  }
  session.controller.abort();
  try { await session.page?.close(); } catch (error) {
    console.error(`❌ Generated preview browser close failed: ${error.message}`);
  }
  await session.playback?.settled();
  if (session.scratchRoot) {
    await rm(session.scratchRoot, { recursive: true, force: true }).catch((error) => {
      console.error(`❌ Generated preview scratch cleanup failed: ${error.message}`);
    });
  }
  session.socket.emit('generated-preview:closed', { sessionId, reason });
}

async function closeGeneratedPreviewsForSocket(socketId) {
  const ids = [...(bySocket.get(socketId) || [])];
  bySocket.delete(socketId);
  for (const [requestId, controller] of opening) {
    if (controller.socketId === socketId) {
      controller.abort.abort();
      opening.delete(requestId);
    }
  }
  await Promise.all(ids.map((id) => closeSession(id, 'disconnect')));
}

async function capture(page) {
  const shot = await page.send('Page.captureScreenshot', {
    format: 'jpeg', quality: 55, fromSurface: true, captureBeyondViewport: false,
  });
  return shot?.data || '';
}

async function applyJson(page, globalName, value) {
  const literal = JSON.stringify(value ?? null);
  if (literal.length > 20_000) throw new Error('Preview control is too large');
  await page.evaluate(`globalThis.${globalName} && globalThis.${globalName}.apply(${literal})`);
}

// A Code Animation page runs its own requestAnimationFrame clock. A seek takes
// that clock over: callbacks are held (not dropped) so releasing them, before a
// real-time record, resumes the page's loop. One native frame passes after the
// hold so a callback already queued cannot paint over the requested time. A
// page without renderFrame(t) (Record-only, or a module not yet run) keeps its
// own loop, since nothing else could draw the held frames.
const holdCodeAnimationClock = (time) => `(async () => {
  const w = window;
  if (typeof w.renderFrame !== 'function') return false;
  if (!w.__portosClock) {
    const raf = w.requestAnimationFrame.bind(w);
    const clock = { raf, held: [], on: false };
    w.__portosClock = clock;
    w.requestAnimationFrame = (callback) => {
      if (!clock.on) return raf(callback);
      clock.held.push(callback);
      return 0;
    };
  }
  const clock = w.__portosClock;
  if (!clock.on) {
    clock.on = true;
    await Promise.race([new Promise((resolve) => clock.raf(() => resolve())), new Promise((resolve) => setTimeout(resolve, 100))]);
  }
  await w.renderFrame(${time});
  return true;
})()`;

const RELEASE_CODE_ANIMATION_CLOCK = `(() => {
  const clock = window.__portosClock;
  if (!clock || !clock.on) return;
  clock.on = false;
  for (const callback of clock.held.splice(0)) clock.raf(callback);
})()`;

async function seekPage(session, t, playing = false) {
  const time = Number(t);
  if (session.kind === 'code-animation') {
    if (Number.isFinite(time)) await session.page.evaluate(holdCodeAnimationClock(Math.max(0, time)));
    return;
  }
  if (session.lyrics) {
    await session.page.evaluate(`window.postMessage({ type: 'portos-mv:seek', t: ${time} }, '*')`);
    await session.page.evaluate('new Promise((resolve) => setTimeout(resolve, 40))');
    return;
  }
  await session.page.evaluate(`(() => {
    const time = ${time};
    globalThis.__portosFilmLook?.playback(${playing === true});
    window.postMessage({ type: 'mv-code:seek', t: time }, '*');
    window.postMessage({ type: 'portos-mv:seek', t: time }, '*');
    const seek = globalThis.portosComposition && globalThis.portosComposition.seek;
    return typeof seek === 'function' ? seek(time) : null;
  })()`);
}

function emitFrame(session, generation, data, playback = null) {
  if (!data || session.closed) return;
  session.socket.emit('generated-preview:frame', {
    requestId: session.requestId, sessionId: session.id,
    ...(playback || { generation }), mime: 'image/jpeg', data,
  });
  armIdle(session);
}

async function runSeek(session, generation, t, playing = false) {
  if (session.playback) {
    await session.playback.seek(generation, t, playing).catch(session.playback.terminate);
    return;
  }
  if (session.seekTail) {
    session.pendingSeek = { generation, t, playing };
    return;
  }
  session.seekTail = (async () => {
    let next = { generation, t, playing };
    while (next && !session.closed) {
      const current = next;
      session.pendingSeek = null;
      if (current.generation < session.appliedGeneration) {
        next = session.pendingSeek;
        continue;
      }
      try {
        await seekPage(session, current.t, current.playing);
        // A playing Code Animation's new canvas arrives through its screencast;
        // a screenshot per frame would halve the rate.
        if (!(session.kind === 'code-animation' && current.playing)) emitFrame(session, current.generation, await capture(session.page));
        session.appliedGeneration = current.generation;
      } catch (error) {
        console.error(`❌ Generated preview seek failed: ${error.message}`);
        if (!session.closed) fail(session.socket, {
          requestId: session.requestId, sessionId: session.id, generation: current.generation,
          message: 'The preview could not move to that time.',
        });
      }
      next = session.pendingSeek;
    }
  })().finally(() => { session.seekTail = null; });
  await session.seekTail;
}

// A recording is accepted only while a record command is outstanding, so a
// page cannot fill the library by posting blobs on its own.
async function saveRecording(session) {
  const pending = session.recordPending;
  if (!pending || session.saving) return;
  session.saving = true;
  session.recordPending = null;
  const { requestId, id: sessionId, socket } = session;
  socket.emit('generated-preview:recording', { requestId, sessionId, status: 'saving' });
  try {
    const entry = await saveRecordingToMediaHistory(session.page, { title: pending.title });
    if (!entry) throw new Error('the page posted no recording');
    socket.emit('generated-preview:recording', {
      requestId, sessionId, status: 'saved',
      video: { id: entry.id, filename: entry.filename, url: `/data/videos/${entry.filename}`, durationSec: entry.durationSec ?? null },
    });
    console.log(`🎞️ Preview recording saved to Media History: ${entry.filename}`);
  } catch (error) {
    // Reported on the recording channel, not as a preview error: the preview
    // itself is still running.
    const refused = error?.code === 'RECORDING_TOO_LARGE' || error?.code === 'RECORDING_EMPTY';
    if (refused) console.log(`🚫 Preview recording refused: ${error.message}`);
    else console.error(`❌ Generated preview recording failed: ${error.message}`);
    socket.emit('generated-preview:recording', {
      requestId, sessionId, status: 'failed',
      message: refused ? error.message : 'The recording could not be saved to Media History.',
    });
  } finally {
    session.saving = false;
  }
}

function attachEvents(session) {
  session.onEvent = (message) => {
    if (session.closed) return;
    if (message.method === 'Page.screencastFrame') {
      const params = message.params || {};
      if (session.playback) { session.playback.onFrame(params); return; }
      emitFrame(session, session.appliedGeneration, params.data);
      session.page?.send('Page.screencastFrameAck', { sessionId: params.sessionId }).catch(() => {});
      return;
    }
    if (message.method === 'Portos.preview') {
      const params = message.params || {};
      session.playback?.onEvent(params);
      session.socket.emit('generated-preview:event', {
        requestId: session.requestId, sessionId: session.id, ...params,
      });
      if (params.hasBlob) saveRecording(session).catch(() => {});
      return;
    }
    if (message.method === 'Portos.pageError') {
      session.socket.emit('generated-preview:event', {
        requestId: session.requestId, sessionId: session.id, type: 'error', message: message.params?.message || '',
      });
    }
  };
}

const UPLOAD_AUDIO_URL = /^\/api\/uploads\/([^/]+)$/;

async function inlineLibraryAudio(url) {
  const musicName = MUSIC_URL.exec(String(url || ''))?.[1];
  const uploadName = !musicName ? UPLOAD_AUDIO_URL.exec(String(url || ''))?.[1] : null;
  let path = null;
  let name = '';
  if (musicName) {
    name = musicName;
    const { resolveMusicTrackPath } = await import('../pipeline/audioMux.js');
    path = await resolveMusicTrackPath(name);
  } else if (uploadName) {
    name = decodeURIComponent(uploadName);
    const { makePathResolver } = await import('../../lib/pathSafety.js');
    const { UPLOAD_AUDIO_EXTENSIONS } = await import('../../lib/mimeTypes.js');
    const resolveUpload = makePathResolver(() => PATHS.uploads, { extensions: UPLOAD_AUDIO_EXTENSIONS });
    path = resolveUpload(name);
  } else {
    return null;
  }
  if (!path) return null;
  const { stat, readFile } = await import('node:fs/promises');
  const info = await stat(path).catch(() => null);
  if (!info || !info.isFile() || info.size <= 0 || info.size > AUDIO_CAP) return null;
  const lower = name.toLowerCase();
  const mime = lower.endsWith('.wav')
    ? 'audio/wav'
    : lower.endsWith('.ogg')
      ? 'audio/ogg'
      : lower.endsWith('.m4a')
        ? 'audio/mp4'
        : 'audio/mpeg';
  return `data:${mime};base64,${(await readFile(path)).toString('base64')}`;
}

const writeComposition = (sessionId, html) => writeNamedComposition(`preview-${sessionId}`, html);

async function openDirectory(session, directory, { width, height, csp, screencast }) {
  const { openComposition } = await import('../htmlComposition/browser.js');
  const page = await openComposition(directory, {
    signal: session.controller.signal,
    ownedBrowser: true,
    isolation: 'required',
    streamMedia: true,
    contentSecurityPolicy: csp,
    previewBridge: true,
    refuseUnknown: 'empty',
    lockLoopback: true,
    onEvent: (message) => session.onEvent?.(message),
  });
  session.page = page;
  if (width && height) {
    await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  }
  if (screencast) {
    await page.send('Page.startScreencast', {
      format: 'jpeg', quality: 45, everyNthFrame: 2, maxWidth: width || 1280, maxHeight: height || 720,
    });
  }
  return page;
}

async function startMusicVideo(session, input) {
  const { getProject } = await import('../musicVideo/projects.js');
  const project = await getProject(input.projectId);
  if (input.draft && !project?.composition?.documentDraft) {
    const error = new Error('No composition candidate to preview');
    error.code = 'NOT_FOUND';
    throw error;
  }
  const source = input.draft
    ? { ...project, composition: { ...project.composition, document: project.composition.documentDraft } }
    : project;
  if (input.lyrics) {
    const { buildLyricPlaythroughPreview } = await import('../musicVideo/lyricPlaythrough.js');
    const { PREVIEW_CSP } = await import('../musicVideo/documentPreview.js');
    const preview = await buildLyricPlaythroughPreview(source);
    const written = await writeComposition(session.id, preview.html);
    session.scratchRoot = written.scratchRoot;
    session.lyrics = true;
    const page = await openDirectory(session, written.directory, {
      width: preview.width, height: preview.height, csp: `sandbox allow-scripts; ${PREVIEW_CSP}`, screencast: false,
    });
    await page.evaluate(`window.postMessage({ type: 'portos-mv:manifest', keys: [] }, '*')`);
    await page.evaluate(`window.postMessage({ type: 'portos-mv:title-card', card: ${JSON.stringify(input.card ?? null)} }, '*')`);
    await seekPage(session, 0);
    return {
      width: preview.width, height: preview.height, fps: preview.fps, durationSec: preview.durationSec,
      revision: input.revision || '', frame: await capture(page),
    };
  }
  const { openIsolatedDocumentPreview } = await import('../musicVideo/documentRender.js');
  const opened = await openIsolatedDocumentPreview({
    project: source, jobId: `preview-${session.id}`, signal: session.controller.signal,
    onEvent: (message) => session.onEvent?.(message),
  });
  session.page = opened.page;
  session.scratchRoot = opened.scratchRoot;
  if (opened.playback?.version === 1) {
    session.playback = createCooperativePlayback(session, { seekPage, capture, emitFrame, fail, closeSession,
      authored: opened.playback.producer === 'authored-v1' });
  }
  // The first frame is captured after this seek. Apply the live controls first
  // so that frame is already graded and titled.
  await applyJson(opened.page, '__portosFilmLook', input.look ?? null);
  await applyJson(opened.page, '__portosTitleCard', input.card ?? null);
  await seekPage(session, 0);
  const pointer = source.composition?.document;
  return {
    width: opened.width, height: opened.height, fps: opened.fps, durationSec: opened.durationSec,
    revision: `${pointer?.directory || ''}|${pointer?.updatedAt || ''}`,
    frame: await capture(opened.page),
    ...(opened.playback ? { playback: opened.playback } : {}),
  };
}

async function startCodeVideo(session, input) {
  const { getProject } = await import('../musicVideo/projects.js');
  const { prepareCodeRender } = await import('../musicVideo/codeRender.js');
  const project = await getProject(input.projectId);
  const doc = prepareCodeRender(project);
  const written = await writeComposition(session.id, doc.html);
  session.scratchRoot = written.scratchRoot;
  await writeFile(join(written.composition, 'song.json'), JSON.stringify(doc.song || {}));
  const page = await openDirectory(session, written.directory, {
    width: doc.width, height: doc.height, csp: PREVIEW_PAGE_CSP, screencast: false,
  });
  await seekPage(session, 0);
  return {
    width: doc.width, height: doc.height, fps: doc.fps, durationSec: doc.durationSec,
    revision: input.revision || String(project.composition?.codeVideo?.generatedAt || ''),
    frame: await capture(page),
  };
}

async function startCodeAnimation(session, input) {
  let html = input.html || '';
  let audioUrl = input.audioUrl || '';
  if (input.jobId) {
    const { getCodeAnimationJob } = await import('../codeAnimation/index.js');
    const job = await getCodeAnimationJob(input.jobId);
    if (!job?.html) {
      const error = new Error('Generated animation is not available');
      error.code = 'NOT_FOUND';
      throw error;
    }
    html = job.html;
    audioUrl = job.audioUrl || audioUrl;
  }
  if (!html) {
    const error = new Error('Generated animation is not available');
    error.code = 'NOT_FOUND';
    throw error;
  }
  let audio = 'none';
  let audioDataUrl = null;
  if (input.withAudio) {
    audioDataUrl = await inlineLibraryAudio(audioUrl);
    audio = audioDataUrl ? 'ready' : 'unavailable';
  }
  const written = await stageCodeAnimationPage(`preview-${session.id}`, html, { audioGlobal: input.audioGlobal, audioDataUrl });
  session.scratchRoot = written.scratchRoot;
  const width = input.width || 1280;
  const height = input.height || 720;
  const page = await openDirectory(session, written.directory, { width, height, csp: PREVIEW_PAGE_CSP, screencast: true });
  return {
    width, height, fps: 30, durationSec: 0, revision: input.revision || input.jobId || 'pasted',
    audio, frame: await capture(page),
  };
}

async function openGeneratedPreview(socket, data) {
  const parsed = openSchema.safeParse(data);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    console.log(`🚫 Generated preview open refused: ${issue?.path.join('.') || 'request'} ${issue?.message || 'invalid'}`);
    fail(socket, { requestId: data?.requestId, message: 'The preview request was not valid.' });
    return;
  }
  const input = parsed.data;
  if ((input.kind === 'music-video' || input.kind === 'music-video-code') && !input.projectId) {
    fail(socket, { requestId: input.requestId, message: 'The preview request was not valid.' });
    return;
  }
  if (input.kind === 'code-animation' && !input.jobId && !input.html) {
    fail(socket, { requestId: input.requestId, message: 'The preview request was not valid.' });
    return;
  }
  reserveSlot(socket);
  const controller = new AbortController();
  opening.set(input.requestId, { abort: controller, socketId: socket.id });
  const session = {
    id: randomUUID(),
    requestId: input.requestId,
    kind: input.kind,
    socket,
    controller,
    closed: false,
    page: null,
    scratchRoot: null,
    lyrics: false,
    appliedGeneration: 0,
    pendingSeek: null,
    seekTail: null,
    pulling: false,
    onEvent: () => {},
  };
  attachEvents(session);
  try {
    const started = input.kind === 'music-video'
      ? await startMusicVideo(session, input)
      : input.kind === 'music-video-code'
        ? await startCodeVideo(session, input)
        : await startCodeAnimation(session, input);
    if (controller.signal.aborted || session.closed) {
      session.page = session.page || null;
      await closeSession(session.id, 'canceled').catch(() => {});
      if (session.page) await session.page.close().catch(() => {});
      if (session.scratchRoot) await rm(session.scratchRoot, { recursive: true, force: true }).catch(() => {});
      return;
    }
    sessions.set(session.id, session);
    remember(socket, session);
    armIdle(session);
    socket.emit('generated-preview:opened', {
      requestId: input.requestId,
      sessionId: session.id,
      kind: input.kind,
      width: started.width,
      height: started.height,
      fps: started.fps,
      durationSec: started.durationSec,
      revision: started.revision,
      audio: started.audio || 'none',
      ...(started.playback ? { playback: started.playback } : {}),
    });
    emitFrame(session, 0, started.frame);
  } catch (error) {
    if (session.page) await session.page.close().catch(() => {});
    if (session.scratchRoot) await rm(session.scratchRoot, { recursive: true, force: true }).catch(() => {});
    if (controller.signal.aborted) return;
    const published = publicFailure(error);
    if (published.code === 'PREVIEW_ISOLATION_UNAVAILABLE') {
      socket.emit('generated-preview:unavailable', { requestId: input.requestId, ...published });
    } else {
      fail(socket, { requestId: input.requestId, ...published });
    }
  } finally {
    opening.delete(input.requestId);
  }
}

async function seekGeneratedPreview(socket, data) {
  const parsed = seekSchema.safeParse(data);
  if (!parsed.success) return;
  const session = sessions.get(parsed.data.sessionId);
  if (!session || session.socket.id !== socket.id || session.closed) return;
  await runSeek(session, parsed.data.generation, parsed.data.t, parsed.data.playing);
}

async function commandGeneratedPreview(socket, data) {
  const parsed = commandSchema.safeParse(data);
  if (!parsed.success) return;
  const session = sessions.get(parsed.data.sessionId);
  if (!session || session.socket.id !== socket.id || session.closed) return;
  armIdle(session);
  try {
    const apply = async () => {
      if (parsed.data.action === 'film-look') await applyJson(session.page, '__portosFilmLook', parsed.data.look ?? null);
      else if (parsed.data.action === 'title-card') await applyJson(session.page, '__portosTitleCard', parsed.data.card ?? null);
      else if (parsed.data.action === 'record' && parsed.data.message) {
        // A real-time recording runs on the page's own clock.
        if (session.kind === 'code-animation') await session.page.evaluate(RELEASE_CODE_ANIMATION_CLOCK);
        session.recordPending = { title: parsed.data.title || '' };
        await session.page.evaluate(`window.postMessage({ type: ${JSON.stringify(parsed.data.message.type)} }, '*')`);
      }
    };
    if (session.playback) {
      await session.playback.control(apply).catch(session.playback.terminate);
      return;
    }
    await apply();
    if (session.kind !== 'code-animation') emitFrame(session, session.appliedGeneration, await capture(session.page));
  } catch (error) {
    console.error(`❌ Generated preview command failed: ${error.message}`);
    fail(socket, { requestId: session.requestId, sessionId: session.id, message: 'The preview could not apply that change.' });
  }
}

async function playbackGeneratedPreview(socket, data) {
  const parsed = playbackSchema.safeParse(data);
  if (!parsed.success) return;
  const session = sessions.get(parsed.data.sessionId);
  if (!session || session.socket.id !== socket.id || session.closed || !session.playback) return;
  armIdle(session);
  await session.playback.handle(parsed.data).catch(session.playback.terminate);
}

function guard(socket, event, fn) {
  socket.on(event, (data) => {
    const rejected = (error) => {
      console.error(`❌ Generated preview ${event} failed: ${error.message}`);
      fail(socket, { requestId: data?.requestId, sessionId: data?.sessionId, message: 'The isolated preview could not continue.' });
    };
    // Intent gates run in the receiving event turn, before another native
    // frame can be forwarded. The async operation still reports rejections.
    try { Promise.resolve(fn(socket, data)).catch(rejected); }
    catch (error) { rejected(error); }
  });
}

export function registerGeneratedPreviewHandlers(socket) {
  guard(socket, 'generated-preview:open', openGeneratedPreview);
  guard(socket, 'generated-preview:seek', seekGeneratedPreview);
  guard(socket, 'generated-preview:playback', playbackGeneratedPreview);
  guard(socket, 'generated-preview:command', commandGeneratedPreview);
  guard(socket, 'generated-preview:close', async (current, data) => {
    const parsed = closeSchema.safeParse(data || {});
    if (!parsed.success) return;
    const pending = parsed.data.requestId && opening.get(parsed.data.requestId);
    if (pending?.socketId === current.id) pending.abort.abort();
    if (parsed.data.sessionId) {
      const session = sessions.get(parsed.data.sessionId);
      if (session?.socket.id === current.id) await closeSession(session.id, 'closed');
    }
  });
  socket.on('disconnect', () => {
    closeGeneratedPreviewsForSocket(socket.id).catch((error) => {
      console.error(`❌ Generated preview disconnect close failed: ${error.message}`);
    });
  });
}
