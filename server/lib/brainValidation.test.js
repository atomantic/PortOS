import { describe, it, expect } from 'vitest';
import {
  youtubeIngestSchema,
  destinationEnum,
  manualDestinationEnum,
  classifierOutputSchema,
  projectStatusEnum,
  brainSettingsSchema,
  captureInputSchema,
  resolveReviewInputSchema,
  fixInputSchema,
  inboxQuerySchema,
  entityQuerySchema,
  linkInputSchema,
  linkUpdateInputSchema,
  linkReorderSchema,
  linksQuerySchema,
  bucketInputSchema,
  bucketUpdateInputSchema,
  bucketReorderSchema,
  brainSyncQuerySchema,
  memoryInputSchema,
  songInputSchema,
  songUpdateSchema,
  songInstrumentEnum,
  songContentFormatEnum
} from './brainValidation.js';

describe('brainValidation.js', () => {
  describe('destinationEnum', () => {
    it('should accept valid destinations', () => {
      expect(destinationEnum.safeParse('people').success).toBe(true);
      expect(destinationEnum.safeParse('projects').success).toBe(true);
      expect(destinationEnum.safeParse('ideas').success).toBe(true);
      expect(destinationEnum.safeParse('admin').success).toBe(true);
      expect(destinationEnum.safeParse('unknown').success).toBe(true);
    });

    it('should reject invalid destinations', () => {
      expect(destinationEnum.safeParse('invalid').success).toBe(false);
      expect(destinationEnum.safeParse('').success).toBe(false);
    });

    it('accepts links as a destination (bare-URL captures)', () => {
      expect(destinationEnum.safeParse('links').success).toBe(true);
    });

    it('keeps links out of the hand-filed destinations and the classifier menu', () => {
      expect(manualDestinationEnum.safeParse('links').success).toBe(false);
      expect(classifierOutputSchema.safeParse({
        destination: 'links', confidence: 1, title: 'x', extracted: {}
      }).success).toBe(false);
      expect(resolveReviewInputSchema.safeParse({
        inboxLogId: '11111111-1111-4111-8111-111111111111', destination: 'links'
      }).success).toBe(false);
      expect(fixInputSchema.safeParse({
        inboxLogId: '11111111-1111-4111-8111-111111111111', newDestination: 'links'
      }).success).toBe(false);
    });
  });

  describe('projectStatusEnum', () => {
    it('should accept valid statuses', () => {
      expect(projectStatusEnum.safeParse('active').success).toBe(true);
      expect(projectStatusEnum.safeParse('waiting').success).toBe(true);
      expect(projectStatusEnum.safeParse('blocked').success).toBe(true);
      expect(projectStatusEnum.safeParse('someday').success).toBe(true);
      expect(projectStatusEnum.safeParse('done').success).toBe(true);
    });

    it('should reject invalid statuses', () => {
      expect(projectStatusEnum.safeParse('invalid').success).toBe(false);
    });
  });

  describe('brainSettingsSchema', () => {
    it('should apply defaults', () => {
      const result = brainSettingsSchema.safeParse({});
      expect(result.success).toBe(true);
      expect(result.data.version).toBe(1);
      expect(result.data.confidenceThreshold).toBe(0.6);
      expect(result.data.dailyDigestTime).toBe('00:00');
      expect(result.data.weeklyReviewDay).toBe('sunday');
    });

    it('should validate custom settings', () => {
      const settings = {
        version: 2,
        confidenceThreshold: 0.8,
        dailyDigestTime: '08:30',
        weeklyReviewTime: '17:00',
        weeklyReviewDay: 'friday',
        defaultProvider: 'anthropic',
        defaultModel: 'claude-3'
      };
      const result = brainSettingsSchema.safeParse(settings);
      expect(result.success).toBe(true);
    });

    it('should reject invalid time format', () => {
      const settings = { dailyDigestTime: '9:00' };
      expect(brainSettingsSchema.safeParse(settings).success).toBe(false);
    });

    it('should reject confidenceThreshold outside 0-1', () => {
      expect(brainSettingsSchema.safeParse({ confidenceThreshold: -0.1 }).success).toBe(false);
      expect(brainSettingsSchema.safeParse({ confidenceThreshold: 1.1 }).success).toBe(false);
    });
  });

  describe('captureInputSchema', () => {
    it('should validate capture input', () => {
      const input = { text: 'New thought to capture' };
      const result = captureInputSchema.safeParse(input);
      expect(result.success).toBe(true);
    });

    it('should allow overrides', () => {
      const input = {
        text: 'Capture this',
        providerOverride: 'openai',
        modelOverride: 'gpt-4'
      };
      const result = captureInputSchema.safeParse(input);
      expect(result.success).toBe(true);
    });

    it('should accept an optional note for a URL capture', () => {
      const result = captureInputSchema.safeParse({
        text: 'https://example.com',
        note: 'Read this before the next planning session',
      });
      expect(result.success).toBe(true);
      expect(result.data.note).toBe('Read this before the next planning session');
    });

    it('should allow provider pins inside a repo-study intake', () => {
      const result = captureInputSchema.safeParse({
        text: 'https://github.com/example/repo',
        repoIntake: {
          learn: true,
          providerId: 'codex',
          model: 'gpt-5',
          effort: 'high',
        },
      });
      expect(result.success).toBe(true);
    });

    it('should reject an unknown repo-study effort', () => {
      const result = captureInputSchema.safeParse({
        text: 'https://github.com/example/repo',
        repoIntake: { learn: true, effort: 'unlimited' },
      });
      expect(result.success).toBe(false);
    });

    it('should reject empty text', () => {
      expect(captureInputSchema.safeParse({ text: '' }).success).toBe(false);
    });

    it('should reject text over 10000 characters', () => {
      expect(captureInputSchema.safeParse({ text: 'a'.repeat(10001) }).success).toBe(false);
    });
  });

  describe('inboxQuerySchema', () => {
    it('should apply defaults', () => {
      const result = inboxQuerySchema.safeParse({});
      expect(result.success).toBe(true);
      expect(result.data.limit).toBe(50);
      expect(result.data.offset).toBe(0);
    });

    it('should coerce string numbers', () => {
      const result = inboxQuerySchema.safeParse({ limit: '25', offset: '10' });
      expect(result.success).toBe(true);
      expect(result.data.limit).toBe(25);
      expect(result.data.offset).toBe(10);
    });

    it('should reject limit over 100', () => {
      expect(inboxQuerySchema.safeParse({ limit: 101 }).success).toBe(false);
    });

    it('should reject negative offset', () => {
      expect(inboxQuerySchema.safeParse({ offset: -1 }).success).toBe(false);
    });
  });

  describe('entityQuerySchema', () => {
    it('parses query-string booleans without treating "false" as true', () => {
      expect(entityQuerySchema.parse({ includeArchived: 'true' }).includeArchived).toBe(true);
      expect(entityQuerySchema.parse({ includeArchived: 'false' }).includeArchived).toBe(false);
      expect(entityQuerySchema.parse({}).includeArchived).toBe(false);
    });

    it('rejects an invalid query-string boolean', () => {
      expect(entityQuerySchema.safeParse({ includeArchived: 'yes' }).success).toBe(false);
    });
  });

  describe('linkInputSchema', () => {
    it('should validate minimal input', () => {
      const input = { url: 'https://example.com' };
      const result = linkInputSchema.safeParse(input);
      expect(result.success).toBe(true);
    });

    it('should apply autoClone default', () => {
      const input = { url: 'https://example.com' };
      const result = linkInputSchema.safeParse(input);
      expect(result.success).toBe(true);
      expect(result.data.autoClone).toBe(true);
    });

    it('should accept a note', () => {
      const result = linkInputSchema.safeParse({
        url: 'https://example.com',
        note: 'Save for later reading',
      });
      expect(result.success).toBe(true);
      expect(result.data.note).toBe('Save for later reading');
    });

    it('should reject invalid URL', () => {
      expect(linkInputSchema.safeParse({ url: 'not-valid' }).success).toBe(false);
    });

    it('should accept a bucketId + bucketOrder', () => {
      const result = linkInputSchema.safeParse({
        url: 'https://example.com',
        bucketId: '11111111-1111-4111-8111-111111111111',
        bucketOrder: 3
      });
      expect(result.success).toBe(true);
      expect(result.data.bucketOrder).toBe(3);
    });

    it('should reject a non-uuid bucketId', () => {
      expect(linkInputSchema.safeParse({ url: 'https://example.com', bucketId: 'nope' }).success).toBe(false);
    });
  });

  describe('linkUpdateInputSchema', () => {
    it('should accept a null bucketId (unassign)', () => {
      const result = linkUpdateInputSchema.safeParse({ bucketId: null });
      expect(result.success).toBe(true);
      expect(result.data.bucketId).toBeNull();
    });

    it('should accept a url-only update', () => {
      const result = linkUpdateInputSchema.safeParse({ url: 'https://example.com/new' });
      expect(result.success).toBe(true);
      expect(result.data.url).toBe('https://example.com/new');
    });

    it('should accept a title-only update (url omitted)', () => {
      const result = linkUpdateInputSchema.safeParse({ title: 'New title' });
      expect(result.success).toBe(true);
      expect(result.data.url).toBeUndefined();
    });

    it('should accept a note-only update, including an intentional clear', () => {
      expect(linkUpdateInputSchema.safeParse({ note: '' }).data.note).toBe('');
    });

    it('should reject an invalid url', () => {
      expect(linkUpdateInputSchema.safeParse({ url: 'not-valid' }).success).toBe(false);
    });
  });

  describe('linksQuerySchema', () => {
    it('should apply defaults', () => {
      const result = linksQuerySchema.safeParse({});
      expect(result.success).toBe(true);
      expect(result.data.limit).toBe(50);
      expect(result.data.offset).toBe(0);
    });

    it('should coerce isRepo boolean', () => {
      const result = linksQuerySchema.safeParse({ isRepo: 'true' });
      expect(result.success).toBe(true);
      expect(result.data.isRepo).toBe(true);
    });

    it('should coerce the string "false" to false (not true)', () => {
      const result = linksQuerySchema.safeParse({ isRepo: 'false' });
      expect(result.success).toBe(true);
      expect(result.data.isRepo).toBe(false);
    });

    it('should accept the legacy GitHub-only filter name', () => {
      const result = linksQuerySchema.safeParse({ isGitHubRepo: 'true' });
      expect(result.success).toBe(true);
      expect(result.data.isGitHubRepo).toBe(true);
    });

    it('should filter by linkType', () => {
      const result = linksQuerySchema.safeParse({ linkType: 'documentation' });
      expect(result.success).toBe(true);
      expect(result.data.linkType).toBe('documentation');
    });
  });

  describe('bucketInputSchema', () => {
    it('should accept a minimal name-only bucket', () => {
      expect(bucketInputSchema.safeParse({ name: 'Disney' }).success).toBe(true);
    });

    it('should accept a valid color + icon', () => {
      const result = bucketInputSchema.safeParse({ name: 'Disney', color: 'purple', icon: '🎢' });
      expect(result.success).toBe(true);
    });

    it('should reject an empty name', () => {
      expect(bucketInputSchema.safeParse({ name: '' }).success).toBe(false);
    });

    it('should reject an unknown color', () => {
      expect(bucketInputSchema.safeParse({ name: 'X', color: 'neon' }).success).toBe(false);
    });
  });

  describe('bucketUpdateInputSchema', () => {
    it('should accept a partial update', () => {
      const result = bucketUpdateInputSchema.safeParse({ order: 2 });
      expect(result.success).toBe(true);
      expect(result.data.order).toBe(2);
    });
  });

  describe('bucketReorderSchema', () => {
    it('should accept a list of uuids', () => {
      const result = bucketReorderSchema.safeParse({
        ids: ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222']
      });
      expect(result.success).toBe(true);
    });

    it('should reject an empty list', () => {
      expect(bucketReorderSchema.safeParse({ ids: [] }).success).toBe(false);
    });

    it('should reject non-uuid entries', () => {
      expect(bucketReorderSchema.safeParse({ ids: ['nope'] }).success).toBe(false);
    });
  });

  describe('linkReorderSchema', () => {
    const idA = '11111111-1111-4111-8111-111111111111';
    const idB = '22222222-2222-4222-8222-222222222222';
    const bucket = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

    it('should accept a batch of { id, bucketId, bucketOrder }', () => {
      const result = linkReorderSchema.safeParse({
        updates: [
          { id: idA, bucketId: bucket, bucketOrder: 0 },
          { id: idB, bucketId: bucket, bucketOrder: 1 }
        ]
      });
      expect(result.success).toBe(true);
    });

    it('should accept a null bucketId (ungrouped landing)', () => {
      expect(linkReorderSchema.safeParse({ updates: [{ id: idA, bucketId: null, bucketOrder: 0 }] }).success).toBe(true);
    });

    it('should reject an empty batch', () => {
      expect(linkReorderSchema.safeParse({ updates: [] }).success).toBe(false);
    });

    it('should reject a non-integer bucketOrder', () => {
      expect(linkReorderSchema.safeParse({ updates: [{ id: idA, bucketId: bucket, bucketOrder: 1.5 }] }).success).toBe(false);
    });

    it('should reject a non-uuid id (parity with the link update schema)', () => {
      expect(linkReorderSchema.safeParse({ updates: [{ id: 'l1', bucketId: bucket, bucketOrder: 0 }] }).success).toBe(false);
    });

    it('should reject a non-uuid bucketId', () => {
      expect(linkReorderSchema.safeParse({ updates: [{ id: idA, bucketId: 'b1', bucketOrder: 0 }] }).success).toBe(false);
    });

    it('should reject an entry missing its id', () => {
      expect(linkReorderSchema.safeParse({ updates: [{ bucketId: bucket, bucketOrder: 0 }] }).success).toBe(false);
    });
  });

  describe('brainSyncQuerySchema', () => {
    it('should accept valid query with defaults', () => {
      const result = brainSyncQuerySchema.safeParse({});
      expect(result.success).toBe(true);
      expect(result.data.since).toBe(0);
      expect(result.data.limit).toBe(100);
    });

    it('should coerce string since to number', () => {
      const result = brainSyncQuerySchema.safeParse({ since: '5', limit: '50' });
      expect(result.success).toBe(true);
      expect(result.data.since).toBe(5);
      expect(result.data.limit).toBe(50);
    });

    it('should reject negative since', () => {
      const result = brainSyncQuerySchema.safeParse({ since: -1 });
      expect(result.success).toBe(false);
    });

    it('should reject limit exceeding 1000', () => {
      const result = brainSyncQuerySchema.safeParse({ limit: 1001 });
      expect(result.success).toBe(false);
    });

    it('should reject limit of 0', () => {
      const result = brainSyncQuerySchema.safeParse({ limit: 0 });
      expect(result.success).toBe(false);
    });
  });

  describe('memoryInputSchema', () => {
    it('accepts a minimal hand-written memory', () => {
      expect(memoryInputSchema.safeParse({ title: 'A thought' }).success).toBe(true);
    });

    it('accepts importer provenance fields, including null source clocks', () => {
      const result = memoryInputSchema.safeParse({
        title: 'Imported chat',
        content: 'transcript',
        source: 'chatgpt-import',
        sourceRef: 'conv-1.json',
        sourceCreatedAt: '2024-07-14T18:16:33.622Z',
        sourceUpdatedAt: null
      });
      expect(result.success).toBe(true);
    });

    it('rejects a non-ISO source timestamp', () => {
      const result = memoryInputSchema.safeParse({ title: 'x', sourceCreatedAt: 'last week' });
      expect(result.success).toBe(false);
    });
  });

  describe('songbook enums', () => {
    // The client mirrors both lists in client/src/components/songbook/constants.js
    // (INSTRUMENTS / SONG_FORMATS) — keep them in lockstep.
    it('accepts every shipped instrument, including drums (#3115)', () => {
      for (const instrument of ['guitar', 'piano', 'ukulele', 'bass', 'voice', 'drums', 'other']) {
        expect(songInstrumentEnum.safeParse(instrument).success, instrument).toBe(true);
      }
      expect(songInstrumentEnum.safeParse('hurdy-gurdy').success).toBe(false);
    });

    it('accepts every shipped content format, including drum (#3115)', () => {
      for (const format of ['chordpro', 'tab', 'plain', 'drum']) {
        expect(songContentFormatEnum.safeParse(format).success, format).toBe(true);
      }
      expect(songContentFormatEnum.safeParse('futureformat').success).toBe(false);
    });

    it('round-trips a drum song through songInputSchema', () => {
      const result = songInputSchema.safeParse({
        title: 'Example Rock Beat',
        artist: 'The Placeholders',
        instrument: 'drums',
        content: { format: 'drum', text: 'HH: xxxx\nK: o---' },
      });
      expect(result.success).toBe(true);
      expect(result.data.instrument).toBe('drums');
      expect(result.data.content.format).toBe('drum');
    });

    it('still defaults to guitar/tab when neither is supplied', () => {
      const result = songInputSchema.safeParse({ title: 'Untitled' });
      expect(result.success).toBe(true);
      expect(result.data.instrument).toBe('guitar');
      expect(result.data.content).toEqual({ format: 'tab', text: '' });
    });

    // Brain songs sync raw between installs on independent upgrade schedules
    // (LWW, no Zod on receive), so a newer peer's instrument/format can already be
    // sitting in a local record. A write that rejected it would make that song
    // permanently uneditable — every save 400ing on a field the user never
    // touched — so the WRITE boundary is deliberately wider than the enum.
    it('accepts (round-trips) an unknown instrument/format from a newer peer', () => {
      const result = songInputSchema.safeParse({
        title: 'Synced Song',
        instrument: 'hurdy-gurdy',
        content: { format: 'futureformat', text: 'x' },
      });
      expect(result.success).toBe(true);
      expect(result.data.instrument).toBe('hurdy-gurdy');
      expect(result.data.content.format).toBe('futureformat');
    });

    it('keeps the forward-compat slot a SLUG, not free text', () => {
      for (const bad of ['Has Spaces', 'UPPER', 'x'.repeat(33), '', '-leading', 'sym!bol']) {
        const result = songInputSchema.safeParse({ title: 'T', instrument: bad });
        expect(result.success, `instrument "${bad}"`).toBe(false);
      }
    });
  });

  // The "fit to duration" autoscroll target (#4100) — the play view derives px/s
  // from it against the rendered scroll height.
  describe('songbook scrollDurationSec (#4100)', () => {
    it('accepts a whole-second target and lands it on the record', () => {
      const result = songInputSchema.safeParse({ title: 'T', scrollDurationSec: 210 });
      expect(result.success).toBe(true);
      expect(result.data.scrollDurationSec).toBe(210);
    });

    it('defaults to null (no target) when the key is absent on create', () => {
      const result = songInputSchema.safeParse({ title: 'T' });
      expect(result.success).toBe(true);
      expect(result.data).toHaveProperty('scrollDurationSec');
      expect(result.data.scrollDurationSec).toBe(null);
    });

    it('rejects out-of-bounds and non-integer targets', () => {
      for (const bad of [14, 3601, 0, -30, 90.5, '210', true]) {
        const result = songInputSchema.safeParse({ title: 'T', scrollDurationSec: bad });
        expect(result.success, `scrollDurationSec ${String(bad)}`).toBe(false);
      }
      // The bounds themselves are inclusive.
      for (const ok of [15, 3600]) {
        expect(songInputSchema.safeParse({ title: 'T', scrollDurationSec: ok }).success, String(ok)).toBe(true);
      }
    });

    // Absent vs. intentionally-empty: an omitted key must stay omitted so the
    // PATCH merge preserves a stored target, while an explicit null must survive
    // as null so clearing the input actually clears the record.
    it('separates "not sent" from an explicit null on update', () => {
      const untouched = songUpdateSchema.safeParse({ title: 'T' });
      expect(untouched.success).toBe(true);
      expect('scrollDurationSec' in untouched.data).toBe(false);

      const cleared = songUpdateSchema.safeParse({ scrollDurationSec: null });
      expect(cleared.success).toBe(true);
      expect(cleared.data.scrollDurationSec).toBe(null);

      const set = songUpdateSchema.safeParse({ scrollDurationSec: 90 });
      expect(set.success).toBe(true);
      expect(set.data.scrollDurationSec).toBe(90);
    });

    it('keeps the bounds on the update schema too', () => {
      expect(songUpdateSchema.safeParse({ scrollDurationSec: 5 }).success).toBe(false);
      expect(songUpdateSchema.safeParse({ scrollDurationSec: 7200 }).success).toBe(false);
    });
  });

  // Cross-links to the other music record kinds — Rounds and music Tracks (#4103).
  describe('songbook links (#4103)', () => {
    it('accepts links to a round and a track, defaulting the label', () => {
      const result = songInputSchema.safeParse({
        title: 'T',
        links: [
          { type: 'round', id: 'round-1', label: 'Example Round' },
          { type: 'track', id: 'track-1' },
        ],
      });
      expect(result.success).toBe(true);
      expect(result.data.links).toEqual([
        { type: 'round', id: 'round-1', label: 'Example Round' },
        { type: 'track', id: 'track-1', label: '' },
      ]);
    });

    it('defaults to an empty list when the key is absent on create', () => {
      const result = songInputSchema.safeParse({ title: 'T' });
      expect(result.success).toBe(true);
      expect(result.data.links).toEqual([]);
    });

    it('rejects malformed entries and an over-long list', () => {
      const bad = [
        [{ id: 'round-1' }],                       // no type
        [{ type: 'round' }],                       // no id
        [{ type: 'round', id: '' }],               // empty id
        [{ type: 'Round', id: 'round-1' }],        // uppercase — not a valid slug
        [{ type: 'round', id: 'round-1', label: 'x'.repeat(301) }],
        ['round-1'],                               // not an object
      ];
      for (const links of bad) {
        expect(songInputSchema.safeParse({ title: 'T', links }).success, JSON.stringify(links)).toBe(false);
      }
      const tooMany = Array.from({ length: 21 }, (_, i) => ({ type: 'round', id: `round-${i}` }));
      expect(songInputSchema.safeParse({ title: 'T', links: tooMany }).success).toBe(false);
    });

    // Same forward-compat contract as instrument/content.format: a song synced
    // from a NEWER peer can carry a link type this install doesn't know, and
    // rejecting it would make the song uneditable.
    it('accepts an unknown short-slug link type from a newer peer', () => {
      const result = songInputSchema.safeParse({
        title: 'T',
        links: [{ type: 'stem-pack', id: 'x1' }],
      });
      expect(result.success).toBe(true);
      expect(result.data.links[0].type).toBe('stem-pack');
      // …but not free text.
      expect(songInputSchema.safeParse({
        title: 'T',
        links: [{ type: 'a totally free form value', id: 'x1' }],
      }).success).toBe(false);
    });

    // Absent vs. intentionally-empty: an omitted key preserves the stored links
    // through the PATCH merge, while an explicit [] clears them.
    it('separates "not sent" from an explicit empty list on update', () => {
      const untouched = songUpdateSchema.safeParse({ title: 'T' });
      expect(untouched.success).toBe(true);
      expect('links' in untouched.data).toBe(false);

      const cleared = songUpdateSchema.safeParse({ links: [] });
      expect(cleared.success).toBe(true);
      expect(cleared.data.links).toEqual([]);
    });
  });
});

describe('YouTube analysis request contract', () => {
  it('preserves app and execution pins while accepting legacy capture requests', () => {
    const url = 'https://youtu.be/oCnxnaVg0bY';
    expect(youtubeIngestSchema.parse({ url })).toEqual({ url });
    const request = { url, targetAppId: 'example', providerId: 'codex', model: 'example-model', effort: 'high', workMode: 'implement' };
    expect(youtubeIngestSchema.parse(request)).toEqual(request);
    expect(youtubeIngestSchema.safeParse({ url, workMode: 'unknown' }).success).toBe(false);
    expect(youtubeIngestSchema.safeParse({ url, effort: 'unknown' }).success).toBe(false);
  });
});
