import { describe, it, expect, vi, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';

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
let recognition;
class FakeSpeechRecognition {
  constructor() { recognition = this; }
  start() {}
  stop() {}
  abort() {}
}

const recognizeFinal = (text) => recognition.onresult({
  resultIndex: 0,
  results: [Object.assign([{ transcript: text }], { isFinal: true })],
});

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
    vi.stubGlobal('SpeechRecognition', FakeSpeechRecognition);
    voiceClient = await import('./voiceClient.js');
  });

  beforeEach(() => {
    trigger('voice:tts:cancel');
    audio.decodeCalls = 0;
    audio.decodeImpl = () => Promise.resolve({});
    audio.sources.length = 0;
    socket.emit.mockClear();
  });

  afterEach(() => {
    voiceClient.stopWebSpeechCapture();
    trigger('voice:output:detached');
    vi.restoreAllMocks();
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

    trigger('voice:idle');
    emitTtsAudio('still stale after server idle');
    expect(audio.decodeCalls).toBe(0);

    trigger('voice:transcript');
    emitTtsAudio('fresh sentence');
    await vi.waitFor(() => expect(audio.sources).toHaveLength(1));
  });

  it('plays proactive speech after cancellation and ownership detach without admitting server chunks', async () => {
    const onSpeech = vi.fn();
    const unsubscribe = voiceClient.onProactiveSpeech(onSpeech);
    trigger('voice:output:primary');
    trigger('voice:speak', { sentence: 'first alert', wav: new ArrayBuffer(8), ts: 123 });
    await vi.waitFor(() => expect(audio.sources).toHaveLength(1));
    expect(onSpeech).toHaveBeenCalledWith({
      sentence: 'first alert', priority: 'normal', source: 'cos', ts: 123,
    });

    trigger('voice:output:detached');
    expect(audio.sources[0].stop).toHaveBeenCalledTimes(1);
    await expect(voiceClient.whenPlaybackDrained()).resolves.toBe(true);
    audio.sources[0].onended();
    trigger('voice:output:primary');
    trigger('voice:speak', { sentence: 'next alert', wav: new ArrayBuffer(8) });
    await vi.waitFor(() => expect(audio.sources).toHaveLength(2));
    emitTtsAudio('canceled server chunk');
    expect(audio.decodeCalls).toBe(2);
    audio.sources[1].onended();
    await expect(voiceClient.whenPlaybackDrained()).resolves.toBe(true);
    unsubscribe();
  });

  it('queues preview audio after cancellation without reopening server admission', async () => {
    await expect(voiceClient.playWav(new ArrayBuffer(8))).resolves.toBeUndefined();
    expect(audio.sources).toHaveLength(1);
    emitTtsAudio('canceled server chunk');
    expect(audio.decodeCalls).toBe(1);
    audio.sources[0].onended();
    await expect(voiceClient.whenPlaybackDrained()).resolves.toBe(true);
  });

  it('reopens server admission for a synthetic reply and drops a superseded fetch', async () => {
    let resolveOldWav;
    const oldWav = new Promise((resolve) => { resolveOldWav = resolve; });
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({ ok: true, arrayBuffer: () => oldWav })
      .mockResolvedValueOnce({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) });
    const oldReply = voiceClient.speakSynthesized('old reply');
    await expect(voiceClient.speakSynthesized('new reply')).resolves.toBe(true);
    expect(audio.sources).toHaveLength(1);
    emitTtsAudio('admitted without transcript');
    await vi.waitFor(() => expect(audio.decodeCalls).toBe(2));
    resolveOldWav(new ArrayBuffer(8));
    await expect(oldReply).resolves.toBe(false);
    expect(audio.decodeCalls).toBe(2);
    audio.sources[0].onended();
    await vi.waitFor(() => expect(audio.sources).toHaveLength(2));
    audio.sources[1].onended();
    await expect(voiceClient.whenPlaybackDrained()).resolves.toBe(true);
  });

  it('cancels a pending synthetic fetch even when a transcript reopens admission', async () => {
    let resolveResponse;
    vi.spyOn(globalThis, 'fetch').mockImplementationOnce(() => new Promise((resolve) => { resolveResponse = resolve; }));
    const reply = voiceClient.speakSynthesized('pending reply');
    voiceClient.interrupt();
    trigger('voice:transcript');
    resolveResponse({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) });
    await expect(reply).resolves.toBe(false);
    expect(audio.decodeCalls).toBe(0);
    emitTtsAudio('fresh server reply');
    await vi.waitFor(() => expect(audio.sources).toHaveLength(1));
  });

  it('keeps already-decoding synthetic audio when only the synthesis generation advances', async () => {
    let resolveDecode;
    audio.decodeImpl = vi.fn()
      .mockImplementationOnce(() => new Promise((resolve) => { resolveDecode = resolve; }))
      .mockResolvedValue({});
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true, arrayBuffer: async () => new ArrayBuffer(8),
    });
    const decodingReply = voiceClient.speakSynthesized('already fetched');
    await vi.waitFor(() => expect(audio.decodeCalls).toBe(1));
    await expect(voiceClient.speakSynthesized('new fetch')).resolves.toBe(true);
    resolveDecode({});
    await expect(decodingReply).resolves.toBe(true);
    // Fetch invalidation leaves decode/queue work intact: the later-decoded
    // audio follows the playing reply even though its fetch began first.
    audio.sources[0].onended();
    await vi.waitFor(() => expect(audio.sources).toHaveLength(2));
    audio.sources[1].onended();
    await expect(voiceClient.whenPlaybackDrained()).resolves.toBe(true);
  });

  it('drains the captured queue after playback ends, independently of server idle and decoding', async () => {
    let resolveDecode;
    audio.decodeImpl = () => new Promise((resolve) => { resolveDecode = resolve; });
    const preview = voiceClient.playWav(new ArrayBuffer(8));
    await expect(voiceClient.whenPlaybackDrained()).resolves.toBe(true);
    resolveDecode({});
    await preview;
    const drained = vi.fn();
    const drain = voiceClient.whenPlaybackDrained().then(drained);
    trigger('voice:idle');
    await Promise.resolve();
    expect(drained).not.toHaveBeenCalled();
    audio.sources[0].onended();
    await drain;
    expect(drained).toHaveBeenCalledWith(true);
  });

  it('suppresses Web Speech during playback and the 700ms tail, and clears the tail on cancellation', async () => {
    let now = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const routeFinal = vi.fn();
    voiceClient.startWebSpeechCapture({ routeFinal });
    trigger('voice:transcript');
    emitTtsAudio('spoken response');
    await vi.waitFor(() => expect(audio.sources).toHaveLength(1));
    recognizeFinal('wait');
    expect(routeFinal).not.toHaveBeenCalled();
    audio.sources[0].onended();
    await voiceClient.whenPlaybackDrained();
    now = 1699;
    recognizeFinal('wait');
    expect(routeFinal).not.toHaveBeenCalled();
    now = 1700;
    recognizeFinal('wait');
    expect(routeFinal).toHaveBeenCalledTimes(1);

    emitTtsAudio('another response');
    await vi.waitFor(() => expect(audio.sources).toHaveLength(2));
    audio.sources[1].onended();
    trigger('voice:tts:cancel');
    recognizeFinal('stop');
    expect(routeFinal).toHaveBeenLastCalledWith('stop');
    expect(routeFinal).toHaveBeenCalledTimes(2);
  });

  it('does not arm an echo tail for proactive audio while server admission remains canceled', async () => {
    const routeFinal = vi.fn();
    voiceClient.startWebSpeechCapture({ routeFinal });
    trigger('voice:speak', { sentence: 'proactive alert', wav: new ArrayBuffer(8) });
    await vi.waitFor(() => expect(audio.sources).toHaveLength(1));
    recognizeFinal('wait');
    expect(routeFinal).not.toHaveBeenCalled();
    audio.sources[0].onended();
    await voiceClient.whenPlaybackDrained();
    recognizeFinal('wait');
    expect(routeFinal).toHaveBeenCalledWith('wait');
  });
});
