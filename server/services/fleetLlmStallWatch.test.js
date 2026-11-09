import { describe, expect, it } from 'vitest';
import { createStallDetector, readVllmProgress } from './fleetLlmStallWatch.js';

const read = (text) => readVllmProgress({ upstream: 'http://x', apiKey: 'k', fetchImpl: async () => new Response(text) });

describe('readVllmProgress', () => {
  it('sums label sets and ignores comments and unrelated series', async () => {
    const text = [
      '# HELP vllm:num_requests_running running',
      'vllm:num_requests_running{engine="0"} 1.0',
      'vllm:prompt_tokens_total{engine="0",model_name="m"} 100.0',
      'vllm:generation_tokens_total{engine="0",model_name="m"} 20.0',
      'vllm:generation_tokens_total{engine="1",model_name="m"} 5.0',
      'vllm:request_success_total{engine="0"} 99.0',
    ].join('\n');
    expect(await read(text)).toEqual({ running: 1, tokens: 125 });
  });

  it('returns null for text that is not a vLLM exposition, or an unreachable runtime', async () => {
    expect(await read('<html>nope</html>')).toBeNull();
    expect(await readVllmProgress({ upstream: 'http://x', apiKey: 'k', fetchImpl: async () => { throw new Error('down'); } })).toBeNull();
  });
});

describe('createStallDetector', () => {
  it('stays stalled across a drained job and clears only when the runtime restarts', () => {
    let t = 0;
    const detector = createStallDetector({ stalledAfterMs: 100, now: () => t });
    const job = {};
    const wedged = { running: 1, tokens: 50 };
    expect(detector.sample(wedged, job)).toBeNull();
    t = 100;
    expect(detector.sample(wedged, job)).toBe('stalled');
    detector.idle();
    expect(detector.sample(wedged, null)).toBeNull();
    expect(detector.stalledSince()).toBe(100);
    expect(detector.sample(null, null)).toBeNull();
    expect(detector.sample({ running: 0, tokens: 0 }, null)).toBe('cleared');
    expect(detector.stalledSince()).toBeNull();
  });
});
