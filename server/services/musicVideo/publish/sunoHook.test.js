import { describe, it, expect } from 'vitest';
import { pickSongRow } from '../../../lib/sunoSongPicker.js';
import { buildPublishPayload } from './payloads.js';
import { captureMusicVideoEvidence } from '../../../lib/musicVideoDependencies.js';

const ID = '12345678-abcd-4abc-8abc-123456789abc';
const project = (extra = {}) => {
  const base = {
    name: 'Night Drive', scenes: [], renderHistoryId: 'r1', audioAnalysis: { durationSec: 187 },
    publishKit: { links: { song: `https://suno.com/song/${ID}` }, copy: { tiktok: { caption: 'Hook caption' } } },
  };
  const excerpts = [{ id: 'e1', status: 'complete', aspect: '9:16', filename: 'cut.mp4', startSec: 42, endSec: 62, dependencies: captureMusicVideoEvidence(base, { startSec: 42, endSec: 62 }) }];
  return { ...base, excerpts, ...extra };
};

describe('Suno Hook payload', () => {
  it('sets the window to the cut start and keeps the song id, title, length and caption', () => {
    const p = buildPublishPayload('sunoHook', project());
    expect(p).toMatchObject({ songId: ID, title: 'Night Drive', durationSec: 187, startSec: 42, caption: 'Hook caption', showLyrics: false, video: { dir: 'videos', name: 'cut.mp4' } });
  });
  it('refuses a missing song URL and a project with no vertical cut', () => {
    expect(() => buildPublishPayload('sunoHook', project({ publishKit: {} }))).toThrow(/Suno song URL/);
    expect(() => buildPublishPayload('sunoHook', project({ excerpts: [] }))).toThrow(/9:16/);
  });
});

describe('pickSongRow', () => {
  const row = (text, html = '') => ({ text, html });
  it('prefers an id match, then the same length, and refuses an ambiguous pick', () => {
    const rows = [row('Night Drive 2:10 synthwave'), row('Night Drive 3:07 synthwave', `<a href="/song/${ID}">`)];
    expect(pickSongRow(rows, { songId: ID, title: 'Night Drive', durationSec: 130 })).toBe(1);
    const noIds = [row('Night Drive 2:10'), row('Night Drive 3:07')];
    expect(pickSongRow(noIds, { songId: ID, title: 'Night Drive', durationSec: 187 })).toBe(1);
    expect(pickSongRow(noIds, { songId: ID, title: 'Night Drive', durationSec: null })).toBe(-1);
    expect(pickSongRow([row('Night Drive 2:10')], { songId: ID, title: 'Night Drive' })).toBe(0);
  });
});
