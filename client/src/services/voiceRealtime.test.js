import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const socketListeners = new Map();
const socketMock = vi.hoisted(() => ({
  connected: true,
  emit: vi.fn(),
  on: vi.fn((event, fn) => { socketListeners.set(event, fn); }),
  off: vi.fn((event, fn) => { if (socketListeners.get(event) === fn) socketListeners.delete(event); }),
}));
vi.mock('./socket', () => ({ default: socketMock }));
const playbackMock = vi.hoisted(() => ({ visualizer: undefined }));
vi.mock('./voicePlayback.js', () => ({
  getVoiceOutputVisualizer: () => playbackMock.visualizer,
  getVoiceVolume: () => 0.8,
  isVoiceMuted: () => false,
  onVoiceAudioPrefs: (fn) => { fn({ volume: 0.8, muted: false }); return () => {}; },
}));
import { floatToPcm16, pcm16ToFloat, startRealtimeCall } from './voiceRealtime';

describe('realtime PCM helpers', () => {
  it('clamps and converts float samples to PCM16 and back', () => {
    const pcm = new Int16Array(floatToPcm16(new Float32Array([0, 1, -1, 2, -2, 0.5])));
    expect(Array.from(pcm)).toEqual([0, 32767, -32768, 32767, -32768, 16383]);
    const back = pcm16ToFloat(pcm.buffer);
    expect(back[1]).toBeCloseTo(1, 3);
    expect(back[2]).toBe(-1);
  });

  it('reads PCM16 from a misaligned byte view and drops a trailing odd byte', () => {
    const bytes = new Uint8Array(7);
    new DataView(bytes.buffer).setInt16(1, 16384, true);
    expect(Array.from(pcm16ToFloat(bytes.subarray(1)))).toEqual([0.5, 0, 0]);
  });

  it('returns empty samples for missing or unsupported payloads', () => {
    expect(pcm16ToFloat(null)).toHaveLength(0);
    expect(pcm16ToFloat(undefined)).toHaveLength(0);
    expect(pcm16ToFloat({})).toHaveLength(0);
  });
});

describe('startRealtimeCall', () => {
  let track;
  let contexts;
  let workletNode;
  let scheduledSources;
  let addModuleError;
  let workletNodeError;
  let tapNode;
  let gains;
  let outputTimestamps;
  let tapAddModuleError;

  const makeAudioContext = (opts) => {
    const sourceNode = { connect: vi.fn(), disconnect: vi.fn() };
    const isOutput = opts?.sampleRate === 24000;
    const ctx = {
      sampleRate: opts?.sampleRate,
      currentTime: 0,
      destination: {},
      createGain: vi.fn(() => {
        const gain = { gain: { value: 1 }, connect: vi.fn() };
        gains.push(gain);
        return gain;
      }),
      audioWorklet: {
        addModule: vi.fn(async () => {
          if (addModuleError) throw addModuleError;
          if (isOutput && tapAddModuleError) throw tapAddModuleError;
        }),
      },
      ...(outputTimestamps && { getOutputTimestamp: () => outputTimestamps }),
      createMediaStreamSource: vi.fn(() => sourceNode),
      createBuffer: vi.fn((_ch, length, rate) => ({
        duration: length / rate,
        copyToChannel: vi.fn(),
      })),
      createBufferSource: vi.fn(() => {
        const src = { buffer: null, connect: vi.fn(), start: vi.fn(), stop: vi.fn(), onended: null };
        scheduledSources.push(src);
        return src;
      }),
      resume: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      _sourceNode: sourceNode,
    };
    contexts.push(ctx);
    return ctx;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    socketListeners.clear();
    socketMock.connected = true;
    contexts = [];
    scheduledSources = [];
    addModuleError = null;
    workletNodeError = null;
    track = { stop: vi.fn() };
    workletNode = null;
    tapNode = null;
    gains = [];
    outputTimestamps = null;
    tapAddModuleError = null;
    playbackMock.visualizer = undefined;

    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [track] })) },
    });
    const AudioContextCtor = vi.fn(function AudioContextMock(opts) {
      return makeAudioContext(opts);
    });
    vi.stubGlobal('window', { AudioContext: AudioContextCtor });
    vi.stubGlobal('AudioContext', AudioContextCtor);
    vi.stubGlobal('AudioWorkletNode', vi.fn(function AudioWorkletNodeMock(_ctx, name) {
      const created = { port: { onmessage: null }, connect: vi.fn(), disconnect: vi.fn() };
      if (name === 'portos-realtime-tap') {
        tapNode = created;
        return created;
      }
      if (workletNodeError) throw workletNodeError;
      workletNode = created;
      return workletNode;
    }));
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:realtime-worklet');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('releases the microphone, closes audio contexts, and revokes the worklet URL if addModule fails', async () => {
    addModuleError = new Error('worklet load failed');

    await expect(startRealtimeCall()).rejects.toThrow('worklet load failed');

    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(contexts).toHaveLength(2);
    expect(contexts[0].close).toHaveBeenCalledTimes(1);
    expect(contexts[1].close).toHaveBeenCalledTimes(1);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:realtime-worklet');
    expect(socketMock.emit).not.toHaveBeenCalledWith('voice:realtime:start');
  });

  it('gates mic streaming on live state, chunks 320-sample frames, flushes on interrupt, and stops idempotently', async () => {
    const onState = vi.fn();
    const onReply = vi.fn();
    const handle = await startRealtimeCall({ onState, onReply });

    expect(socketMock.emit).toHaveBeenCalledWith('voice:realtime:start');

    // Mic audio before state.active=true is ignored.
    workletNode.port.onmessage({ data: { ch: new Float32Array(640), frame: 0 } });
    expect(socketMock.emit).not.toHaveBeenCalledWith('voice:realtime:audio', expect.anything());

    // Activate call and send 500 samples -> emits 1 full 320-sample frame (640 bytes), buffers 180.
    socketListeners.get('voice:realtime:state')({ active: true });
    expect(onState).toHaveBeenCalledWith({ active: true });
    workletNode.port.onmessage({ data: { ch: new Float32Array(500).fill(0.5), frame: 0 } });
    const audioEmits = () => socketMock.emit.mock.calls.filter(([ev]) => ev === 'voice:realtime:audio');
    expect(audioEmits()).toHaveLength(1);
    expect(audioEmits()[0][1].pcm.byteLength).toBe(640);
    // No output timestamps: browser echo cancellation only, and no playback reference goes up.
    expect(tapNode).toBeNull();
    expect(audioEmits()[0][1]).not.toHaveProperty('far');

    // Sending 140 more completes a second 320-sample frame.
    workletNode.port.onmessage({ data: { ch: new Float32Array(140).fill(0.5), frame: 128 } });
    expect(audioEmits()).toHaveLength(2);

    // Incoming reply audio schedules gapless playback; server interrupt stops scheduled sources.
    socketListeners.get('voice:realtime:audio')({ pcm: new Int16Array(240).buffer });
    socketListeners.get('voice:realtime:audio')({ pcm: new Int16Array(240).buffer });
    expect(scheduledSources).toHaveLength(2);
    expect(scheduledSources[1].start.mock.calls[0][0]).toBeGreaterThan(scheduledSources[0].start.mock.calls[0][0]);

    socketListeners.get('voice:realtime:interrupt')();
    expect(scheduledSources[0].stop).toHaveBeenCalledTimes(1);
    expect(scheduledSources[1].stop).toHaveBeenCalledTimes(1);

    // Client-initiated interrupt flushes playback and notifies server.
    socketListeners.get('voice:realtime:audio')({ pcm: new Int16Array(240).buffer });
    handle.interrupt();
    expect(scheduledSources[2].stop).toHaveBeenCalledTimes(1);
    expect(socketMock.emit).toHaveBeenCalledWith('voice:realtime:interrupt');

    // Reply forwarding works before stop.
    socketListeners.get('voice:realtime:reply')({ text: 'Hello', cancelled: false });
    expect(onReply).toHaveBeenCalledWith({ text: 'Hello', cancelled: false });

    // stop() is idempotent and cleans up listeners, worklet, tracks, and contexts.
    handle.stop();
    handle.stop();
    expect(socketMock.emit.mock.calls.filter(([ev]) => ev === 'voice:realtime:stop')).toHaveLength(1);
    expect(socketListeners.size).toBe(0);
    expect(workletNode.port.onmessage).toBeNull();
    expect(contexts[0]._sourceNode.disconnect).toHaveBeenCalledTimes(1);
    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(contexts[0].close).toHaveBeenCalledTimes(1);
    expect(contexts[1].close).toHaveBeenCalledTimes(1);
  });

  describe('playback reference', () => {
    const farRms = (payload) => {
      const far = new Int16Array(payload.far);
      return Math.sqrt(far.reduce((sum, v) => sum + (v / 0x8000) ** 2, 0) / far.length);
    };
    const audioPayloads = () => socketMock.emit.mock.calls.filter(([ev]) => ev === 'voice:realtime:audio').map(([, p]) => p);

    beforeEach(() => {
      // Context time 0 is heard at performance time 1000 ms, and the mic's render position is at context time 0 then.
      outputTimestamps = { contextTime: 0, performanceTime: 1000 };
      vi.spyOn(performance, 'now').mockReturnValue(1000);
    });

    it('sends each mic frame with what the speaker played over the same span, post-volume and only once rendered', async () => {
      const handle = await startRealtimeCall();
      socketListeners.get('voice:realtime:state')({ active: true });
      // The tap sits between the output gain and the speaker.
      expect(gains[0].connect).toHaveBeenCalledWith(tapNode);
      expect(tapNode.connect).toHaveBeenCalledWith(contexts[1].destination);

      // Nothing rendered yet: the reference is silent even though reply audio is queued.
      socketListeners.get('voice:realtime:audio')({ pcm: new Int16Array(4800).fill(9000).buffer });
      workletNode.port.onmessage({ data: { ch: new Float32Array(320).fill(0.02), frame: 0 } });
      expect(farRms(audioPayloads()[0])).toBe(0);

      // The tap renders 40 ms of playback at 0.3 from context time 0; the echo of it is captured from 1000 ms.
      tapNode.port.onmessage({ data: { ch: new Float32Array(960).fill(0.3), frame: 0 } });
      workletNode.port.onmessage({ data: { ch: new Float32Array(320).fill(0.02), frame: 0 } });
      expect(farRms(audioPayloads()[1])).toBeCloseTo(0.3, 3);
      expect(audioPayloads()[1].far.byteLength).toBe(audioPayloads()[1].pcm.byteLength);

      // Muted output renders silence through the tap, so the reference for that span is silent.
      tapNode.port.onmessage({ data: { ch: new Float32Array(960), frame: 960 } });
      workletNode.port.onmessage({ data: { ch: new Float32Array(320).fill(0.02), frame: 640 } });
      expect(farRms(audioPayloads()[2])).toBe(0);

      handle.stop();
      expect(tapNode.port.onmessage).toBeNull();
      expect(tapNode.disconnect).toHaveBeenCalledTimes(1);
    });

    it('falls back to browser echo cancellation alone when the output tap cannot load', async () => {
      tapAddModuleError = new Error('no worklet on the output context');
      const handle = await startRealtimeCall();
      socketListeners.get('voice:realtime:state')({ active: true });
      expect(tapNode).toBeNull();
      expect(gains[0].connect).toHaveBeenCalledWith(contexts[1].destination);
      workletNode.port.onmessage({ data: { ch: new Float32Array(320), frame: 0 } });
      expect(audioPayloads()[0]).not.toHaveProperty('far');
      handle.stop();
    });
  });

  it('with the avatar running, renders reply audio in segments before playing each, and drops them on interrupt', async () => {
    const anims = [];
    playbackMock.visualizer = vi.fn(() => {
      const anim = { ready: Promise.resolve(), start: vi.fn(), stop: vi.fn() };
      anims.push(anim);
      return anim;
    });
    const handle = await startRealtimeCall();
    const audio = socketListeners.get('voice:realtime:audio');
    // 0.5 s is under the first segment's 0.6 s: nothing is played or rendered yet.
    audio({ pcm: new Int16Array(12000).buffer });
    expect(playbackMock.visualizer).not.toHaveBeenCalled();
    expect(scheduledSources).toHaveLength(0);
    // Reaching 0.6 s hands one WAV of the whole segment to the avatar, then plays it in sync.
    audio({ pcm: new Int16Array(2400).buffer });
    await vi.waitFor(() => expect(playbackMock.visualizer).toHaveBeenCalledTimes(1));
    const wav = playbackMock.visualizer.mock.calls[0][0];
    expect(new TextDecoder().decode(new Uint8Array(wav, 0, 4))).toBe('RIFF');
    expect(wav.byteLength).toBe(44 + 14400 * 2);
    await vi.waitFor(() => expect(scheduledSources).toHaveLength(1));
    expect(anims[0].start).toHaveBeenCalledTimes(1);
    // The end of a reply sends whatever is buffered; an interrupt stops the avatar with the audio.
    audio({ pcm: new Int16Array(4800).buffer });
    socketListeners.get('voice:realtime:reply')({ text: 'Hi', cancelled: false });
    await vi.waitFor(() => expect(scheduledSources).toHaveLength(2));
    socketListeners.get('voice:realtime:interrupt')();
    expect(anims.every((a) => a.stop.mock.calls.length > 0)).toBe(true);
    expect(scheduledSources.every((src) => src.stop.mock.calls.length === 1)).toBe(true);
    handle.stop();
  });

  it('releases mic tracks and AudioContexts if AudioWorkletNode construction fails', async () => {
    workletNodeError = new Error('worklet node failed');
    await expect(startRealtimeCall()).rejects.toThrow('worklet node failed');
    expect(contexts[0]._sourceNode.disconnect).toHaveBeenCalledTimes(1);
    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(contexts).toHaveLength(2);
    expect(contexts[0].close).toHaveBeenCalledTimes(1);
    expect(contexts[1].close).toHaveBeenCalledTimes(1);
  });

  it('releases mic and reports disconnect when the socket drops mid-call', async () => {
    const onState = vi.fn();
    await startRealtimeCall({ onState });
    expect(socketMock.emit).toHaveBeenCalledWith('voice:realtime:start');

    socketListeners.get('disconnect')();
    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(contexts[0].close).toHaveBeenCalledTimes(1);
    expect(onState).toHaveBeenCalledWith({ active: false, error: 'Connection to PortOS was lost.' });
    expect(socketListeners.size).toBe(0);
  });

  it('tears down immediately if the socket disconnected during audio setup', async () => {
    socketMock.connected = false;
    const onState = vi.fn();
    await startRealtimeCall({ onState });
    expect(socketMock.emit).not.toHaveBeenCalledWith('voice:realtime:start');
    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(contexts[0].close).toHaveBeenCalledTimes(1);
    expect(onState).toHaveBeenCalledWith({ active: false, error: 'Connection to PortOS was lost.' });
  });
});

describe('realtime call ownership', () => {
  it('announces the call to the voice widget from start to hang-up, and on a failed start', async () => {
    const { startRealtimeCall, isRealtimeCallActive, REALTIME_ACTIVE_EVENT } = await import('./voiceRealtime');
    const target = new EventTarget();
    const seen = [];
    target.addEventListener(REALTIME_ACTIVE_EVENT, (e) => seen.push(e.detail.active));
    const AudioContextCtor = vi.fn(function Ctx() {
      this.audioWorklet = { addModule: vi.fn().mockRejectedValue(new Error('no worklet')) };
      this.close = vi.fn(() => Promise.resolve());
    });
    vi.stubGlobal('window', Object.assign(target, { AudioContext: AudioContextCtor }));
    const track = { stop: vi.fn() };
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [track] }) } });
    try {
      await expect(startRealtimeCall()).rejects.toThrow('no worklet');
      expect(seen).toEqual([true, false]);
      expect(isRealtimeCallActive()).toBe(false);
      expect(track.stop).toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
