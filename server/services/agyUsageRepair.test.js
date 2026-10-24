import { describe, expect, it } from 'vitest';
import {
  galleryAgyImageUsageEvent,
  imagineEventsFromAgyTranscript,
  planAgyUsageRepair,
  summarizeAgyRepairAdditions,
} from './agyUsageRepair.js';

describe('galleryAgyImageUsageEvent', () => {
  it('returns a formatted event for valid agy gallery metadata', () => {
    const meta = {
      id: 'job-123',
      mode: 'agy',
      createdAt: '2026-10-10T15:30:00.000Z',
      imageModel: 'imagen-3.0-generate-002',
      initImageFilename: 'init.png',
      referenceImageFilenames: ['ref1.png', 'ref2.png'],
    };

    const event = galleryAgyImageUsageEvent(meta);
    expect(event).toEqual({
      id: 'gallery:job-123',
      day: '2026-10-10',
      model: 'imagen-3.0-generate-002',
      images: 1,
      inputImages: 3,
      videoSeconds: 0,
      source: 'measured',
    });
  });

  it('returns null for non-agy modes, missing id, or invalid date', () => {
    expect(galleryAgyImageUsageEvent({ id: 'job-1', mode: 'grok', createdAt: '2026-10-10T00:00:00.000Z' })).toBeNull();
    expect(galleryAgyImageUsageEvent({ mode: 'agy', createdAt: '2026-10-10T00:00:00.000Z' })).toBeNull();
    expect(galleryAgyImageUsageEvent({ id: 'job-1', mode: 'agy', createdAt: 'invalid-date' })).toBeNull();
  });
});

describe('imagineEventsFromAgyTranscript', () => {
  it('ignores tool calls when running in a portos-agy-scratch directory', () => {
    const transcriptText = JSON.stringify({
      type: 'PLANNER_RESPONSE',
      created_at: '2026-10-10T12:00:00.000Z',
      tool_calls: [{ name: 'generate_image', args: { prompt: 'a cute cat' } }],
    });

    const events = imagineEventsFromAgyTranscript({
      transcriptText,
      sessionId: 'sess-1',
      cwd: '/tmp/portos-agy-scratch-xyz',
    });
    expect(events).toEqual([]);
  });

  it('extracts generate_image tool calls from outside scratch directories', () => {
    const transcriptText = [
      JSON.stringify({
        type: 'PLANNER_RESPONSE',
        created_at: '2026-10-10T12:00:00.000Z',
        tool_calls: [
          { name: 'generate_image', args: { prompt: 'a dog', imagePaths: ['img1.png', 'img2.png'] } },
          { name: 'other_tool', args: {} },
        ],
      }),
      JSON.stringify({
        type: 'PLANNER_RESPONSE',
        created_at: '2026-10-10T12:05:00.000Z',
        tool_calls: [
          { name: 'generate_image', args: { prompt: 'another dog' } },
        ],
      }),
    ].join('\n');

    const events = imagineEventsFromAgyTranscript({
      transcriptText,
      sessionId: 'sess-2',
      cwd: '/Users/test/projects/my-app',
    });

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      id: 'session-image:sess-2:0',
      day: '2026-10-10',
      images: 1,
      inputImages: 2,
      source: 'measured',
    });
    expect(events[1]).toMatchObject({
      id: 'session-image:sess-2:1',
      day: '2026-10-10',
      images: 1,
      inputImages: 0,
      source: 'measured',
    });
  });
});

describe('planAgyUsageRepair', () => {
  it('plans additions for unrecorded media events and skips existing repairIds', () => {
    const media = [
      { id: 'gallery:job-1', day: '2026-10-10', images: 1, inputImages: 0 },
      { id: 'gallery:job-2', day: '2026-10-11', images: 1, inputImages: 1 },
      { id: 'gallery:job-1', day: '2026-10-10', images: 1, inputImages: 0 }, // duplicate in list
    ];

    const plan = planAgyUsageRepair({
      media,
      repairIds: ['gallery:job-2'],
      providerId: 'antigravity-cli',
    });

    expect(plan.additions).toHaveLength(1);
    expect(plan.additions[0]).toEqual({
      repairId: 'gallery:job-1',
      day: '2026-10-10',
      record: {
        providerId: 'antigravity-cli',
        model: 'imagen-3.0-generate-002',
        messages: 0,
        images: 1,
        videoSeconds: 0,
        inputImages: 0,
        source: 'measured',
      },
    });

    const summary = summarizeAgyRepairAdditions(plan.additions);
    expect(summary).toEqual({ added: 1, images: 1 });
  });
});
