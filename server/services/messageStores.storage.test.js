import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'path';
import { mkdir, readFile, rm, writeFile } from 'fs/promises';
import { makePathsProxy, lazyTempDataRoot, cleanupTempDataRoots } from '../lib/mockPathsDataRoot.js';

vi.mock('../lib/fileUtils.js', async original => {
  const actual = await original();
  const paths = makePathsProxy(actual, { dataRoot: () => lazyTempDataRoot('portos-message-stores-') }).PATHS;
  return { ...actual, PATHS: paths, atomicWrite: vi.fn(actual.atomicWrite), readJSONFileStrict: vi.fn(actual.readJSONFileStrict) };
});
import { PATHS, atomicWrite, readJSONFileStrict } from '../lib/fileUtils.js';
import * as drafts from './messageDrafts.js';
import * as rules from './messageTriageRules.js';

const draftsFile = join(PATHS.messages, 'drafts.json');
const rulesFile = join(PATHS.messages, 'triage-rules.json');
const correction = { from: 'Example sender', subject: 'Example subject', triaged: 'keep', corrected: 'archive' };
const legacy = { id: 'legacy', status: 'sending', body: 'Example body', extension: { keep: true } };
const unknown = { id: 'unknown', status: 'delivery_unknown', sendAttemptId: 'attempt-1', sendAttempts: [{ id: 'attempt-1', outcome: 'delivery_unknown', startedAt: '2026-01-01' }] };

beforeEach(async () => {
  vi.mocked(atomicWrite).mockClear();
  await rm(PATHS.messages, { recursive: true, force: true });
  await mkdir(PATHS.messages, { recursive: true });
});
afterAll(cleanupTempDataRoots);

describe('Messages strict storage boundaries', () => {
  it.each(['', '{invalid', 'null', '{}', '{"nested":[]}', '[null]', '[{"id":"bad","status":"sending","sendAttempts":{}}]', '[{"id":"bad","status":"delivery_unknown","sendAttemptId":"missing","sendAttempts":[]}]'])('preserves invalid draft bytes %j across every read/mutation/recovery', async content => {
    await writeFile(draftsFile, content);
    for (const operation of [
      () => drafts.listDrafts(), () => drafts.createDraft({ accountId: 'account-1' }),
      () => drafts.updateDraft('legacy', { body: 'replacement' }), () => drafts.initializeMessageDrafts(),
      () => drafts.deleteDraft('legacy'), () => drafts.claimDraftForSend('legacy')
    ]) {
      await expect(operation()).rejects.toMatchObject({ status: 503, code: 'MESSAGE_DRAFTS_UNAVAILABLE' });
      expect(await readFile(draftsFile, 'utf8')).toBe(content);
      expect(atomicWrite).not.toHaveBeenCalled();
    }
  });

  it.each(['', '{invalid', 'null', '[]', '{}', '{"rules":[null]}', '{"rules":[{"senderPattern":"Example","correctedAction":"archive","count":"2"}]}'])('preserves invalid rules bytes %j on correction and deletion', async content => {
    await writeFile(rulesFile, content);
    for (const operation of [() => rules.listRules(), () => rules.recordCorrection(correction), () => rules.deleteRule(0)]) {
      await expect(operation()).rejects.toMatchObject({ status: 503, code: 'MESSAGE_TRIAGE_RULES_UNAVAILABLE' });
      expect(await readFile(rulesFile, 'utf8')).toBe(content);
      expect(atomicWrite).not.toHaveBeenCalled();
    }
  });

  it('refuses unreadable storage without replacing it and recovers retained send evidence once reads succeed', async () => {
    await mkdir(draftsFile);
    await mkdir(rulesFile);
    await expect(drafts.createDraft({ accountId: 'account-1' })).rejects.toMatchObject({ code: 'MESSAGE_DRAFTS_UNAVAILABLE' });
    await expect(drafts.initializeMessageDrafts()).rejects.toMatchObject({ code: 'MESSAGE_DRAFTS_UNAVAILABLE' });
    await expect(rules.recordCorrection(correction)).rejects.toMatchObject({ code: 'MESSAGE_TRIAGE_RULES_UNAVAILABLE' });
    await expect(rules.deleteRule(0)).rejects.toMatchObject({ code: 'MESSAGE_TRIAGE_RULES_UNAVAILABLE' });
    expect(atomicWrite).not.toHaveBeenCalled();
    // A successful restoration retains uncertain delivery identity and history;
    // only the legacy abandoned send receives a recovery write.
    await rm(draftsFile, { recursive: true });
    await atomicWrite(draftsFile, [unknown, legacy]);
    const original = await readFile(draftsFile, 'utf8');
    vi.mocked(atomicWrite).mockClear();
    vi.mocked(readJSONFileStrict).mockResolvedValueOnce({ ok: false, value: null });
    await expect(drafts.listDrafts()).rejects.toMatchObject({ code: 'MESSAGE_DRAFTS_UNAVAILABLE' });
    expect(await readFile(draftsFile, 'utf8')).toBe(original);
    expect(atomicWrite).not.toHaveBeenCalled();
    await drafts.initializeMessageDrafts();
    expect(await drafts.getDraft('unknown')).toEqual(unknown);
    expect(await drafts.getDraft('legacy')).toMatchObject({ ...legacy, status: 'delivery_unknown', sendAttempts: [expect.objectContaining({ outcome: 'delivery_unknown' })] });
  });

  it('creates first stores only on confirmed absence and preserves valid legacy records and root metadata', async () => {
    expect(await drafts.listDrafts()).toEqual([]);
    expect(await rules.listRules()).toEqual([]);
    await drafts.createDraft({ accountId: 'account-1' });
    await rules.recordCorrection(correction);
    expect(await drafts.listDrafts()).toHaveLength(1);
    expect(await rules.listRules()).toHaveLength(1);
    const oldRule = { senderPattern: 'Example sender', correctedAction: 'archive', extension: true };
    await atomicWrite(rulesFile, { rules: [oldRule], extension: true });
    await rules.recordCorrection(correction);
    expect(JSON.parse(await readFile(rulesFile, 'utf8'))).toMatchObject({ extension: true, rules: [{ ...oldRule, count: 2 }] });
    await atomicWrite(draftsFile, [{ ...legacy, status: 'draft' }]);
    await drafts.updateDraft('legacy', { body: 'New body' });
    expect(await drafts.getDraft('legacy')).toMatchObject({ extension: legacy.extension, body: 'New body' });
    await atomicWrite(draftsFile, []);
    await atomicWrite(rulesFile, { rules: [] });
    expect(await drafts.listDrafts()).toEqual([]);
    expect(await rules.listRules()).toEqual([]);
  });
});
