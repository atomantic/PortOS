import { beforeEach, describe, expect, it, vi } from 'vitest';

// The regression this file exists for (#7680): Stacker News was the one
// untrusted-content ingress that never crossed `screenUntrustedContent`, so a
// blocked item's text — and its attached image bytes — still reached Ollama.
// Every assertion below is about what does NOT leave the process on a block.

const account = {
  id: 'account', username: 'example_user', enabled: true, rules: {}, policy_version: 'v1',
  text_model: 'llama3.2', vision_model: 'llava',
};
let item = {};
const analysisRows = [];

const query = vi.fn(async (sql, params) => {
  if (sql.startsWith('SELECT * FROM stacker_news_items')) return { rows: [item] };
  if (sql.startsWith('SELECT * FROM stacker_news_accounts')) return { rows: [account] };
  if (sql.startsWith('SELECT * FROM stacker_news_territories')) return { rows: [] };
  if (sql.startsWith('SELECT content_hash')) return { rows: [{ content_hash: item.content_hash }] };
  if (sql.includes('INSERT INTO stacker_news_analyses')) {
    analysisRows.push({ id: params[0], stage: params[2], provider: params[3], result: params[9] });
  }
  return { rows: [], rowCount: 1 };
});

const fetchWithTimeout = vi.fn();
const fetchAndNormalizeStackerNewsImage = vi.fn();
const screenUntrustedContent = vi.fn();

vi.mock('../lib/db.js', () => ({ query, withTransaction: vi.fn() }));
vi.mock('../lib/vaultCrypto.js', () => ({ decryptValue: vi.fn(), encryptValue: vi.fn(), ensureVaultKey: vi.fn() }));
vi.mock('../integrations/stackerNews/index.js', () => ({ executeStackerNewsOperation: vi.fn(), executeStackerNewsBrowserRead: vi.fn(), stackerNewsCapabilities: {} }));
vi.mock('../lib/fetchWithTimeout.js', () => ({ fetchWithTimeout }));
vi.mock('./stackerNewsMedia.js', () => ({ fetchAndNormalizeStackerNewsImage, hashRemoteMediaUrl: (url) => `hash:${url}` }));
vi.mock('./untrustedContent.js', () => ({ screenUntrustedContent }));

const { analyzeItem } = await import('./stackerNews.js');
const { UNTRUSTED_CONTENT_INSTRUCTIONS } = await import('../lib/untrustedContent.js');

const ollamaResponse = (body) => ({ ok: true, json: async () => ({ message: { content: JSON.stringify(body) } }) });
const allowed = { classification: 'allowed', risk: 'low', summary: 'Ordinary post', findings: [], suggestedAction: 'none' };
const stageResult = (stage) => analysisRows.find((row) => row.stage === stage)?.result;

beforeEach(() => {
  analysisRows.length = 0;
  query.mockClear();
  fetchWithTimeout.mockReset();
  fetchAndNormalizeStackerNewsImage.mockReset();
  screenUntrustedContent.mockReset();
  item = {
    id: 'item', account_id: 'account', territory_id: null, content_hash: 'hash',
    // Deliberately free of the local INJECTION_PATTERNS, so a skipped model call
    // can only be the screening block's doing and not the old regex branch.
    title: 'A community post', body: 'Ordinary body text.', image_urls: ['https://example.com/a.png'],
  };
});

describe('Stacker News phase-1 screening', () => {
  it('reaches no model — text or vision — when screening blocks the item', async () => {
    screenUntrustedContent.mockResolvedValue({ ok: false, safe: false, code: 'untrusted-content-blocked', message: 'flagged' });
    await analyzeItem('item');
    // Two distinct egress channels: the chat POST, and the remote image fetch
    // the vision path performs BEFORE it posts. A block that only skipped the
    // POST would still pull attacker-chosen media.
    expect(fetchWithTimeout).not.toHaveBeenCalled();
    expect(fetchAndNormalizeStackerNewsImage).not.toHaveBeenCalled();
  });

  it('persists the screening code and escalates instead of returning allowed', async () => {
    screenUntrustedContent.mockResolvedValue({ ok: false, safe: false, code: 'untrusted-content-too-large', message: 'too large' });
    const analysis = await analyzeItem('item');
    expect(stageResult('ingress')).toMatchObject({ screeningCode: 'untrusted-content-too-large' });
    expect(analysis.policy).toMatchObject({
      decision: 'escalate', allowedAction: 'none', reasons: ['untrusted_content_screening:untrusted-content-too-large'],
    });
  });

  it('screens the COMPLETE stored text, not the truncated model input', async () => {
    item.body = 'b'.repeat(20_000);
    screenUntrustedContent.mockResolvedValue({ ok: false, safe: false, code: 'untrusted-content-too-large', message: 'too large' });
    await analyzeItem('item');
    // Screening a prefix is what lets an oversized item be truncated instead of
    // refused; the boundary must see everything the row holds.
    expect(screenUntrustedContent.mock.calls[0][0]).toMatchObject({ source: 'stacker-news' });
    expect(screenUntrustedContent.mock.calls[0][0].content).toHaveLength(item.title.length + 1 + 20_000);
  });

  it('frames a cleared item with the shared instructions and envelope', async () => {
    item.image_urls = [];
    screenUntrustedContent.mockResolvedValue({ ok: true, safe: true });
    fetchWithTimeout.mockResolvedValue(ollamaResponse(allowed));
    await analyzeItem('item');
    const request = JSON.parse(fetchWithTimeout.mock.calls[0][1].body);
    expect(request.messages[0].content).toContain(UNTRUSTED_CONTENT_INSTRUCTIONS);
    expect(request.messages[1].content).toContain('<untrusted-content>');
    // The evidence is escaped inside the envelope, never pasted between bare
    // text markers a post can reproduce verbatim to forge a boundary.
    expect(request.messages[1].content).not.toContain('UNTRUSTED CONTENT START');
    expect(request.messages[1].content).toContain('Ordinary body text.');
  });
});
