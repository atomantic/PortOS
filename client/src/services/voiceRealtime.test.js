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

  const makeAudioContext = (opts) => {
    const sourceNode = { connect: vi.fn(), disconnect: vi.fn() };
    const ctx = {
      sampleRate: opts?.sampleRate,
      currentTime: 0,
      destination: {},
      createGain: vi.fn(() => ({ gain: { value: 1 }, connect: vi.fn() })),
      audioWorklet: {
        addModule: vi.fn(async () => {
          if (addModuleError) throw addModuleError;
        }),
      },
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
    vi.stubGlobal('AudioWorkletNode', vi.fn(function AudioWorkletNodeMock() {
      if (workletNodeError) throw workletNodeError;
      workletNode = { port: { onmessage: null } };
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
    workletNode.port.onmessage({ data: new Float32Array(640) });
    expect(socketMock.emit).not.toHaveBeenCalledWith('voice:realtime:audio', expect.anything());

    // Activate call and send 500 samples -> emits 1 full 320-sample frame (640 bytes), buffers 180.
    socketListeners.get('voice:realtime:state')({ active: true });
    expect(onState).toHaveBeenCalledWith({ active: true });
    workletNode.port.onmessage({ data: new Float32Array(500).fill(0.5) });
    const audioEmits = () => socketMock.emit.mock.calls.filter(([ev]) => ev === 'voice:realtime:audio');
    expect(audioEmits()).toHaveLength(1);
    expect(audioEmits()[0][1].pcm.byteLength).toBe(640);

    // Sending 140 more completes a second 320-sample frame.
    workletNode.port.onmessage({ data: new Float32Array(140).fill(0.5) });
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
    expect(socketMock.emit).toHaveBeenCalledWith('voice:realtime:interrupt', {});

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

  it('stops a finished reply still playing behind the avatar when the voice reports a late onset, and reports what was heard', async () => {
    const anims = [];
    let avatarReady;
    playbackMock.visualizer = vi.fn(() => {
      // The avatar takes a while to prepare the first segment; later ones are ready at once.
      const ready = anims.length ? Promise.resolve() : new Promise((resolve) => { avatarReady = resolve; });
      const anim = { ready, start: vi.fn(), stop: vi.fn() };
      anims.push(anim);
      return anim;
    });
    const handle = await startRealtimeCall();
    const out = contexts[1];
    const audio = socketListeners.get('voice:realtime:audio');
    // A whole 1 s reply arrives at once and the voice reports it finished: its generation is over.
    audio({ pcm: new Int16Array(14400).buffer, sampleRate: 24000, replyId: 'a1' });
    audio({ pcm: new Int16Array(9600).buffer, sampleRate: 24000, replyId: 'a1' });
    socketListeners.get('voice:realtime:reply')({ text: 'Hello there', cancelled: false, replyId: 'a1' });
    await vi.waitFor(() => expect(anims).toHaveLength(1));
    expect(scheduledSources).toHaveLength(0);
    // Playback only starts once the avatar is ready, 0.75 s later on the browser clock.
    out.currentTime = 0.75;
    avatarReady();
    await vi.waitFor(() => expect(scheduledSources).toHaveLength(2));
    expect(scheduledSources.map((src) => src.start.mock.calls[0][0])).toEqual([0.78, expect.closeTo(1.38, 6)]);
    // At 1.2 s the voice's clock says the reply is over, but here it is still playing: the onset stops it.
    out.currentTime = 1.2;
    socketListeners.get('voice:realtime:onset')({ replyId: 'a1' });
    expect(scheduledSources.every((src) => src.stop.mock.calls.length === 1)).toBe(true);
    expect(anims.every((anim) => anim.stop.mock.calls.length > 0)).toBe(true);
    expect(socketMock.emit).toHaveBeenCalledWith('voice:realtime:cut', { replyId: 'a1', playedS: 0.42 });
    handle.stop();
  });

  it('never lets an older reply or finished playback stop a newer reply, and the manual interrupt still stops everything', async () => {
    const handle = await startRealtimeCall();
    const out = contexts[1];
    const audio = socketListeners.get('voice:realtime:audio');
    const interrupt = socketListeners.get('voice:realtime:interrupt');
    const onset = socketListeners.get('voice:realtime:onset');
    const cuts = () => socketMock.emit.mock.calls.filter(([ev]) => ev === 'voice:realtime:cut').map(([, data]) => data);
    audio({ pcm: new Int16Array(2400).buffer, sampleRate: 24000, replyId: 'b1' });
    // The voice cuts b1 itself; its audio stops and a late chunk of it is dropped.
    interrupt({ replyId: 'b1' });
    expect(scheduledSources[0].stop).toHaveBeenCalledTimes(1);
    expect(cuts()).toEqual([{ replyId: 'b1', playedS: 0 }]);
    audio({ pcm: new Int16Array(2400).buffer, sampleRate: 24000, replyId: 'b1' });
    expect(scheduledSources).toHaveLength(1);
    // A newer reply plays; b1's stale interrupt and onset leave it alone.
    audio({ pcm: new Int16Array(2400).buffer, sampleRate: 24000, replyId: 'b2' });
    expect(scheduledSources).toHaveLength(2);
    interrupt({ replyId: 'b1' });
    onset({ replyId: 'b1' });
    expect(scheduledSources[1].stop).not.toHaveBeenCalled();
    // Once b2 has finished playing here, an onset for it is not an interruption.
    out.currentTime = 1;
    onset({ replyId: 'b2' });
    expect(scheduledSources[1].stop).not.toHaveBeenCalled();
    expect(cuts()).toHaveLength(1);
    // The Interrupt button stops what is playing and tells the voice how much of it was heard.
    audio({ pcm: new Int16Array(2400).buffer, sampleRate: 24000, replyId: 'b3' });
    handle.interrupt();
    expect(scheduledSources[2].stop).toHaveBeenCalledTimes(1);
    expect(socketMock.emit).toHaveBeenCalledWith('voice:realtime:interrupt', { replyId: 'b3', playedS: 0 });
    handle.stop();
  });

  it('stops an older reply still playing ahead of the reply an onset or the Interrupt button names', async () => {
    const handle = await startRealtimeCall();
    const out = contexts[1];
    const audio = socketListeners.get('voice:realtime:audio');
    const cuts = () => socketMock.emit.mock.calls.filter(([ev]) => ev === 'voice:realtime:cut').map(([, data]) => data);
    // A follow-up (c2) queues behind the tail of c1, which is still playing.
    audio({ pcm: new Int16Array(24000).buffer, sampleRate: 24000, replyId: 'c1' });
    audio({ pcm: new Int16Array(24000).buffer, sampleRate: 24000, replyId: 'c2' });
    out.currentTime = 0.53;
    socketListeners.get('voice:realtime:onset')({ replyId: 'c2' });
    expect(scheduledSources.every((src) => src.stop.mock.calls.length === 1)).toBe(true);
    expect(cuts()).toEqual([{ replyId: 'c1', playedS: 0.5 }, { replyId: 'c2', playedS: 0 }]);
    // The same holds for the Interrupt button: every reply it stops reports what was heard of it.
    audio({ pcm: new Int16Array(24000).buffer, sampleRate: 24000, replyId: 'c3' });
    audio({ pcm: new Int16Array(24000).buffer, sampleRate: 24000, replyId: 'c4' });
    out.currentTime = 1.03;
    handle.interrupt();
    expect(scheduledSources.every((src) => src.stop.mock.calls.length === 1)).toBe(true);
    expect(cuts().slice(2)).toEqual([{ replyId: 'c3', playedS: 0.47 }]);
    expect(socketMock.emit).toHaveBeenLastCalledWith('voice:realtime:interrupt', { replyId: 'c4', playedS: 0 });
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
