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
      this.sampleRate = 48_000;
      this.audioWorklet = { addModule: vi.fn(() => Promise.resolve()) };
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

    createMediaStreamSource() {
      return { connect: vi.fn((target) => target), disconnect: vi.fn() };
    }

    createGain() {
      return { gain: { value: 1 }, connect: vi.fn((target) => target) };
    }

    close() {
      this.state = 'closed';
      return Promise.resolve();
    }
  }
  return { socket, listeners, audio, FakeAudioContext };
});

vi.mock('./socket', () => ({ default: socket }));

let voiceClient;
let recognition;
class FakeSpeechRecognition {
  constructor() {
    recognition = this;
    this.startCalls = 0;
    this.stopCalls = 0;
  }
  start() { this.startCalls += 1; }
  stop() { this.stopCalls += 1; }
  abort() { this.stop(); }
}

class FakeAudioWorkletNode {
  constructor() {
    this.port = { onmessage: null };
    this.disconnect = vi.fn();
    FakeAudioWorkletNode.last = this;
  }

  connect(target) { return target; }
}

class FakeMediaRecorder {
  static isTypeSupported() { return true; }

  constructor(stream, { mimeType }) {
    this.stream = stream;
    this.mimeType = mimeType;
    this.handlers = new Map();
    this.state = 'inactive';
    FakeMediaRecorder.last = this;
  }

  addEventListener(event, handler) {
    const handlers = this.handlers.get(event) || [];
    handlers.push(handler);
    this.handlers.set(event, handlers);
  }

  dispatch(event, payload) {
    for (const handler of this.handlers.get(event) || []) handler(payload);
  }

  start() { this.state = 'recording'; }

  stop() {
    this.state = 'inactive';
    this.dispatch('dataavailable', { data: { size: 1_000 } });
    this.dispatch('stop');
  }
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
    vi.stubGlobal('AudioWorkletNode', FakeAudioWorkletNode);
    window.AudioContext = FakeAudioContext;
    window.SpeechRecognition = FakeSpeechRecognition;
    voiceClient = await import('./voiceClient.js');
  });

  beforeEach(() => {
    trigger('voice:tts:cancel');
    audio.decodeCalls = 0;
    audio.decodeImpl = () => Promise.resolve({});
    audio.sources.length = 0;
    socket.emit.mockClear();
    voiceClient.disposeCaptureOwner();
  });

  afterEach(() => {
    voiceClient.disposeCaptureOwner();
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

  it('drops recorder callbacks and releases the mic when its owner is disposed', async () => {
    const previousRecorder = window.MediaRecorder;
    const previousGlobalRecorder = globalThis.MediaRecorder;
    const previousMediaDevices = navigator.mediaDevices;
    const track = { stop: vi.fn() };
    const getUserMedia = vi.fn().mockResolvedValue({ getTracks: () => [track] });
    window.MediaRecorder = FakeMediaRecorder;
    globalThis.MediaRecorder = FakeMediaRecorder;
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia },
    });

    await voiceClient.startCapture();
    const activeRecorder = FakeMediaRecorder.last;
    voiceClient.disposeCaptureOwner();
    activeRecorder.dispatch('dataavailable', { data: { size: 1_000 } });

    expect(track.stop).toHaveBeenCalledOnce();
    expect(voiceClient.isCapturing()).toBe(false);
    expect(socket.emit).not.toHaveBeenCalledWith('voice:turn', expect.anything());

    window.MediaRecorder = previousRecorder;
    if (previousGlobalRecorder === undefined) delete globalThis.MediaRecorder;
    else globalThis.MediaRecorder = previousGlobalRecorder;
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: previousMediaDevices,
    });
  });

  it('ignores VAD worklet frames and async submissions after owner disposal', async () => {
    const previousMediaDevices = navigator.mediaDevices;
    const track = { stop: vi.fn() };
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [track] }) },
    });
    const onSpeechStart = vi.fn();
    const onSubmit = vi.fn();

    await voiceClient.startContinuous({ onSpeechStart, onSubmit });
    const lateFrame = FakeAudioWorkletNode.last.port.onmessage;
    voiceClient.disposeCaptureOwner();
    lateFrame?.({ data: new Float32Array([1, 1, 1, 1]) });

    expect(track.stop).toHaveBeenCalledOnce();
    expect(voiceClient.isContinuous()).toBe(false);
    expect(onSpeechStart).not.toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(socket.emit).not.toHaveBeenCalledWith('voice:turn', expect.anything());

    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: previousMediaDevices,
    });
  });

  describe('continuous startup rollback', () => {
    let previousMediaDevices;
    let previousAudioSession;
    let tracks;
    let getUserMedia;

    beforeEach(() => {
      previousMediaDevices = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices');
      previousAudioSession = Object.getOwnPropertyDescriptor(navigator, 'audioSession');
      tracks = [{ stop: vi.fn() }, { stop: vi.fn() }];
      getUserMedia = vi.fn().mockResolvedValue({ getTracks: () => tracks });
      Object.defineProperty(navigator, 'mediaDevices', {
        configurable: true,
        value: { getUserMedia },
      });
      Object.defineProperty(navigator, 'audioSession', {
        configurable: true,
        value: { type: 'auto' },
      });
    });

    afterEach(async () => {
      await voiceClient.stopContinuous();
      if (previousMediaDevices) Object.defineProperty(navigator, 'mediaDevices', previousMediaDevices);
      else delete navigator.mediaDevices;
      if (previousAudioSession) Object.defineProperty(navigator, 'audioSession', previousAudioSession);
      else delete navigator.audioSession;
    });

    // Each stage leaves a different set of acquired resources to unwind.
    it.each(['constructor', 'source', 'worklet node', 'connection', 'resume', 'module'])(
      'releases the microphone and permits retry after a %s failure', async (stage) => {
        const error = new Error(`${stage} failed`);
        const fail = () => { throw error; };
        const context = new FakeAudioContext();
        const close = vi.spyOn(context, 'close');
        vi.spyOn(window, 'AudioContext').mockImplementationOnce(function () {
          if (stage === 'constructor') throw error;
          return context;
        });
        if (stage === 'source') vi.spyOn(context, 'createMediaStreamSource').mockImplementationOnce(fail);
        if (stage === 'worklet node') {
          vi.spyOn(globalThis, 'AudioWorkletNode').mockImplementationOnce(function () { throw error; });
        }
        if (stage === 'connection') vi.spyOn(FakeAudioWorkletNode.prototype, 'connect').mockImplementationOnce(fail);
        if (stage === 'resume') {
          context.state = 'suspended';
          vi.spyOn(context, 'resume').mockRejectedValueOnce(error);
        }
        if (stage === 'module') context.audioWorklet.addModule.mockRejectedValueOnce(error);
        const createUrl = vi.spyOn(URL, 'createObjectURL');
        const revokeUrl = vi.spyOn(URL, 'revokeObjectURL');

        await expect(voiceClient.startContinuous()).rejects.toBe(error);

        tracks.forEach((track) => expect(track.stop).toHaveBeenCalledOnce());
        expect(navigator.audioSession.type).toBe('auto');
        expect(voiceClient.isContinuous()).toBe(false);
        expect(close).toHaveBeenCalledTimes(stage === 'constructor' ? 0 : 1);
        createUrl.mock.results.forEach(({ value }) => expect(revokeUrl).toHaveBeenCalledWith(value));
        await voiceClient.stopContinuous();
        tracks.forEach((track) => expect(track.stop).toHaveBeenCalledOnce());

        const retryTrack = { stop: vi.fn() };
        getUserMedia.mockResolvedValueOnce({ getTracks: () => [retryTrack] });
        await voiceClient.startContinuous();
        expect(getUserMedia).toHaveBeenCalledTimes(2);
        expect(voiceClient.isContinuous()).toBe(true);
        expect(navigator.audioSession.type).toBe('play-and-record');
        expect(retryTrack.stop).not.toHaveBeenCalled();
        await voiceClient.stopContinuous();
        expect(retryTrack.stop).toHaveBeenCalledOnce();
        expect(navigator.audioSession.type).toBe('auto');
      },
    );

    it.each(['resolve', 'reject'])('does not stop a retry when a disposed startup later %ss', async (outcome) => {
      let resolveModule;
      let rejectModule;
      const context = new FakeAudioContext();
      context.audioWorklet.addModule.mockImplementationOnce(() => new Promise((resolve, reject) => {
        resolveModule = resolve;
        rejectModule = reject;
      }));
      vi.spyOn(window, 'AudioContext').mockImplementationOnce(function () { return context; });
      const pending = voiceClient.startContinuous();
      await vi.waitFor(() => expect(context.audioWorklet.addModule).toHaveBeenCalledOnce());
      voiceClient.disposeCaptureOwner();
      const retryTrack = { stop: vi.fn() };
      getUserMedia.mockResolvedValueOnce({ getTracks: () => [retryTrack] });
      await voiceClient.startContinuous();

      if (outcome === 'reject') {
        const error = new Error('old module failed');
        const rejection = expect(pending).rejects.toBe(error);
        rejectModule(error);
        await rejection;
      } else {
        resolveModule();
        await expect(pending).resolves.toBeNull();
      }
      expect(voiceClient.isContinuous()).toBe(true);
      expect(navigator.audioSession.type).toBe('play-and-record');
      expect(retryTrack.stop).not.toHaveBeenCalled();
    });
  });

  it('ignores Web Speech results and restart errors after owner disposal', () => {
    const routeFinal = vi.fn();
    const onError = vi.fn();
    voiceClient.startWebSpeechCapture({ routeFinal, onError });
    const oldRecognition = recognition;
    voiceClient.disposeCaptureOwner();

    oldRecognition.onresult?.({
      resultIndex: 0,
      results: [Object.assign([{ transcript: 'late result' }], { isFinal: true })],
    });
    oldRecognition.onerror?.({ error: 'not-allowed' });

    expect(oldRecognition.stopCalls).toBe(1);
    expect(routeFinal).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(voiceClient.isWebSpeechCapturing()).toBe(false);
  });
});
