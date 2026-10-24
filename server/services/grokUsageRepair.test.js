import { describe, expect, it } from 'vitest';
import {
  galleryImageUsageEvent,
  grokTurnRepairId,
  imagineEventsFromGrokSession,
  planGrokUsageRepair,
  summarizeGrokRepairAdditions,
  videoHistoryUsageEvents,
} from './grokUsageRepair.js';

const LONG_TURN = {
  sessionId: 'sess-1',
  key: 'prompt-long',
  ms: 1_700_000_000_000,
  model: 'grok-4.7',
  promptTokens: 250_000,
  tokensIn: 200_000,
  tokensOut: 1_000,
  cacheReadTokens: 50_000,
  cacheWriteTokens: 0,
};

describe('planGrokUsageRepair', () => {
  it('adds the long-context premium once, and only for turns the scan already passed', () => {
    const first = planGrokUsageRepair({
      turns: [LONG_TURN, { ...LONG_TURN, key: 'later', ms: 1_800_000_000_000 }],
      watermarkMs: 1_750_000_000_000,
      providerId: 'grok-cli',
    });
    expect(first.additions).toHaveLength(1);
    expect(first.additions[0].repairId).toBe(grokTurnRepairId('sess-1', 'prompt-long'));
    expect(first.additions[0].record.tokensIn).toBeUndefined();
    expect(first.additions[0].record.longTokensIn).toBe(200_000);
    const again = planGrokUsageRepair({
      turns: [LONG_TURN],
      repairIds: first.additions.map((item) => item.repairId),
      watermarkMs: 1_750_000_000_000,
    });
    expect(again.additions).toEqual([]);
  });

  it('skips long-context premiums when the scan has never written a watermark, and still adds media', () => {
    const plan = planGrokUsageRepair({
      turns: [LONG_TURN],
      media: [{ id: 'gallery:job-1', day: '2026-10-01', model: 'grok-imagine-image-2.0', images: 1, source: 'measured' }],
      watermarkMs: null,
    });
    expect(plan.additions.map((item) => item.repairId)).toEqual(['gallery:job-1']);
    expect(plan.notes[0]).toMatch(/no Grok usage scan has run yet/);
    expect(summarizeGrokRepairAdditions(plan.additions)).toEqual({ added: 1, turns: 0, images: 1, videos: 0 });
  });

  it('skips a turn with no timestamp', () => {
    const plan = planGrokUsageRepair({
      turns: [{ ...LONG_TURN, ms: null }],
      watermarkMs: 1_800_000_000_000,
    });
    expect(plan.additions).toEqual([]);
  });
});

describe('Grok media recovery', () => {
  it('reads a gallery sidecar and a text-to-video history row', () => {
    expect(galleryImageUsageEvent({
      id: 'job-9', mode: 'grok', createdAt: '2026-10-02T03:04:05.000Z',
      initImageFilename: 'source.png', referenceImageFilenames: ['a.png'],
    })).toMatchObject({ id: 'gallery:job-9', day: '2026-10-02', images: 1, inputImages: 2 });
    expect(galleryImageUsageEvent({ id: 'local', mode: 'local', createdAt: '2026-10-02T00:00:00.000Z' })).toBeNull();
    const video = videoHistoryUsageEvents({
      id: 'clip-1', modelId: 'grok', mode: 'text', duration: 6, createdAt: '2026-10-03T00:00:00.000Z',
    });
    expect(video.map((event) => event.id)).toEqual(['video:clip-1', 'video-base:clip-1']);
    expect(video[0].videoSeconds).toBe(6);
  });

  it('ignores Imagine tool calls inside a PortOS scratch directory and defaults a missing duration', () => {
    const chat = JSON.stringify({
      type: 'assistant',
      tool_calls: [{ name: 'image_to_video', arguments: '{"prompt":"a fox"}' }],
    });
    expect(imagineEventsFromGrokSession({
      chatText: chat, sessionId: 's', cwd: '/tmp/portos-grok-abc', day: '2026-10-01',
    })).toEqual([]);
    const events = imagineEventsFromGrokSession({
      chatText: chat, sessionId: 's', cwd: '/home/example/notes', day: '2026-10-01',
    });
    expect(events).toEqual([expect.objectContaining({
      id: 'session-video:s:0', videoSeconds: 6, inputImages: 1, images: 0, source: 'estimate',
    })]);
  });
});
