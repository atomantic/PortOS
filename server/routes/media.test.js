import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getVideoStream: vi.fn(),
  getAudioStream: vi.fn(),
}));

vi.mock('../services/mediaService.js', () => ({
  default: {
    listDevices: vi.fn(),
    isVideoStreaming: vi.fn(),
    isAudioStreaming: vi.fn(),
    startVideoStream: vi.fn(),
    startAudioStream: vi.fn(),
    stopAll: vi.fn(),
    getVideoStream: (...args) => mocks.getVideoStream(...args),
    getAudioStream: (...args) => mocks.getAudioStream(...args),
  },
}));

const { default: router } = await import('./media.js');

function routeHandler(path) {
  return router.stack.find((layer) => layer.route?.path === path).route.stack[0].handle;
}

function responseStream() {
  const res = new PassThrough();
  res.setHeader = vi.fn();
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('media stream client cleanup', () => {
  it('detaches video data and end listeners when the client disconnects', () => {
    const source = new PassThrough();
    const req = new EventEmitter();
    const res = responseStream();
    mocks.getVideoStream.mockReturnValue(source);

    routeHandler('/video')(req, res);
    expect(source.listenerCount('data')).toBe(1);
    expect(source.listenerCount('end')).toBe(1);

    res.emit('close');

    expect(source.listenerCount('data')).toBe(0);
    expect(source.listenerCount('end')).toBe(0);
    expect(res.listenerCount('close')).toBe(0);
  });

  it('unpipes the audio source when the client disconnects', () => {
    const source = new PassThrough();
    const req = new EventEmitter();
    const res = responseStream();
    mocks.getAudioStream.mockReturnValue(source);

    routeHandler('/audio')(req, res);
    expect(source.listenerCount('data')).toBeGreaterThan(0);

    res.emit('close');

    expect(source.listenerCount('data')).toBe(0);
  });
});
