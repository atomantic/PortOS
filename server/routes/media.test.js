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

describe('MJPEG framing recovery', () => {
  it('preserves split markers and recovers after garbage and an oversized incomplete frame', () => {
    const source = new PassThrough();
    const res = responseStream();
    const output = [];
    res.on('data', chunk => output.push(chunk));
    mocks.getVideoStream.mockReturnValue(source);
    routeHandler('/video')(new EventEmitter(), res);

    source.write(Buffer.alloc(9 * 1024 * 1024, 0x61));
    source.write(Buffer.from([0xFF]));
    source.write(Buffer.from([0xD8, 1, 0xFF]));
    source.write(Buffer.from([0xD9]));
    source.write(Buffer.from([0xFF, 0xD8]));
    source.write(Buffer.alloc(9 * 1024 * 1024, 0x62));
    // A new start marker supersedes a malformed incomplete frame.
    source.write(Buffer.from([0xFF, 0xD8, 2, 0xFF, 0xD8, 3, 0xFF]));
    source.write(Buffer.from([0xD9]));
    source.end();

    const payload = Buffer.concat(output);
    expect(payload.toString('latin1').match(/Content-Length: 5/g)).toHaveLength(2);
    expect(payload.includes(Buffer.from([0xFF, 0xD8, 1, 0xFF, 0xD9]))).toBe(true);
    expect(payload.includes(Buffer.from([0xFF, 0xD8, 3, 0xFF, 0xD9]))).toBe(true);
    expect(payload.length).toBeLessThan(200);
  });
});
