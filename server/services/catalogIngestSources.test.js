/**
 * Unit tests for catalogIngestSources — the url / file / voice ingest paths.
 * Every external boundary is mocked (browser CDP, Whisper, DB, extraction,
 * disk) so the test stays pure. Asserts:
 *   - URL ingest fetches main text, creates a 'url' scrap with url metadata,
 *     and runs the extraction pipeline.
 *   - File ingest records filename/mime on a 'file' scrap.
 *   - Voice ingest transcribes, persists audio to mint a media_key, and stamps
 *     it onto a 'voice-memo' scrap; an empty transcript / empty audio throws
 *     BEFORE any scrap or audio file is written.
 *   - fetchUrlMainText throws when the page yields no readable text.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./catalogDB.js', () => ({
  createScrap: vi.fn(),
  createChunkedScrap: vi.fn(),
}));
vi.mock('./catalogExtraction.js', () => ({
  extractIngredients: vi.fn(),
  extractIngredientsForScrap: vi.fn(),
}));
vi.mock('./voice/stt.js', () => ({
  transcribe: vi.fn(),
}));
vi.mock('./browserService.js', () => ({
  navigateToUrl: vi.fn(),
  listCdpPages: vi.fn(),
  evaluateOnPage: vi.fn(),
}));
vi.mock('fs/promises', () => ({
  writeFile: vi.fn(),
}));
vi.mock('dns/promises', () => ({
  lookup: vi.fn(),
}));
vi.mock('../lib/fileUtils.js', () => ({
  PATHS: { audio: '/tmp/data/audio' },
  ensureDir: vi.fn(),
}));

const catalogDB = await import('./catalogDB.js');
const catalogExtraction = await import('./catalogExtraction.js');
const browserService = await import('./browserService.js');
const fsp = await import('fs/promises');
const dnsp = await import('dns/promises');
const {
  fetchUrlMainText,
  ingestFromUrl,
  ingestFromFile,
  ingestFromVoice,
} = await import('./catalogIngestSources.js');

const DRAFT = { runId: 'r1', characters: [], stages: [] };

beforeEach(() => {
  vi.clearAllMocks();
  catalogExtraction.extractIngredientsForScrap.mockResolvedValue(DRAFT);
  catalogDB.createChunkedScrap.mockImplementation(async (args) => ({ id: 'cat-scrap-1', ...args }));
  // Hostnames resolve to a safe public address by default (the DNS SSRF guard).
  dnsp.lookup.mockResolvedValue({ address: '93.184.216.34', family: 4 });
});

describe('fetchUrlMainText', () => {
  it('navigates + reads main text, returning title + text + finalUrl', async () => {
    browserService.navigateToUrl.mockResolvedValue({ id: 'p1', url: 'https://ex.com/a' });
    browserService.listCdpPages.mockResolvedValue([
      { id: 'p1', url: 'https://ex.com/a', title: 'A', webSocketDebuggerUrl: 'ws://x' },
    ]);
    browserService.evaluateOnPage.mockResolvedValue(JSON.stringify({ title: 'Article A', text: 'Body text here.' }));

    const out = await fetchUrlMainText('https://ex.com/a', { settleMs: 0 });
    expect(out).toEqual({ text: 'Body text here.', title: 'Article A', finalUrl: 'https://ex.com/a' });
    expect(browserService.navigateToUrl).toHaveBeenCalledWith('https://ex.com/a');
  });

  it('throws when the page extracts no readable text', async () => {
    browserService.navigateToUrl.mockResolvedValue({ id: 'p1', url: 'https://ex.com/a' });
    browserService.listCdpPages.mockResolvedValue([{ id: 'p1', url: 'https://ex.com/a', title: '', webSocketDebuggerUrl: 'ws://x' }]);
    browserService.evaluateOnPage.mockResolvedValue(JSON.stringify({ title: '', text: '   ' }));

    await expect(fetchUrlMainText('https://ex.com/a', { settleMs: 0 })).rejects.toThrow(/no readable text/);
    expect(catalogDB.createChunkedScrap).not.toHaveBeenCalled();
  });

  it('refuses to ingest a hostname that resolves to a blocked address (DNS SSRF) before navigating', async () => {
    // Schema passes (it's a normal hostname), but DNS points it at cloud metadata.
    dnsp.lookup.mockResolvedValue({ address: '169.254.169.254', family: 4 });
    await expect(fetchUrlMainText('https://evil.example/x', { settleMs: 0 })).rejects.toThrow(/resolves to a blocked/);
    expect(browserService.navigateToUrl).not.toHaveBeenCalled();
  });

  it('refuses to ingest a redirect that lands on a blocked (loopback) host', async () => {
    browserService.navigateToUrl.mockResolvedValue({ id: 'p1', url: 'https://ex.com/a' });
    // The first-hop URL passed the schema guard, but Chrome followed a redirect
    // to a loopback target — the landed page.url is what we must re-check.
    browserService.listCdpPages.mockResolvedValue([{ id: 'p1', url: 'http://127.0.0.1:5555/secret', title: 'x', webSocketDebuggerUrl: 'ws://x' }]);
    await expect(fetchUrlMainText('https://ex.com/a', { settleMs: 0 })).rejects.toThrow(/loopback|link-local/);
    expect(browserService.evaluateOnPage).not.toHaveBeenCalled();
  });

  it('refuses a redirect to a HOSTNAME that resolves to a blocked address (DNS re-check on landed url)', async () => {
    // First hop resolves safe; the landed redirect host resolves to metadata.
    dnsp.lookup
      .mockResolvedValueOnce({ address: '93.184.216.34', family: 4 })
      .mockResolvedValueOnce({ address: '169.254.169.254', family: 4 });
    browserService.navigateToUrl.mockResolvedValue({ id: 'p1', url: 'https://ex.com/a' });
    browserService.listCdpPages.mockResolvedValue([{ id: 'p1', url: 'https://evil.example/x', title: 'x', webSocketDebuggerUrl: 'ws://x' }]);
    await expect(fetchUrlMainText('https://ex.com/a', { settleMs: 0 })).rejects.toThrow(/resolves to a blocked/);
    expect(browserService.evaluateOnPage).not.toHaveBeenCalled();
  });

  it('clamps an oversized page body to the raw-text cap (2M chars)', async () => {
    browserService.navigateToUrl.mockResolvedValue({ id: 'p1', url: 'https://ex.com/a' });
    browserService.listCdpPages.mockResolvedValue([{ id: 'p1', url: 'https://ex.com/a', title: 'Big', webSocketDebuggerUrl: 'ws://x' }]);
    const huge = 'x'.repeat(2_500_000);
    browserService.evaluateOnPage.mockResolvedValue(JSON.stringify({ title: 'Big', text: huge }));
    const out = await fetchUrlMainText('https://ex.com/a', { settleMs: 0 });
    expect(out.text.length).toBe(2_000_000);
  });
});

describe('ingestFromUrl', () => {
  it('creates a url scrap with url metadata and runs extraction', async () => {
    browserService.navigateToUrl.mockResolvedValue({ id: 'p1', url: 'https://ex.com/a' });
    browserService.listCdpPages.mockResolvedValue([{ id: 'p1', url: 'https://ex.com/a', title: 'A', webSocketDebuggerUrl: 'ws://x' }]);
    browserService.evaluateOnPage.mockResolvedValue(JSON.stringify({ title: 'Article A', text: 'Body.' }));

    const { scrap, draft } = await ingestFromUrl({ url: 'https://ex.com/a', settleMs: 0 });
    expect(draft).toBe(DRAFT);
    const createArgs = catalogDB.createChunkedScrap.mock.calls[0][0];
    expect(createArgs.sourceKind).toBe('url');
    expect(createArgs.rawText).toBe('Body.');
    expect(createArgs.metadata).toEqual({ url: 'https://ex.com/a', title: 'Article A' });
    expect(catalogExtraction.extractIngredientsForScrap).toHaveBeenCalledWith(
      expect.objectContaining({ scrapId: scrap.id }),
    );
  });
});

describe('ingestFromFile', () => {
  it('records filename + mime on a file scrap', async () => {
    const { draft } = await ingestFromFile({ text: 'Notes body', filename: 'notes.md', mime: 'text/markdown' });
    expect(draft).toBe(DRAFT);
    const createArgs = catalogDB.createChunkedScrap.mock.calls[0][0];
    expect(createArgs.sourceKind).toBe('file');
    expect(createArgs.title).toBe('notes.md');
    expect(createArgs.metadata).toEqual({ filename: 'notes.md', mime: 'text/markdown' });
  });

  it('throws on empty file text before creating a scrap', async () => {
    await expect(ingestFromFile({ text: '   ', filename: 'empty.txt' })).rejects.toThrow(/no extractable text/);
    expect(catalogDB.createChunkedScrap).not.toHaveBeenCalled();
  });
});

describe('ingestFromVoice', () => {
  const wavBase64 = Buffer.from('fake-wav-bytes').toString('base64');

  it('transcribes, persists audio to mint a media_key, and stamps it on the scrap', async () => {
    const transcribeFn = vi.fn().mockResolvedValue({ text: 'spoken memo text' });
    const persistFn = vi.fn().mockResolvedValue('voice-memo-abc.wav');

    const { scrap, draft, mediaKey } = await ingestFromVoice(
      { audioBase64: wavBase64, mimeType: 'audio/wav', title: 'My memo' },
      { transcribeFn, persistFn },
    );

    expect(transcribeFn).toHaveBeenCalledWith(expect.any(Buffer), { mimeType: 'audio/wav' });
    expect(persistFn).toHaveBeenCalledTimes(1);
    expect(mediaKey).toBe('voice-memo-abc.wav');
    expect(draft).toBe(DRAFT);
    const createArgs = catalogDB.createChunkedScrap.mock.calls[0][0];
    expect(createArgs.sourceKind).toBe('voice-memo');
    expect(createArgs.rawText).toBe('spoken memo text');
    expect(createArgs.metadata).toEqual({ mediaKey: 'voice-memo-abc.wav', mimeType: 'audio/wav' });
    expect(createArgs.title).toBe('My memo');
  });

  it('throws on an empty transcript and never persists audio or creates a scrap', async () => {
    const transcribeFn = vi.fn().mockResolvedValue({ text: '   ' });
    const persistFn = vi.fn();
    await expect(
      ingestFromVoice({ audioBase64: wavBase64 }, { transcribeFn, persistFn }),
    ).rejects.toThrow(/empty transcript/);
    expect(persistFn).not.toHaveBeenCalled();
    expect(catalogDB.createChunkedScrap).not.toHaveBeenCalled();
  });

  it('throws on empty audio before transcription', async () => {
    const transcribeFn = vi.fn();
    await expect(
      ingestFromVoice({ audioBase64: '' }, { transcribeFn }),
    ).rejects.toThrow(/audio was empty/);
    expect(transcribeFn).not.toHaveBeenCalled();
  });

  it('defaults the audio persister to write under PATHS.audio with a wav extension', async () => {
    const transcribeFn = vi.fn().mockResolvedValue({ text: 'hi' });
    const { mediaKey } = await ingestFromVoice({ audioBase64: wavBase64 }, { transcribeFn });
    // Real persistFn ran: it called writeFile under the mocked PATHS.audio.
    expect(fsp.writeFile).toHaveBeenCalledTimes(1);
    expect(mediaKey).toMatch(/^voice-memo-.*\.wav$/);
    const writtenPath = fsp.writeFile.mock.calls[0][0];
    expect(writtenPath).toContain('/tmp/data/audio');
  });
});
