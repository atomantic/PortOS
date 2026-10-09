import { describe, it, expect, vi, beforeEach } from 'vitest';

// In-memory file adapter with a controllable write barrier.
const fs = vi.hoisted(() => ({ content: null, gate: null, failNextWrite: false }));

vi.mock('../lib/fileUtils.js', () => ({
  PATHS: { messages: '/virtual/messages' },
  ensureDir: async () => {},
  readJSONFileStrict: async () => ({ ok: true, value: JSON.parse(fs.content) }),
  atomicWrite: async (_path, data) => {
    if (fs.gate) await fs.gate;
    if (fs.failNextWrite) { fs.failNextWrite = false; throw new Error('disk full'); }
    fs.content = JSON.stringify(data);
  }
}));

const { recordCorrection, deleteRule, listRules } = await import('./messageTriageRules.js');

const corr = (from, extra = {}) => ({ from, subject: 's', triaged: 'archive', corrected: 'delete', ...extra });

beforeEach(() => {
  fs.content = JSON.stringify({ rules: [] });
  fs.gate = null;
  fs.failNextWrite = false;
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

describe('messageTriageRules write serialization', () => {
  it('persists both rules for overlapping corrections from different senders', async () => {
    let release;
    fs.gate = new Promise(r => { release = r; });
    const a = recordCorrection(corr('a@example.com'));
    const b = recordCorrection(corr('b@example.com'));
    release();
    await Promise.all([a, b]);
    expect((await listRules()).map(r => r.senderPattern).sort()).toEqual(['a@example.com', 'b@example.com']);
  });

  it('persists both increments for overlapping corrections of one existing pattern', async () => {
    await recordCorrection(corr('a@example.com'));
    let release;
    fs.gate = new Promise(r => { release = r; });
    const p = [recordCorrection(corr('a@example.com')), recordCorrection(corr('a@example.com'))];
    release();
    await Promise.all(p);
    const rules = await listRules();
    expect(rules).toHaveLength(1);
    expect(rules[0].count).toBe(3);
  });

  it('keeps unrelated rules and does not resurrect a deleted rule when delete overlaps a correction', async () => {
    await recordCorrection(corr('a@example.com'));
    await recordCorrection(corr('b@example.com'));
    let release;
    fs.gate = new Promise(r => { release = r; });
    const del = deleteRule(0);
    const add = recordCorrection(corr('c@example.com'));
    release();
    expect(await del).toBe(true);
    await add;
    expect((await listRules()).map(r => r.senderPattern)).toEqual(['b@example.com', 'c@example.com']);
  });

  it('a rejected mutation does not poison later queued operations', async () => {
    fs.failNextWrite = true;
    const failed = recordCorrection(corr('a@example.com'));
    const ok = recordCorrection(corr('b@example.com'));
    await expect(failed).rejects.toThrow('disk full');
    await ok;
    expect((await listRules()).map(r => r.senderPattern)).toEqual(['b@example.com']);
  });
});
