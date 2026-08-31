import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';

const { socket, listeners, audio, FakeAudioContext } = vi.hoisted(() => {
  const listeners = new Map();
  const audio = {
    decodeCalls: 0,
    decodeImpl: () => Promise.resolve({}),
    sources: [],
  };
  const socket = {
    connected: false,
    on: vi.fn((event, handler) => {
      const handlers = listeners.get(event) || [];
      handlers.push(handler);
      listeners.set(event, handlers);
      return socket;
    }),
    off: vi.fn((event, handler) => {
      listeners.set(event, (listeners.get(event) || []).filter((fn) => fn !== handler));
      return socket;
    }),
    emit: vi.fn(),
  };
  class FakeAudioContext {
    constructor() {
      this.destination = {};
      this.state = 'running';
    }

    resume() {
      return Promise.resolve();
    }

    decodeAudioData(bytes) {
      audio.decodeCalls++;
      return audio.decodeImpl(bytes);
    }

    createBufferSource() {
      const source = {
        buffer: null,
        connect: vi.fn(),
        onended: null,
        start: vi.fn(),
        stop: vi.fn(),
      };
      audio.sources.push(source);
      return source;
    }
  }
  return { socket, listeners, audio, FakeAudioContext };
});

vi.mock('./socket', () => ({ default: socket }));

let voiceClient;

const trigger = (event, payload) => {
  for (const handler of listeners.get(event) || []) handler(payload);
};

const emitTtsAudio = (sentence) => trigger('voice:tts:audio', {
  sentence,
  wav: new ArrayBuffer(8),
});

describe('voice playback cancellation', () => {
  beforeAll(async () => {
    vi.stubGlobal('AudioContext', FakeAudioContext);
    voiceClient = await import('./voiceClient.js');
  });

  beforeEach(() => {
    trigger('voice:tts:cancel');
    audio.decodeCalls = 0;
    audio.decodeImpl = () => Promise.resolve({});
    audio.sources.length = 0;
    socket.emit.mockClear();
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it('stops active and queued audio when a provider timeout is signaled', async () => {
    trigger('voice:transcript');
    emitTtsAudio('first sentence');
    emitTtsAudio('second sentence');
    await vi.waitFor(() => expect(audio.sources).toHaveLength(1));

    const activeSource = audio.sources[0];
    trigger('voice:tts:cancel');

    expect(activeSource.stop).toHaveBeenCalledTimes(1);
    await expect(voiceClient.whenPlaybackDrained()).resolves.toBe(true);

    // The old queue can finish after cancellation. It must not decrement the
    // newly reset depth or create the queued stale source.
    activeSource.onended?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(audio.sources).toHaveLength(1);
  });

  it('drops a frame whose decode finishes after cancellation', async () => {
    let resolveDecode;
    audio.decodeImpl = () => new Promise((resolve) => { resolveDecode = resolve; });

    trigger('voice:transcript');
    emitTtsAudio('late sentence');
    await vi.waitFor(() => expect(audio.decodeCalls).toBe(1));

    trigger('voice:tts:cancel');
    resolveDecode({});
    await vi.waitFor(() => expect(voiceClient.whenPlaybackDrained()).resolves.toBe(true));

    expect(audio.sources).toHaveLength(0);
  });

  it('drops canceled-turn frames until the next transcript starts a turn', async () => {
    trigger('voice:tts:cancel');
    emitTtsAudio('stale sentence');
    await Promise.resolve();
    expect(audio.decodeCalls).toBe(0);

    trigger('voice:transcript');
    emitTtsAudio('fresh sentence');
    await vi.waitFor(() => expect(audio.sources).toHaveLength(1));
  });
});
