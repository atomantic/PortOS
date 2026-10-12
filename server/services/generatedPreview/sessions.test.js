import { afterEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ page: null }));
vi.mock('../musicVideo/projects.js', () => ({ getProject: async () => ({ composition: { document: { directory: 'example-document' } } }) }));
vi.mock('../musicVideo/documentRender.js', () => ({ openIsolatedDocumentPreview: async () => ({
  page: fixture.page, scratchRoot: null, width: 390, height: 219, fps: 30, durationSec: 10,
}) }));
import { closeSession, registerGeneratedPreviewHandlers } from './sessions.js';

const socket = { id: 'preview-test-socket', handlers: new Map(), emit: vi.fn(), on(event, fn) { this.handlers.set(event, fn); } };
afterEach(async () => { for (const [event, payload] of socket.emit.mock.calls) if (event === 'generated-preview:opened') await closeSession(payload.sessionId); socket.handlers.clear(); socket.emit.mockClear(); });

// Catches playback state being lost at the queued worker boundary, especially the final pause behind an active seek.
describe('isolated document preview playback', () => {
  it('captures motion during play and the exact frame after a queued pause, while rejecting another socket', async () => {
    const frame = { t: 0, playing: false };
    let hold;
    let entered;
    const started = new Promise((resolve) => { entered = resolve; });
    const globals = {
      __portosFilmLook: { apply() {}, playback(on) { frame.playing = on; } },
      __portosTitleCard: { apply() {} },
      portosComposition: { async seek(t) {
        frame.t = t;
        if (t === 1) { entered(); await new Promise((resolve) => { hold = resolve; }); }
      } },
    };
    fixture.page = {
      evaluate: (source) => new Function('globalThis', 'window', 'return ' + source)(globals, { postMessage() {} }),
      send: async () => ({ data: JSON.stringify(frame) }),
      close: async () => {},
    };
    registerGeneratedPreviewHandlers(socket);
    const requestId = '00000000-0000-4000-8000-000000000001';
    socket.handlers.get('generated-preview:open')({ requestId, kind: 'music-video', projectId: 'example' });
    await vi.waitFor(() => expect(socket.emit).toHaveBeenCalledWith('generated-preview:opened', expect.any(Object)));
    const sessionId = socket.emit.mock.calls.find(([event]) => event === 'generated-preview:opened')[1].sessionId;
    const seek = (generation, t, playing) => socket.handlers.get('generated-preview:seek')({ requestId, sessionId, generation, t, ...(playing === undefined ? {} : { playing }) });
    seek(1, 1, true);
    await started;
    seek(2, 2, true);
    seek(3, 3); // Older clients and explicit seeks default to the exact filter.
    await Promise.resolve();
    hold();
    await vi.waitFor(() => expect(socket.emit.mock.calls.filter(([event]) => event === 'generated-preview:frame').at(-1)[1]).toMatchObject({ generation: 3, data: JSON.stringify({ t: 3, playing: false }) }));
    expect(socket.emit.mock.calls.filter(([event]) => event === 'generated-preview:frame').map(([, payload]) => JSON.parse(payload.data))).toEqual([
      { t: 0, playing: false }, { t: 1, playing: true }, { t: 3, playing: false },
    ]);
    const other = { ...socket, id: 'other-preview-socket', handlers: new Map() };
    registerGeneratedPreviewHandlers(other);
    other.handlers.get('generated-preview:seek')({ requestId, sessionId, generation: 4, t: 4, playing: true });
    await Promise.resolve();
    expect(frame).toEqual({ t: 3, playing: false });
  });
});
