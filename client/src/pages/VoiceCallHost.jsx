/**
 * The FaceTime Audio call host.
 *
 * This page is the audio path for a call: it opens BlackHole 16ch (what
 * FaceTime plays INTO), streams it to the server as 16 kHz mono PCM, and plays
 * the assistant's reply back out through BlackHole 2ch (what FaceTime listens
 * to as its microphone). It has to run in a real browser tab on the Mac
 * because device permissions and `setSinkId` need a real browser profile.
 *
 * Everything here fails closed and says why. A bridge that half-works drops
 * the call audio silently, so a missing API, a missing device, an ungranted
 * permission, and a second tab each produce their own message rather than a
 * spinner that never resolves.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Mic, MicOff, PhoneCall, Volume2 } from 'lucide-react';
import socket from '../services/socket';
import {
  CALL_FRAME_SAMPLES,
  CALL_HOST_LOCK,
  buildTestTone,
  describeDeviceProblem,
  downmixToMono,
  floatToInt16,
  missingCallHostApis,
  resampleTo16k,
  rmsLevel,
} from '../lib/callAudioBridge';

// A worklet has to be loaded from a URL, and this one is four lines, so it is
// built from source at runtime rather than carried as a separate build entry.
// It does no processing: the pure helpers do the downmix/resample/quantize on
// the main thread, where they can be tested without an audio graph.
const WORKLET_SOURCE = `
class CallTapProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const channels = inputs[0];
    if (channels?.length) this.port.postMessage(channels.map((c) => new Float32Array(c)));
    return true;
  }
}
registerProcessor('portos-call-tap', CallTapProcessor);
`;

const DEFAULT_INPUT_LABEL = 'BlackHole 16ch';
const DEFAULT_OUTPUT_LABEL = 'BlackHole 2ch';

export default function VoiceCallHost() {
  const [blocked, setBlocked] = useState(null);
  const [attached, setAttached] = useState(false);
  const [callState, setCallState] = useState(null);
  const [level, setLevel] = useState(0);
  const [notice, setNotice] = useState(null);
  const audio = useRef({ context: null, stream: null, node: null, source: null, outputId: null, pending: [] });
  const lockRelease = useRef(null);

  const teardown = useCallback(() => {
    const current = audio.current;
    current.node?.port?.close?.();
    current.node?.disconnect?.();
    current.source?.disconnect?.();
    current.stream?.getTracks?.().forEach((track) => track.stop());
    current.context?.close?.();
    audio.current = { context: null, stream: null, node: null, source: null, outputId: current.outputId, pending: [] };
    setLevel(0);
  }, []);

  // Play one WAV into BlackHole 2ch. `setSinkId` is what makes this land in the
  // call instead of the room's speakers, so a failure to route is surfaced
  // rather than played anyway.
  const playToCall = useCallback(async (wav) => {
    const element = new Audio();
    const blob = new Blob([wav], { type: 'audio/wav' });
    element.src = URL.createObjectURL(blob);
    try {
      if (audio.current.outputId) await element.setSinkId(audio.current.outputId);
      await element.play();
    } catch (error) {
      setNotice(`Could not play into the call: ${error.message}`);
    } finally {
      element.addEventListener('ended', () => URL.revokeObjectURL(element.src), { once: true });
    }
  }, []);

  const start = useCallback(async () => {
    setNotice(null);
    const missing = missingCallHostApis(window);
    if (missing.length) {
      setBlocked(`This browser is missing ${missing.join(', ')}. Use Chrome on the Mac running PortOS.`);
      return;
    }

    // The lock is the local half of single-attach; the server refuses a second
    // host too, but the lock catches it before any device is opened.
    //
    // `locks.request` resolves only when its CALLBACK settles, and holding a
    // lock means never settling — so awaiting the request itself would hang
    // here forever while holding the lock. The grant decision is surfaced out
    // of the callback instead, and the held promise is left open on purpose.
    const granted = await new Promise((resolve) => {
      navigator.locks.request(CALL_HOST_LOCK, { ifAvailable: true }, (held) => {
        if (!held) {
          resolve(false);
          return null;
        }
        resolve(true);
        return new Promise((release) => { lockRelease.current = release; });
      }).catch(() => resolve(false));
    });
    if (!granted) {
      setBlocked('Another tab owns the call host. Close it, or use that tab instead.');
      return;
    }

    const devices = await navigator.mediaDevices.enumerateDevices().catch(() => null);
    const problem = describeDeviceProblem(devices, { inputLabel: DEFAULT_INPUT_LABEL, outputLabel: DEFAULT_OUTPUT_LABEL });
    if (problem) {
      setBlocked(problem);
      return;
    }
    const input = devices.find((device) => device.label === DEFAULT_INPUT_LABEL && device.kind === 'audioinput');
    const output = devices.find((device) => device.label === DEFAULT_OUTPUT_LABEL && device.kind === 'audiooutput');

    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        // Every processing stage is off: this is not a room microphone, it is
        // the far end of a phone call, and echo cancellation would chew holes
        // in it. Plain booleans, never `{ exact }`, so a browser that cannot
        // honour one still opens the device.
        audio: {
          deviceId: { exact: input.deviceId },
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });
    } catch (error) {
      setBlocked(`Could not open ${DEFAULT_INPUT_LABEL}: ${error.message}`);
      return;
    }

    const context = new AudioContext();
    const url = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'application/javascript' }));
    try {
      await context.audioWorklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }
    const source = context.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(context, 'portos-call-tap');
    let carry = [];
    node.port.onmessage = (event) => {
      const mono = downmixToMono(event.data);
      setLevel(rmsLevel(mono));
      const resampled = resampleTo16k(mono, context.sampleRate);
      carry.push(...resampled);
      // Ship fixed-size frames so the server's endpointer sees a steady
      // resolution regardless of the render quantum this browser chose.
      while (carry.length >= CALL_FRAME_SAMPLES) {
        const pcm = floatToInt16(Float32Array.from(carry.slice(0, CALL_FRAME_SAMPLES)));
        carry = carry.slice(CALL_FRAME_SAMPLES);
        socket.emit('voice:call:audio', { pcm: pcm.buffer });
      }
    };
    source.connect(node);

    audio.current = { context, stream, node, source, outputId: output.deviceId, pending: [] };
    socket.emit('voice:call:attach');
    setBlocked(null);
  }, []);

  const stop = useCallback(() => {
    socket.emit('voice:call:detach');
    teardown();
    lockRelease.current?.();
    lockRelease.current = null;
    setAttached(false);
  }, [teardown]);

  useEffect(() => {
    const onState = (snapshot) => {
      if (snapshot?.error === 'host-taken') {
        setBlocked('Another tab owns the call host.');
        setAttached(false);
        return;
      }
      setCallState(snapshot);
      setAttached(Boolean(snapshot?.hostAttached));
    };
    const onTts = ({ wav }) => { if (wav) playToCall(wav); };
    socket.on('voice:call:state', onState);
    socket.on('voice:call:tts', onTts);
    return () => {
      socket.off('voice:call:state', onState);
      socket.off('voice:call:tts', onTts);
      socket.emit('voice:call:detach');
      teardown();
      lockRelease.current?.();
      lockRelease.current = null;
    };
  }, [playToCall, teardown]);

  const playTestTone = async () => {
    const context = audio.current.context || new AudioContext();
    const tone = buildTestTone(context.sampleRate, 1);
    const buffer = context.createBuffer(1, tone.length, context.sampleRate);
    buffer.copyToChannel(tone, 0);
    const source = context.createBufferSource();
    source.buffer = buffer;
    const destination = context.createMediaStreamDestination();
    source.connect(destination);
    const element = new Audio();
    element.srcObject = destination.stream;
    if (audio.current.outputId) await element.setSinkId(audio.current.outputId).catch(() => {});
    await element.play().catch((error) => setNotice(`Test tone failed: ${error.message}`));
    source.start();
  };

  return (
    <div className="mx-auto max-w-2xl space-y-4 p-4">
      <header className="space-y-1">
        <h1 className="flex items-center gap-2 text-xl font-semibold text-white"><PhoneCall size={20} />Call host</h1>
        <p className="text-sm text-gray-400">
          Keep this tab open on the Mac running PortOS. It carries the audio for a FaceTime Audio
          call: FaceTime plays into {DEFAULT_INPUT_LABEL}, and PortOS answers through {DEFAULT_OUTPUT_LABEL}.
        </p>
      </header>

      {blocked && <p role="alert" className="rounded border border-port-error bg-port-error/10 p-3 text-sm text-port-error">{blocked}</p>}
      {notice && <p role="status" className="rounded border border-port-warning bg-port-warning/10 p-3 text-sm text-port-warning">{notice}</p>}

      <section className="space-y-3 rounded-lg border border-port-border bg-port-card p-4">
        <div className="flex flex-wrap items-center gap-2">
          {attached
            ? <button type="button" onClick={stop} className="flex min-h-[44px] items-center gap-2 rounded border border-port-border px-3 text-sm text-gray-300 hover:bg-port-border/50"><MicOff size={16} />Detach call host</button>
            : <button type="button" onClick={start} className="flex min-h-[44px] items-center gap-2 rounded bg-port-accent/20 px-3 text-sm text-port-accent hover:bg-port-accent/30"><Mic size={16} />Attach call host</button>}
          <button type="button" onClick={playTestTone} disabled={!attached} className="flex min-h-[44px] items-center gap-2 rounded border border-port-border px-3 text-sm text-gray-300 hover:bg-port-border/50 disabled:opacity-50"><Volume2 size={16} />Test tone</button>
        </div>

        <div>
          <p className="mb-1 text-xs text-gray-500" id="call-host-level-label">Input level</p>
          <div aria-labelledby="call-host-level-label" role="meter" aria-valuenow={Math.round(level * 100)} aria-valuemin={0} aria-valuemax={100} className="h-2 w-full overflow-hidden rounded bg-port-bg">
            <div className="h-full bg-port-accent transition-[width]" style={{ width: `${Math.min(100, Math.round(level * 140))}%` }} />
          </div>
        </div>

        <p role="status" className="text-xs text-gray-400">
          {attached ? `Attached · call ${callState?.state || 'idle'}${callState?.turns ? ` · ${callState.turns} turns` : ''}` : 'Not attached — no call audio reaches PortOS.'}
        </p>
      </section>
    </div>
  );
}
