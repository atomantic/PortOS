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
vi.mock('./brainStorage.js', () => ({
  getIdeaById: vi.fn(),
  getMemoryEntryById: vi.fn(),
  getProjectById: vi.fn(),
  getAdminById: vi.fn(),
  getPersonById: vi.fn(),
}));
vi.mock('./voice/stt.js', () => ({
  transcribe: vi.fn(),
}));
vi.mock('./browserService.js', () => ({
  navigateToUrlPinned: vi.fn(),
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
  sleep: vi.fn(() => Promise.resolve()),
  safeJSONParse: vi.fn((raw, fallback) => {
    try {
      return JSON.parse(raw);
    } catch {
      return fallback;
    }
  }),
}));

const catalogDB = await import('./catalogDB.js');
const catalogExtraction = await import('./catalogExtraction.js');
const browserService = await import('./browserService.js');
const brainStorage = await import('./brainStorage.js');
const fsp = await import('fs/promises');
const dnsp = await import('dns/promises');
const {
  fetchUrlMainText,
  ingestFromUrl,
  ingestFromFile,
  ingestFromVoice,
  ingestFromBrain,
  brainRecordToIngestText,
} = await import('./catalogIngestSources.js');

const DRAFT = { runId: 'r1', characters: [], stages: [] };

beforeEach(() => {
  vi.clearAllMocks();
  catalogExtraction.extractIngredientsForScrap.mockResolvedValue(DRAFT);
  catalogDB.createChunkedScrap.mockImplementation(async (args) => ({ id: 'cat-scrap-1', ...args }));
  // Hostnames resolve to a safe public address by default (the DNS SSRF guard).
  dnsp.lookup.mockResolvedValue({ address: '93.184.216.34', family: 4 });
  // Default: Chrome dials a single public IP for the document (no rebind).
  browserService.navigateToUrlPinned.mockImplementation(pinnedNav({ finalUrl: 'https://ex.com/a', hops: ['93.184.216.34'] }));
  // Default: the live tab (re-queried after settle) is the same safe url.
  browserService.listCdpPages.mockResolvedValue([{ id: 'p1', url: 'https://ex.com/a', title: 'A', webSocketDebuggerUrl: 'ws://x' }]);
});

/**
 * Faithfully mimic the real `navigateToUrlPinned` fail-closed contract: it
 * verifies each main-frame hop's ACTUAL Chrome-reported connection IP via the
 * caller's `verifyRemoteIp` predicate and throws (tearing the tab down) if any
 * hop is refused. `hops` are the IPs Chrome actually dialed — a rebinding DNS
 * answer surfaces here as a private IP the pre-nav dns.lookup never saw.
 */
function pinnedNav({ finalUrl, hops }) {
  return async (url, { verifyRemoteIp } = {}) => {
    for (const ip of hops) {
      if (!verifyRemoteIp(ip)) {
        throw new Error(`refusing to ingest: Chrome connected to a disallowed address ${ip} for ${url}`);
      }
    }
    return { id: 'p1', url: finalUrl || url, title: '', webSocketDebuggerUrl: 'ws://x' };
  };
}

describe('fetchUrlMainText', () => {
  it('navigates + reads main text, returning title + text + finalUrl', async () => {
    browserService.evaluateOnPage.mockResolvedValue(JSON.stringify({ title: 'Article A', text: 'Body text here.' }));

    const out = await fetchUrlMainText('https://ex.com/a', { settleMs: 0 });
    expect(out).toEqual({ text: 'Body text here.', title: 'Article A', finalUrl: 'https://ex.com/a' });
    // Navigated through the PINNED path with a remote-IP verifier predicate.
    expect(browserService.navigateToUrlPinned).toHaveBeenCalledWith(
      'https://ex.com/a',
      expect.objectContaining({ verifyRemoteIp: expect.any(Function) }),
    );
  });

  it('throws when the page extracts no readable text', async () => {
    browserService.evaluateOnPage.mockResolvedValue(JSON.stringify({ title: '', text: '   ' }));

    await expect(fetchUrlMainText('https://ex.com/a', { settleMs: 0 })).rejects.toThrow(/no readable text/);
    expect(catalogDB.createChunkedScrap).not.toHaveBeenCalled();
  });

  it('refuses to ingest a hostname that resolves to a blocked address (DNS SSRF) before navigating', async () => {
    // Schema passes (it's a normal hostname), but DNS points it at cloud metadata.
    dnsp.lookup.mockResolvedValue({ address: '169.254.169.254', family: 4 });
    await expect(fetchUrlMainText('https://evil.example/x', { settleMs: 0 })).rejects.toThrow(/resolves to a blocked/);
    expect(browserService.navigateToUrlPinned).not.toHaveBeenCalled();
  });

  it('refuses when Chrome connects to a private IP AFTER DNS validation passed (rebinding TOCTOU)', async () => {
    // Pre-nav dns.lookup answers a public IP so assertIngestUrlSafe passes — but
    // Chrome re-resolves and actually dials cloud metadata. The remote-IP pin
    // must catch Chrome's real connection and refuse before any DOM read.
    dnsp.lookup.mockResolvedValue({ address: '93.184.216.34', family: 4 });
    browserService.navigateToUrlPinned.mockImplementation(pinnedNav({ finalUrl: 'https://evil.example/x', hops: ['169.254.169.254'] }));
    await expect(fetchUrlMainText('https://evil.example/x', { settleMs: 0 })).rejects.toThrow(/disallowed address 169\.254\.169\.254/);
    expect(browserService.evaluateOnPage).not.toHaveBeenCalled();
  });

  it('refuses when a REDIRECT hop connects to a loopback address (per-hop pin)', async () => {
    // First hop dials a public IP, but the redirect Chrome followed landed on a
    // loopback address — the pin verifies EVERY main-frame hop, not just the last.
    browserService.navigateToUrlPinned.mockImplementation(pinnedNav({ finalUrl: 'http://127.0.0.1:5555/secret', hops: ['93.184.216.34', '127.0.0.1'] }));
    await expect(fetchUrlMainText('https://ex.com/a', { settleMs: 0 })).rejects.toThrow(/disallowed address 127\.0\.0\.1/);
    expect(browserService.evaluateOnPage).not.toHaveBeenCalled();
  });

  it('refuses a landed HOSTNAME that resolves to a blocked address (defense-in-depth re-check)', async () => {
    // All network hops dialed public IPs (pin passes), but the LIVE tab url after
    // settle is a hostname that itself resolves to metadata — the landed-url
    // re-vet still catches an in-page/JS redirect the network-hop pin didn't cover.
    dnsp.lookup
      .mockResolvedValueOnce({ address: '93.184.216.34', family: 4 })
      .mockResolvedValueOnce({ address: '169.254.169.254', family: 4 });
    browserService.listCdpPages.mockResolvedValue([{ id: 'p1', url: 'https://evil.example/x', title: 'x', webSocketDebuggerUrl: 'ws://x' }]);
    await expect(fetchUrlMainText('https://ex.com/a', { settleMs: 0 })).rejects.toThrow(/resolves to a blocked/);
    expect(browserService.evaluateOnPage).not.toHaveBeenCalled();
  });

  it('re-checks the LIVE tab url after the settle window (client-side nav to loopback)', async () => {
    // Pin passes (public hops), but the page client-side navigates (meta refresh /
    // location.replace) during the settle to a loopback address. We must re-read
    // the CURRENT tab url — not the pre-settle url the pin captured — and refuse.
    browserService.listCdpPages.mockResolvedValue([{ id: 'p1', url: 'http://127.0.0.1:5555/secret', title: 'x', webSocketDebuggerUrl: 'ws://x' }]);
    await expect(fetchUrlMainText('https://ex.com/a', { settleMs: 0 })).rejects.toThrow(/loopback|link-local/);
    expect(browserService.evaluateOnPage).not.toHaveBeenCalled();
  });

  it('clamps an oversized page body to the raw-text cap (2M chars)', async () => {
    const huge = 'x'.repeat(2_500_000);
    browserService.evaluateOnPage.mockResolvedValue(JSON.stringify({ title: 'Big', text: huge }));
    const out = await fetchUrlMainText('https://ex.com/a', { settleMs: 0 });
    expect(out.text.length).toBe(2_000_000);
  });
});

describe('ingestFromUrl', () => {
  it('creates a url scrap with url metadata and runs extraction', async () => {
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

describe('brainRecordToIngestText', () => {
  it('folds an idea record (title + oneLiner + notes) into one block', () => {
    const { title, rawText, tags } = brainRecordToIngestText('ideas', {
      title: 'The city remembers',
      oneLiner: 'A surveillance net becomes sentient.',
      notes: 'It helps the protagonist.',
      tags: ['sci-fi', 'ai'],
    });
    expect(title).toBe('The city remembers');
    expect(rawText).toBe('The city remembers\n\nA surveillance net becomes sentient.\n\nIt helps the protagonist.');
    expect(tags).toEqual(['sci-fi', 'ai']);
  });

  it('uses content for a memory and name for a person', () => {
    expect(brainRecordToIngestText('memories', { title: 'Rooftop', content: 'Rain, neon.' }).rawText)
      .toBe('Rooftop\n\nRain, neon.');
    const person = brainRecordToIngestText('people', { name: 'Elena', context: 'Detective.', followUps: ['call', 'verify'] });
    expect(person.title).toBe('Elena');
    expect(person.rawText).toBe('Elena\n\nDetective.\n\nFollow-ups: call; verify');
  });

  it('falls back to a default title and drops non-string tags', () => {
    const out = brainRecordToIngestText('memories', { content: 'orphan note', tags: ['ok', 5, null] });
    expect(out.title).toBe('Brain entry');
    expect(out.rawText).toBe('orphan note');
    expect(out.tags).toEqual(['ok']);
  });
});

describe('ingestFromBrain', () => {
  it('resolves an idea, creates a brain-bridge scrap, and runs extraction', async () => {
    brainStorage.getIdeaById.mockResolvedValue({
      id: 'idea-1', title: 'Neon detective', oneLiner: 'Noir in a sentient city.', tags: ['noir'],
    });
    const { scrap, draft } = await ingestFromBrain({ brainType: 'ideas', brainId: 'idea-1' });
    expect(draft).toBe(DRAFT);
    const createArgs = catalogDB.createChunkedScrap.mock.calls[0][0];
    expect(createArgs.sourceKind).toBe('brain-bridge');
    expect(createArgs.title).toBe('Neon detective');
    expect(createArgs.rawText).toBe('Neon detective\n\nNoir in a sentient city.');
    expect(createArgs.metadata).toEqual({
      brainType: 'ideas', brainId: 'idea-1', brainTitle: 'Neon detective', brainTags: ['noir'],
    });
    expect(catalogExtraction.extractIngredientsForScrap).toHaveBeenCalledWith(
      expect.objectContaining({ scrapId: scrap.id }),
    );
  });

  it('rejects an unsupported brain type before any lookup', async () => {
    await expect(ingestFromBrain({ brainType: 'links', brainId: 'x' })).rejects.toThrow(/unsupported brain type/);
    expect(catalogDB.createChunkedScrap).not.toHaveBeenCalled();
  });

  it('throws when the brain record is missing', async () => {
    brainStorage.getMemoryEntryById.mockResolvedValue(null);
    await expect(ingestFromBrain({ brainType: 'memories', brainId: 'gone' })).rejects.toThrow(/not found/);
    expect(catalogDB.createChunkedScrap).not.toHaveBeenCalled();
  });

  it('throws when the record has no text to ingest', async () => {
    brainStorage.getMemoryEntryById.mockResolvedValue({ id: 'm1', title: '   ', content: '' });
    await expect(ingestFromBrain({ brainType: 'memories', brainId: 'm1' })).rejects.toThrow(/no text/);
    expect(catalogDB.createChunkedScrap).not.toHaveBeenCalled();
  });
});
