import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';

const socket = vi.hoisted(() => {
  const handlers = new Map();
  const sessions = new Map();
  const reply = (event, payload) => {
    if (event !== 'generated-preview:open') return;
    const sessionId = `11111111-1111-4111-8111-${String(sessions.size + 1).padStart(12, '0')}`;
    sessions.set(payload.requestId, sessionId);
    const opened = {
      requestId: payload.requestId,
      sessionId,
      durationSec: 5, fps: 30, width: 1920, height: 1080,
      audio: payload.withAudio ? 'ready' : 'none',
      revision: payload.revision,
    };
    for (const fn of handlers.get('generated-preview:opened') || []) fn(opened);
    for (const fn of handlers.get('generated-preview:frame') || []) fn({ ...opened, generation: 0, mime: 'image/jpeg', data: btoa('frame') });
  };
  return {
    emit: vi.fn(reply),
    reply,
    on: vi.fn((event, cb) => {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event).add(cb);
    }),
    off: vi.fn((event, cb) => { handlers.get(event)?.delete(cb); }),
    connected: true,
    __handlers: handlers,
    __sessions: sessions,
  };
});
vi.mock('../../services/socket', () => ({ default: socket }));
vi.mock('../../services/api', () => ({ uploadGalleryVideo: vi.fn(), exportCodeAnimation: vi.fn(), cancelCodeAnimationExport: vi.fn(), getCodeAnimationPackage: vi.fn(), getCodeAnimationThreeVendor: vi.fn() }));
vi.mock('../../lib/downloadBlob', () => ({ downloadBlob: vi.fn() }));
vi.mock('../ui/Toast', () => ({ default: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }) }));
vi.mock('../../hooks/useSseProgress', () => ({ useSseProgress: vi.fn(() => ({ latest: null })) }));

import CodeAnimationPreview, { prepareAnimationHtml } from './CodeAnimationPreview';
import { exportCodeAnimation, getCodeAnimationPackage, getCodeAnimationThreeVendor } from '../../services/api';
import { downloadBlob } from '../../lib/downloadBlob';
import { useSseProgress } from '../../hooks/useSseProgress';
import toast from '../ui/Toast';

const MESSAGES = { ready: 'ca:ready', record: 'ca:record', recorded: 'ca:recorded', progress: 'ca:progress', error: 'ca:error' };
const HTML = '<!DOCTYPE html><html><head><title>x</title></head><body><canvas></canvas></body></html>';

const renderPreview = ({ audioUrl = null, jobId, html = HTML, frame = { width: 1920, height: 1080, durationSeconds: 5 } } = {}) => render(
  <MemoryRouter>
    <CodeAnimationPreview html={html} audioUrl={audioUrl} messages={MESSAGES} audioGlobal="ANIMATION_AUDIO_URL" frame={frame} title="Lantern" jobId={jobId} />
  </MemoryRouter>,
);

const previewOpens = () => socket.emit.mock.calls.filter(([event]) => event === 'generated-preview:open');

describe('prepareAnimationHtml', () => {
  it('installs a restrictive policy before page scripts and the audio global', () => {
    const output = prepareAnimationHtml(HTML, 'ANIMATION_AUDIO_URL', 'data:audio/mpeg;base64,AA');
    expect(output).toContain('<head><meta http-equiv="Content-Security-Policy"');
    expect(output).toContain("connect-src 'none'");
    expect(output).toContain("form-action 'none'");
    expect(output).toContain('img-src data: blob:');
    expect(output).toContain('media-src data: blob:');
    expect(output).toContain('<script>window["ANIMATION_AUDIO_URL"] = "data:audio/mpeg;base64,AA";</script><title>');
  });

  it('installs the policy without a <head> and when no audio is supplied', () => {
    expect(prepareAnimationHtml('<canvas></canvas>', 'G', 'data:x'))
      .toContain('<meta http-equiv="Content-Security-Policy"');
    expect(prepareAnimationHtml(HTML, 'G', null)).toContain('<head><meta http-equiv="Content-Security-Policy"');
  });

  it('cannot break out of the script tag through the data URL', () => {
    const out = prepareAnimationHtml(HTML, 'G', 'data:x"</script><script>alert(1)//');
    expect(out).not.toContain('</script><script>alert');
    expect(out).toContain('"data:x\\"\\u003c/script>\\u003cscript>alert(1)//"');
  });
});

describe('CodeAnimationPreview', () => {
  beforeEach(() => {
    globalThis.URL.createObjectURL = vi.fn(() => 'blob:recorded');
    globalThis.URL.revokeObjectURL = vi.fn();
    socket.emit.mockReset();
    socket.emit.mockImplementation(socket.reply);
    socket.__handlers.clear();
    socket.__sessions.clear();
    socket.connected = true;
  });

  afterEach(() => vi.unstubAllGlobals());

  it('displays an early screencast frame without enabling recording before the session opens', async () => {
    const user = userEvent.setup();
    socket.emit.mockImplementation(() => {});
    renderPreview();
    const open = previewOpens()[0][1];
    act(() => {
      for (const fn of socket.__handlers.get('generated-preview:frame') || []) {
        fn({ requestId: open.requestId, sessionId: '11111111-1111-4111-8111-000000000001', generation: 0, mime: 'image/jpeg', data: btoa('early frame') });
      }
    });
    expect(screen.getByTitle('Code animation preview')).toBeInTheDocument();
    const record = screen.getByRole('button', { name: /record \(real-time\)/i });
    expect(record).toBeDisabled();
    await user.click(record);
    expect(socket.emit.mock.calls.filter(([event]) => event === 'generated-preview:command')).toHaveLength(0);
    act(() => socket.reply('generated-preview:open', open));
    expect(record).toBeEnabled();
    await user.click(record);
    expect(socket.emit).toHaveBeenLastCalledWith('generated-preview:command', expect.objectContaining({ requestId: open.requestId, sessionId: socket.__sessions.get(open.requestId), action: 'record' }));
  });

  it('stops an interrupted recording and reconnects without replaying its command', async () => {
    const user = userEvent.setup();
    renderPreview();
    const record = await screen.findByRole('button', { name: /record \(real-time\)/i });
    await waitFor(() => expect(record).toBeEnabled());
    const oldOpen = previewOpens()[0][1];
    await user.click(record);
    expect(screen.getByRole('button', { name: /Recording 0s/ })).toBeDisabled();
    act(() => {
      socket.connected = false;
      for (const fn of socket.__handlers.get('disconnect') || []) fn();
    });
    expect(record).toBeDisabled();
    const sent = socket.emit.mock.calls.length;
    await user.click(record);
    expect(socket.emit.mock.calls).toHaveLength(sent);
    act(() => {
      socket.connected = true;
      for (const fn of socket.__handlers.get('connect') || []) fn();
    });
    await waitFor(() => expect(record).toBeEnabled());
    expect(previewOpens()).toHaveLength(2);
    const nextOpen = previewOpens()[1][1];
    expect(nextOpen.requestId).not.toBe(oldOpen.requestId);
    expect(socket.emit.mock.calls.filter(([event]) => event === 'generated-preview:command')).toHaveLength(1);
    act(() => {
      for (const fn of socket.__handlers.get('generated-preview:recording') || []) {
        fn({ requestId: oldOpen.requestId, sessionId: socket.__sessions.get(oldOpen.requestId), status: 'saved', video: { id: 'upload-1', filename: 'upload-1.mp4', url: '/data/videos/upload-1.mp4' } });
      }
    });
    expect(screen.queryByLabelText('Recorded animation')).not.toBeInTheDocument();
    await user.click(record);
    expect(socket.emit).toHaveBeenLastCalledWith('generated-preview:command', expect.objectContaining({ requestId: nextOpen.requestId, action: 'record' }));
    act(() => {
      socket.connected = false;
      for (const fn of socket.__handlers.get('disconnect') || []) fn();
      socket.connected = true;
      for (const fn of socket.__handlers.get('connect') || []) fn();
    });
    expect(record).toBeEnabled();
    expect(previewOpens()).toHaveLength(3);
    expect(new Set(socket.__sessions.values()).size).toBe(3);
    expect(socket.emit.mock.calls.filter(([event]) => event === 'generated-preview:command')).toHaveLength(2);
  });

  it.each([
    ['portrait', 1080, 1920, 608, 1080],
    ['oversized landscape', 3840, 2160, 1920, 1080],
    ['square', 1440, 1440, 1080, 1080],
    ['below-limit landscape', 1280, 720, 1280, 720],
  ])('preserves the %s canvas aspect when opening the isolated preview', async (_label, width, height, previewWidth, previewHeight) => {
    renderPreview({ frame: { width, height } });
    await screen.findByTitle('Code animation preview');
    expect(previewOpens().at(-1)[1]).toEqual(expect.objectContaining({
      width: previewWidth,
      height: previewHeight,
    }));
  });

  it('downloads a standalone three film with the vendored modules inlined and does not execute it here (#10464)', async () => {
    const user = userEvent.setup();
    getCodeAnimationThreeVendor.mockResolvedValue({ files: [
      { path: 'three.core.js', text: 'export const REVISION = "x";' },
      { path: 'three.module.js', text: "export * from './three.core.js';" },
    ] });
    const three = "<!DOCTYPE html><html><head></head><body><script type=\"module\">import * as THREE from 'three';</script></body></html>";
    renderPreview({ html: three });
    const frame = await screen.findByTitle('Code animation preview');
    expect(frame.tagName).toBe('IMG');
    expect(document.querySelector('iframe')).toBeNull();
    const download = await screen.findByRole('button', { name: 'Download HTML' });
    await waitFor(() => expect(download).toBeEnabled());
    await user.click(download);
    expect(downloadBlob.mock.calls.at(-1)[0]).toContain('type="importmap"');
    expect(downloadBlob.mock.calls.at(-1)[0]).not.toContain('data:audio/');
    expect(downloadBlob.mock.calls.at(-1)[2]).toBe('text/html');

    getCodeAnimationThreeVendor.mockClear();
    renderPreview();
    expect((await screen.findAllByTitle('Code animation preview')).at(-1).tagName).toBe('IMG');
    expect(getCodeAnimationThreeVendor).not.toHaveBeenCalled();
  });

  it('downloads the saved portable package through the public API', async () => {
    const user = userEvent.setup();
    const pkg = { schemaVersion: 1, revisionHash: 'example-digest', files: [] };
    getCodeAnimationPackage.mockResolvedValue(pkg);
    renderPreview({ jobId: 'job-1' });
    await user.click(screen.getByRole('button', { name: 'Download package' }));
    expect(getCodeAnimationPackage).toHaveBeenCalledWith('job-1', { silent: true });
    expect(downloadBlob).toHaveBeenCalledWith(JSON.stringify(pkg, null, 2), 'lantern.code-animation.json', 'application/json');
    expect(screen.getByRole('button', { name: 'Download package' })).toBeEnabled();
  });

  it('records through the isolated preview and ignores an unmatched recording', async () => {
    const user = userEvent.setup();
    renderPreview();
    const frame = await screen.findByTitle('Code animation preview');
    expect(frame.tagName).toBe('IMG');
    expect(document.querySelector('iframe')).toBeNull();
    const open = previewOpens().at(-1)[1];
    await act(async () => {
      for (const fn of socket.__handlers.get('generated-preview:event') || []) {
        fn({ requestId: open.requestId, sessionId: socket.__sessions.get(open.requestId), type: MESSAGES.ready, meta: { duration: 5 } });
      }
    });
    expect(screen.getByText('Animation ready')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /record \(real-time\)/i }));
    expect(socket.emit).toHaveBeenCalledWith('generated-preview:command', expect.objectContaining({
      action: 'record', message: { type: MESSAGES.record }, title: 'Lantern',
    }));

    await act(async () => {
      for (const fn of socket.__handlers.get('generated-preview:recording') || []) {
        fn({ requestId: 'other', sessionId: 'other', status: 'saved', video: { id: 'x', filename: 'x.mp4', url: '/data/videos/x.mp4' } });
      }
    });
    expect(screen.queryByLabelText('Recorded animation')).not.toBeInTheDocument();

    await act(async () => {
      for (const fn of socket.__handlers.get('generated-preview:recording') || []) {
        fn({ requestId: open.requestId, sessionId: socket.__sessions.get(open.requestId), status: 'saving' });
      }
    });
    expect(screen.getByRole('button', { name: /saving mp4/i })).toBeDisabled();

    await act(async () => {
      for (const fn of socket.__handlers.get('generated-preview:recording') || []) {
        fn({ requestId: open.requestId, sessionId: socket.__sessions.get(open.requestId), status: 'saved', video: { id: 'upload-1', filename: 'upload-1.mp4', url: '/data/videos/upload-1.mp4' } });
      }
    });
    expect(screen.getByLabelText('Recorded animation')).toHaveAttribute('src', '/data/videos/upload-1.mp4');
    const download = screen.getByRole('link', { name: /download mp4/i });
    expect(download).toHaveAttribute('href', '/data/videos/upload-1.mp4');
    expect(download).toHaveAttribute('download', 'lantern.mp4');
    expect(screen.getByRole('link', { name: /saved to media history/i })).toHaveAttribute('href', '/media/history');
    expect(screen.getByRole('button', { name: /record \(real-time\)/i })).toBeEnabled();
  });

  it('reports a recording that could not be saved and lets the user record again', async () => {
    const user = userEvent.setup();
    renderPreview();
    await screen.findByTitle('Code animation preview');
    const open = previewOpens().at(-1)[1];
    await user.click(screen.getByRole('button', { name: /record \(real-time\)/i }));
    await act(async () => {
      for (const fn of socket.__handlers.get('generated-preview:recording') || []) {
        fn({ requestId: open.requestId, sessionId: socket.__sessions.get(open.requestId), status: 'failed', message: 'The recording is too large to save.' });
      }
    });
    expect(toast.error).toHaveBeenCalledWith('The recording is too large to save.');
    expect(screen.queryByLabelText('Recorded animation')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /record \(real-time\)/i })).toBeEnabled();
  });

  it('does not read the selected audio until the user allows the isolated preview to use it', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    renderPreview({ audioUrl: '/api/uploads/audio/example.wav' });

    expect(screen.getByRole('heading', { name: 'Preview paused' })).toBeInTheDocument();
    expect(screen.getByText(/preview is paused until you choose/i)).toBeInTheDocument();
    expect(screen.queryByText(/could send that track outside PortOS/i)).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByTitle('Code animation preview')).not.toBeInTheDocument();
    expect(previewOpens()).toHaveLength(0);

    await user.click(screen.getByRole('button', { name: 'Run with audio' }));
    await screen.findByTitle('Code animation preview');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(previewOpens().at(-1)[1]).toEqual(expect.objectContaining({
      withAudio: true, audioUrl: '/api/uploads/audio/example.wav',
    }));
    expect(document.querySelector('iframe')).toBeNull();
  });

  it('lets the user preview without audio and never fetches the selected track', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    renderPreview({ audioUrl: '/api/uploads/audio/example.wav' });

    await user.click(screen.getByRole('button', { name: 'Preview without audio' }));
    await screen.findByTitle('Code animation preview');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(previewOpens().at(-1)[1].withAudio).toBe(false);
    expect(previewOpens().at(-1)[1].audioUrl).toBeUndefined();
  });
});

describe('CodeAnimationPreview playhead', () => {
  beforeEach(() => {
    globalThis.URL.createObjectURL = vi.fn(() => 'blob:frame');
    globalThis.URL.revokeObjectURL = vi.fn();
    socket.emit.mockReset();
    socket.emit.mockImplementation(socket.reply);
    socket.__handlers.clear();
    socket.__sessions.clear();
    socket.connected = true;
    localStorage.clear();
  });
  afterEach(() => vi.restoreAllMocks());

  const seeks = () => socket.emit.mock.calls.filter(([event]) => event === 'generated-preview:seek').map(([, payload]) => payload);

  it('holds the film at the playhead, scrubs it, and plays the soundtrack here in sync', async () => {
    const user = userEvent.setup();
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
    renderPreview({ audioUrl: '/data/music/take.wav', jobId: '00000000-0000-4000-8000-000000000009' });
    await user.click(screen.getByRole('button', { name: 'Preview without audio' }));
    // The session opens on the film's own loop; the player takes it over at 0.
    await waitFor(() => expect(seeks().at(-1)).toMatchObject({ t: 0, playing: false }));
    expect(screen.getByText(/0\.00s \/ 5\.00s · f0/)).toBeTruthy();

    const scrub = screen.getByLabelText('Playhead');
    fireEvent.change(scrub, { target: { value: '2.5' } });
    await waitFor(() => expect(seeks().at(-1)).toMatchObject({ t: 2.5, playing: false }));
    expect(screen.getByText(/2\.50s \/ 5\.00s · f60/)).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Mute' }));
    expect(JSON.parse(localStorage.getItem('portos.codeAnimation.previewAudio'))).toMatchObject({ muted: true });
    await user.click(screen.getByRole('button', { name: 'Play' }));
    expect(play).toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Pause' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Pause' }));
    expect(screen.getByRole('button', { name: 'Play' })).toBeTruthy();
  });

  it('leaves the film its own clock while recording, then holds it at the playhead again', async () => {
    const user = userEvent.setup();
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
    renderPreview({ audioUrl: '/data/music/take.wav' });
    await user.click(screen.getByRole('button', { name: 'Preview without audio' }));
    await waitFor(() => expect(seeks().at(-1)).toMatchObject({ t: 0, playing: false }));
    const open = previewOpens().at(-1)[1];
    const sessionId = socket.__sessions.get(open.requestId);
    fireEvent.change(screen.getByLabelText('Playhead'), { target: { value: '2.5' } });
    await user.click(screen.getByRole('button', { name: 'Play' }));

    await user.click(screen.getByRole('button', { name: /record \(real-time\)/i }));
    const recordAt = socket.emit.mock.calls.findIndex(([event, payload]) => event === 'generated-preview:command' && payload.action === 'record');
    expect(recordAt).toBeGreaterThan(-1);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Play' })).toBeDisabled());
    expect(socket.emit.mock.calls.slice(recordAt).some(([event]) => event === 'generated-preview:seek')).toBe(false);

    await act(async () => {
      for (const fn of socket.__handlers.get('generated-preview:recording') || []) {
        fn({ requestId: open.requestId, sessionId, status: 'saved', video: { id: 'upload-1', filename: 'upload-1.mp4', url: '/data/videos/upload-1.mp4' } });
      }
    });
    await waitFor(() => expect(socket.emit.mock.calls.slice(recordAt).some(([event, payload]) => event === 'generated-preview:seek' && payload.playing === false)).toBe(true));
    expect(screen.getByRole('button', { name: 'Play' })).toBeEnabled();
  });
});

describe('CodeAnimationPreview frame-exact export', () => {
  it('retains sound limitations beside the completed export and clears them when switching animations', async () => {
    const user = userEvent.setup();
    const note = 'Procedural Web Audio is not rendered offline; the frame-exact export is silent.';
    exportCodeAnimation.mockResolvedValue({ jobId: 'media-1', notes: [note] });
    const { rerender } = renderPreview({ jobId: 'job-1' });
    await user.click(screen.getByRole('button', { name: /export mp4/i }));
    expect(screen.getByRole('status', { name: 'Export notes' })).toHaveTextContent(note);
    useSseProgress.mockReturnValue({ latest: { type: 'complete', result: { path: '/data/videos/example.mp4' } } });
    const preview = (jobId) => <MemoryRouter><CodeAnimationPreview html={HTML} jobId={jobId} /></MemoryRouter>;
    rerender(preview('job-1'));
    expect(screen.getByLabelText('Exported animation')).toBeInTheDocument();
    expect(screen.getByRole('status', { name: 'Export notes' })).toHaveTextContent(note);
    useSseProgress.mockReturnValue({ latest: null });
    rerender(preview('job-2'));
    expect(screen.queryByRole('status', { name: 'Export notes' })).toBeNull();
  });

  it('drops a queued export response after switching to a different animation', async () => {
    const user = userEvent.setup();
    let finish;
    exportCodeAnimation.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const { rerender } = renderPreview({ jobId: 'job-1' });
    await user.click(screen.getByRole('button', { name: /export mp4/i }));
    rerender(<MemoryRouter><CodeAnimationPreview html={HTML} jobId="job-2" /></MemoryRouter>);
    await act(async () => finish({ jobId: 'old-export', notes: ['Old soundtrack limitation'] }));
    expect(screen.queryByRole('status', { name: 'Export notes' })).toBeNull();
    expect(useSseProgress).toHaveBeenLastCalledWith(null, { enabled: false });
    expect(screen.getByRole('button', { name: /export mp4/i })).toBeEnabled();
  });

  it('offers export only for a saved job, queues it, and follows the composition job stream', async () => {
    const user = userEvent.setup();
    exportCodeAnimation.mockResolvedValue({ jobId: 'media-1', notes: [] });
    const { unmount } = renderPreview();
    expect(screen.queryByRole('button', { name: /export mp4/i })).toBeNull();
    unmount();
    renderPreview({ jobId: 'job-1' });
    await user.click(screen.getByRole('button', { name: /export mp4/i }));
    expect(exportCodeAnimation).toHaveBeenCalledWith('job-1', { silent: true });
    expect(useSseProgress).toHaveBeenLastCalledWith('/api/html-composition/media-1/events', { enabled: true });
  });
});
