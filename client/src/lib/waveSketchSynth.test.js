import { describe, it, expect, vi, afterEach } from 'vitest';
import { createSketchSynthesizer } from './waveSketchSynth.js';
import { renderSketchPreview } from './waveSketchSynthWorker.js';
import { pcmPeaks, synthesizeSketchChannels } from '../../../server/lib/waveSketch.js';

const painting = {
  version: 2,
  title: 'Test',
  durationSec: 0.5,
  sections: [{ start: 0, end: 0.5 }],
  strokes: [
    { name: 'line', overtones: [0.4], pan: 0.3, path: [{ t: 0, hz: 440, a: 0.6 }, { t: 0.5, hz: 660, a: 0.4 }] },
    { name: 'air', width: 1200, pan: -0.5, path: [{ t: 0.1, hz: 5000, a: 0.2 }, { t: 0.5, hz: 4000, a: 0 }] },
  ],
};

// A worker double: records what it was sent and lets the test answer later.
function fakeWorkerFactory() {
  const workers = [];
  const createWorker = () => {
    const worker = { messages: [], terminated: false, onmessage: null, onerror: null };
    worker.postMessage = (msg) => worker.messages.push(msg);
    worker.terminate = () => { worker.terminated = true; };
    worker.reply = (data) => worker.onmessage?.({ data });
    workers.push(worker);
    return worker;
  };
  return { workers, createWorker };
}

describe('waveSketchSynth', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('renders the preview sample-identical to the main-thread synth, with the old mono-mix peaks', () => {
    const { channels, peaks } = renderSketchPreview(painting, 50);
    const direct = synthesizeSketchChannels(painting);
    expect(channels).toHaveLength(2);
    channels.forEach((channel, c) => {
      expect(Buffer.from(channel.buffer).equals(Buffer.from(direct[c].buffer))).toBe(true);
    });
    expect(peaks).toEqual(pcmPeaks(direct[0].map((v, i) => (v + direct[1][i]) / 2), 50));
  });

  it('resolves only the latest render and terminates the worker still grinding on a stale one', async () => {
    const { workers, createWorker } = fakeWorkerFactory();
    const synth = createSketchSynthesizer({ createWorker });
    const first = synth.synthesize({ id: 'a' }, 10);
    const second = synth.synthesize({ id: 'b' }, 10);
    await expect(first).resolves.toBeNull();
    expect(workers[0].terminated).toBe(true);
    // A late reply from the terminated worker is ignored.
    workers[0].reply({ id: workers[0].messages[0].id, channels: ['stale'], peaks: [] });

    workers[1].reply({ id: workers[1].messages[0].id, channels: ['fresh'], peaks: [[0, 1]] });
    await expect(second).resolves.toEqual({ channels: ['fresh'], peaks: [[0, 1]] });
  });

  it('surfaces a render error, and falls back to the main thread when the worker fails to load', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { workers, createWorker } = fakeWorkerFactory();
    const synth = createSketchSynthesizer({ createWorker });
    const failing = synth.synthesize(painting, 10);
    workers[0].reply({ id: workers[0].messages[0].id, error: 'bad sketch' });
    await expect(failing).rejects.toThrow('bad sketch');

    const pending = synth.synthesize(painting, 10);
    workers[0].onerror({ message: 'module load failed', preventDefault: () => {} });
    const { channels } = await pending;
    expect(Buffer.from(channels[0].buffer).equals(Buffer.from(synthesizeSketchChannels(painting)[0].buffer))).toBe(true);
    expect(workers[0].terminated).toBe(true);
  });
});
