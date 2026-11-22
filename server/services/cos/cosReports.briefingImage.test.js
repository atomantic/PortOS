import { describe, it, expect, vi, afterAll } from 'vitest';
import { writeFileSync, rmSync } from 'fs';
import { join } from 'path';

// A real reports directory so getBriefing reads an actual briefing file.
const dirs = vi.hoisted(() => {
  const { mkdtempSync } = require('fs');
  const { tmpdir } = require('os');
  const path = require('path');
  return { reports: mkdtempSync(path.join(tmpdir(), 'cos-briefing-image-')) };
});

vi.mock('./cosState.js', () => ({
  loadState: vi.fn(async () => ({ agents: {}, stats: {} })),
  ensureDirectories: vi.fn(async () => {}),
  REPORTS_DIR: dirs.reports,
  isDaemonRunning: () => true
}));

vi.mock('./cosAgentIndex.js', () => ({
  selectArchivedCompletions: vi.fn(async () => []),
  readArchivedAgentMetadata: vi.fn(async () => null)
}));

const { getBriefingImageAttachments } = await import('./cosReports.js');

afterAll(() => rmSync(dirs.reports, { recursive: true, force: true }));

describe('getBriefingImageAttachments (#17398)', () => {
  it('surfaces the briefing\'s generated image as a photo attachment', async () => {
    writeFileSync(join(dirs.reports, '2026-11-20-briefing.md'), [
      '# Daily Briefing',
      '```',
      '/data/images/example-in-code.png',
      '```',
      '## Daily Image',
      '![daily](/data/images/example-daily.png)',
      'Report: /data/cos/reports/extra.pdf'
    ].join('\n'));

    expect(await getBriefingImageAttachments('2026-11-20')).toEqual([
      { path: '/data/images/example-daily.png', kind: 'photo', caption: 'Daily Image — 2026-11-20' }
    ]);
  });

  it('returns no attachment when the briefing has no image or does not exist', async () => {
    writeFileSync(join(dirs.reports, '2026-11-21-briefing.md'), '# Daily Briefing\nNo image today.');
    expect(await getBriefingImageAttachments('2026-11-21')).toEqual([]);
    expect(await getBriefingImageAttachments('2026-11-22')).toEqual([]);
  });
});
