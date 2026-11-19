import { useCallback, useEffect, useRef, useState } from 'react';

const MAX_GAIN = 0.05;
const FADE_OUT_SECONDS = 0.04;

export default function MeditationTab() {
  const [duration, setDuration] = useState(5);
  const [volume, setVolume] = useState(20);
  const [playing, setPlaying] = useState(false);
  const [message, setMessage] = useState('');
  const session = useRef(null);

  const stop = useCallback((update = true) => {
    const current = session.current;
    session.current = null;
    if (current) {
      clearTimeout(current.timer);
      const { context, carrier, modulator, stopGain, end } = current;
      const now = context.currentTime;
      const close = () => {
        carrier.onended = null;
        context.close().catch(() => {});
      };
      if (context.state === 'running' && now < end) {
        // A separate gain lets an early stop fade smoothly during either scheduled ramp.
        const stopAt = Math.min(end, now + FADE_OUT_SECONDS);
        stopGain.gain.setValueAtTime(1, now);
        stopGain.gain.linearRampToValueAtTime(0, stopAt);
        // The audio clock controls the fade even when page timers are throttled.
        const cleanup = setTimeout(close, 250);
        carrier.onended = () => {
          clearTimeout(cleanup);
          close();
        };
        carrier.stop(stopAt);
        modulator.stop(stopAt);
      } else {
        // Closing also cancels a pending resume, which could otherwise start sound later.
        close();
      }
    }
    if (update) setPlaying(false);
  }, []);

  useEffect(() => {
    const onKey = (event) => { if (event.key === 'Escape') stop(); };
    const onVisibility = () => { if (document.hidden) stop(); };
    const onPageHide = () => stop();
    window.addEventListener('keydown', onKey);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', onPageHide);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onPageHide);
      stop(false);
    };
  }, [stop]);

  const start = async () => {
    if (session.current || document.hidden) return;
    setMessage('');
    let context;
    let startedSession;
    try {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) throw new Error('Audio unavailable');
      context = new AudioContextClass();
      const carrier = context.createOscillator();
      const modulator = context.createOscillator();
      const modulationDepth = context.createGain();
      const modulation = context.createGain();
      const output = context.createGain();
      const stopGain = context.createGain();
      const startAt = context.currentTime;
      const end = startAt + duration * 60;
      const level = MAX_GAIN * volume / 100;
      carrier.frequency.value = 200;
      modulator.frequency.value = 40;
      modulationDepth.gain.value = 0.5;
      modulation.gain.value = 0.5;
      output.gain.setValueAtTime(0, startAt);
      output.gain.linearRampToValueAtTime(level, startAt + 1);
      output.gain.setValueAtTime(level, end - FADE_OUT_SECONDS);
      output.gain.linearRampToValueAtTime(0, end);
      modulator.connect(modulationDepth).connect(modulation.gain);
      carrier.connect(modulation).connect(output).connect(stopGain).connect(context.destination);
      carrier.start();
      modulator.start();
      carrier.stop(end);
      modulator.stop(end);
      const current = { context, carrier, modulator, stopGain, end, timer: null };
      session.current = current;
      startedSession = current;
      carrier.onended = () => {
        if (session.current === current) {
          stop();
          setMessage('Session complete.');
        }
      };
      // Wall-clock backstop also ends a session if the audio clock is suspended.
      current.timer = setTimeout(() => {
        if (session.current === current) {
          stop();
          setMessage('Session complete.');
        }
      }, duration * 60 * 1000);
      setPlaying(true);
      if (context.state === 'suspended') await context.resume();
    } catch {
      if (startedSession && session.current !== startedSession) return;
      if (session.current?.context === context) stop();
      else if (context && context.state !== 'closed') context.close().catch(() => {});
      setMessage('Audio could not start. Check your browser and audio output, then try again.');
    }
  };

  return (
    <section className="mx-auto max-w-2xl space-y-4" aria-labelledby="meditation-title">
      <div>
        <h2 id="meditation-title" className="text-xl font-semibold">40 Hz sound meditation</h2>
        <p className="mt-2 text-sm text-gray-400">An experimental meditation aid: a 200 Hz tone gently modulated at 40 Hz. This is not medical treatment, a calibrated clinical device, or a guarantee of brainwave entrainment or improved cognition.</p>
      </div>
      <div className="space-y-4 rounded-lg border border-port-border bg-port-card p-4">
        <p className="text-sm">Start with your device volume low. Stop if you experience discomfort, headache, dizziness, or ringing in your ears. Avoid use if sound triggers symptoms for you.</p>
        <div className="flex flex-wrap gap-4">
          <div>
            <label htmlFor="meditation-duration" className="mb-1 block text-sm">Session length</label>
            <select id="meditation-duration" value={duration} onChange={(event) => setDuration(Number(event.target.value))} disabled={playing} className="rounded border border-port-border bg-port-bg px-3 py-2">
              <option value={1}>1 minute</option><option value={5}>5 minutes</option><option value={10}>10 minutes</option>
            </select>
          </div>
          <div>
            <label htmlFor="meditation-volume" className="mb-1 block text-sm">Sound level: {volume}%</label>
            <input id="meditation-volume" type="range" min="0" max="100" step="5" value={volume} onChange={(event) => setVolume(Number(event.target.value))} disabled={playing} />
            <p className="text-xs text-gray-400">Set before starting; device volume also affects loudness.</p>
          </div>
        </div>
        {playing ? (
          <button type="button" onClick={() => stop()} className="rounded border border-port-error px-4 py-2 hover:bg-port-error/20 focus-visible:outline">Stop sound</button>
        ) : (
          <button type="button" onClick={start} className="rounded border border-port-accent px-4 py-2 hover:bg-port-accent/20 focus-visible:outline">Start sound</button>
        )}
        <p className="text-sm text-gray-400">Stop at any time with the button or Escape. Sound stops when you leave this page or switch tabs. The timer is a convenience, not a therapeutic dose.</p>
        <p role="status" className="text-sm">{playing ? 'Sound is playing.' : message}</p>
      </div>
      <div className="space-y-2 rounded-lg border border-port-border p-4 text-sm">
        <h3 className="font-semibold">About light and the evidence</h3>
        <p>This page uses static visuals only; it does not provide synchronized 40 Hz light. Flashing light can trigger seizures in people with photosensitive epilepsy and can provoke migraines. Browser and display timing cannot reliably verify the emitted flashes; a 60 Hz screen cannot faithfully display 40 Hz flicker.</p>
        <p>Research into 40 Hz sensory stimulation is ongoing. Neural responses do not establish benefits for meditation or cognition, and a browser session does not replicate the devices used in clinical studies.</p>
        <p><a className="text-port-accent underline" href="https://journals.plos.org/plosone/article?id=10.1371/journal.pone.0278412" target="_blank" rel="noreferrer">Research on 40 Hz sensory stimulation</a> · <a className="text-port-accent underline" href="https://epilepsysociety.org.uk/understanding-epilepsy/photosensitive-epilepsy" target="_blank" rel="noreferrer">Photosensitive epilepsy</a> · <a className="text-port-accent underline" href="https://www.w3.org/WAI/WCAG22/Understanding/three-flashes-or-below-threshold.html" target="_blank" rel="noreferrer">W3C flash safety guidance</a></p>
      </div>
    </section>
  );
}
