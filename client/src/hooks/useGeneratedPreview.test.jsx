import { act, cleanup, fireEvent, render, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import socket from '../services/socket';
import useGeneratedPreview from './useGeneratedPreview';

vi.mock('../services/socket', async () => {
  const { EventEmitter } = await import('node:events');
  return { default: new EventEmitter() };
});

const props = { active: true, request: { kind: 'music-video', revision: 'first' } };
const receive = (event, payload) => act(() => { socket.emit(`generated-preview:${event}`, payload); });
const sent = (event) => socket.emit.mock.calls
  .filter(([name]) => name === `generated-preview:${event}`).map(([, payload]) => payload);
const opened = (sessionId, extra = {}) => {
  const session = { requestId: sent('open').at(-1).requestId, sessionId };
  receive('opened', { ...session, ...extra });
  return session;
};
function connection(connected) {
  socket.connected = connected;
  act(() => { socket.emit(connected ? 'connect' : 'disconnect'); });
}

beforeEach(() => {
  socket.connected = true;
  vi.spyOn(socket, 'emit');
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('opens only on an active request, reconciles controls after handshake, and closes the owning session', () => {
  const { result, rerender, unmount } = renderHook(useGeneratedPreview, { initialProps: { ...props, active: false } });
  rerender({ ...props, request: null });
  expect(sent('open')).toEqual([]);
  rerender(props);
  expect(result.current.status).toBe('opening');
  const controls = { look: { grain: 0.4 }, card: { title: 'Example' } };
  rerender({ ...props, controls });
  expect(sent('command')).toEqual([]);
  const first = opened('first-session');
  expect(sent('command')).toEqual([
    expect.objectContaining({ ...first, action: 'film-look', look: controls.look }),
    expect.objectContaining({ ...first, action: 'title-card', card: controls.card }),
  ]);
  expect(sent('open')).toHaveLength(1);
  const next = { controls, active: true, request: { ...props.request, revision: 'second' } };
  rerender(next);
  expect(sent('close')).toEqual([first]);
  expect(sent('open')[1]).toMatchObject({ ...next.request, ...controls });
  const second = opened('second-session');
  expect(second.requestId).not.toBe(first.requestId);
  rerender({ ...next, active: false });
  expect(result.current).toMatchObject({ status: 'idle', ready: false, frameUrl: '' });
  expect(sent('close')).toEqual([first, second]);
  rerender(next);
  const third = opened('third-session');
  unmount();
  expect(sent('close')).toEqual([first, second, third]);
  expect(socket.eventNames()).toEqual([]);
});

it('keeps an unavailable host stopped across reconnects', () => {
  const { result } = renderHook(useGeneratedPreview, { initialProps: props });
  receive('unavailable', { requestId: sent('open')[0].requestId, message: 'Renderer unavailable' });
  connection(false);
  connection(true);
  expect(result.current).toMatchObject({ status: 'unavailable', reason: 'Renderer unavailable', ready: false, frameUrl: '' });
  expect(sent('open')).toHaveLength(1);
});

it('resumes idle sessions explicitly and reconnects with the latest controls and offline playhead', () => {
  const { result, rerender } = renderHook(useGeneratedPreview, { initialProps: props });
  const first = opened('first-session');
  act(() => result.current.seek(3));
  receive('closed', first);
  connection(false);
  connection(true);
  const controls = { look: { grain: 0.5 } };
  rerender({ ...props, controls });
  expect(result.current.status).toBe('idle');
  expect(sent('open')).toHaveLength(1);
  act(() => result.current.resume());
  expect(sent('open')[1]).toMatchObject(controls);
  const second = opened('second-session');
  expect(sent('seek').at(-1)).toMatchObject({ ...second, t: 3 });
  connection(false);
  act(() => result.current.seek(7));
  expect(sent('seek')).toHaveLength(2);
  connection(true);
  const third = opened('third-session');
  expect(sent('open')).toHaveLength(3);
  expect(sent('open')[2]).toMatchObject(controls);
  expect(sent('seek').at(-1)).toMatchObject({ ...third, t: 7 });
  receive('closed', second);
  expect(result.current).toMatchObject({ status: 'ready', sessionId: third.sessionId });
});

it('accepts cooperative resync once per epoch and reports fallback and recording results for the current request', () => {
  const { result } = renderHook(useGeneratedPreview, { initialProps: props });
  const first = opened('first-session', { playback: { version: 1 } });
  expect(result.current.playback).toBe(true);
  const drift = { ...first, status: 'resync-required', epoch: 0, reason: 'clock' };
  receive('playback-state', drift);
  receive('playback-state', drift);
  expect(result.current).toMatchObject({ playbackResync: 1, playbackResyncReason: 'clock' });
  connection(false);
  connection(true);
  const playbackFallback = { upgradable: true, reason: 'unsupported effect' };
  const second = opened('second-session', { playbackFallback });
  expect(result.current).toMatchObject({ playback: false, playbackFallback });
  receive('recording', { ...second, status: 'saving' });
  receive('recording', { ...first, status: 'failed', message: 'stale' });
  expect(result.current.recording).toEqual({ status: 'saving' });
  const video = { url: '/data/videos/example.mp4' };
  receive('recording', { ...second, status: 'saved', video });
  expect(result.current.recording).toEqual({ status: 'saved', video });
});

function FrameView({ revision }) {
  const preview = useGeneratedPreview({ active: true, request: { ...props.request, revision } });
  return <img ref={preview.imageRef} alt="Preview" src={preview.frameUrl || undefined} onLoad={preview.onFrameLoad} />;
}

it('retires superseded JPEGs and prevents old revision decodes from replacing the displayed image', async () => {
  const frames = [];
  vi.stubGlobal('Image', function DeferredImage() {
    const pending = Promise.withResolvers();
    frames.push(pending);
    return { decode: () => pending.promise };
  });
  const create = vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:frame-${frames.length}`);
  const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  const view = render(<FrameView revision="one" />);
  const image = view.getByRole('img', { name: 'Preview' });
  Object.defineProperty(image, 'naturalWidth', { value: 1 });
  image.decode = () => Promise.resolve();
  const first = opened('first-session');
  const frame = (session) => receive('frame', { ...session, data: '/9j/' });
  frame(first);
  frame(first);
  await act(async () => frames[1].resolve());
  await act(async () => fireEvent.load(image));
  await act(async () => frames[0].resolve());
  expect(image.src).toBe('blob:frame-1');
  const [jpeg] = create.mock.calls[1];
  expect(jpeg.type).toBe('image/jpeg');
  expect(new Uint8Array(await jpeg.arrayBuffer())).toEqual(new Uint8Array([255, 216, 255]));
  frame(first);
  view.rerender(<FrameView revision="two" />);
  const second = opened('second-session');
  await act(async () => frames[2].resolve());
  expect(image.src).toBe('blob:frame-1');
  expect(revoke).toHaveBeenCalledWith('blob:frame-2');
  expect(revoke).not.toHaveBeenCalledWith(image.src);
  frame(second);
  await act(async () => frames[3].resolve());
  expect(image.src).toBe('blob:frame-3');
  expect(revoke).not.toHaveBeenCalledWith('blob:frame-1');
  await act(async () => fireEvent.load(image));
  expect(revoke).toHaveBeenCalledWith('blob:frame-1');
  expect(revoke).not.toHaveBeenCalledWith(image.src);
  view.unmount();
  expect(revoke.mock.calls.flat().sort()).toEqual(create.mock.results.map(({ value }) => value).sort());
});
