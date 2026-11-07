import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

const recorded = [];
vi.mock('./humanActivity.js', async (importOriginal) => ({
  ...(await importOriginal()),
  recordEvents: vi.fn(async (candidates) => {
    const fresh = candidates.filter((c) => !recorded.includes(c.dedupeKey));
    recorded.push(...fresh.map((c) => c.dedupeKey));
    return { recorded: fresh.length, skipped: candidates.length - fresh.length };
  }),
}));
vi.mock('./userTimezone.js', () => ({ getUserTimezone: async () => 'UTC' }));

const { importWhatsappHistory } = await import('./whatsappImport.js');
const { recordEvents } = await import('./humanActivity.js');

let dir;
const upload = async (text) => {
  const path = join(dir, `chat-${Math.random()}.txt`);
  await writeFile(path, text);
  return { path, originalname: 'WhatsApp Chat with Alice.txt', mimetype: 'text/plain' };
};

beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'wa-order-')); recorded.length = 0; vi.mocked(recordEvents).mockClear(); });
afterEach(() => rm(dir, { recursive: true, force: true }));

const SHORT = '03/04/24, 18:30 - Alice: hello';
const LONGER = `${SHORT}\n25/04/24, 09:00 - Alice: later`;

describe('importWhatsappHistory date order', () => {
  it('previews an all-days-under-13 file as ambiguous with a range per order, writing nothing', async () => {
    const res = await importWhatsappHistory(await upload(SHORT), { dryRun: true });
    expect(res.dateOrderAmbiguous).toBe(true);
    expect(res.dateOrderSamples.dmy.from).toBe('2024-04-03T18:30:00.000Z');
    expect(res.dateOrderSamples.mdy.from).toBe('2024-03-04T18:30:00.000Z');
    expect(recordEvents).not.toHaveBeenCalled();
  });

  it('refuses to commit an ambiguous file without dateOrder and writes nothing', async () => {
    await expect(importWhatsappHistory(await upload(SHORT), {})).rejects.toMatchObject({ status: 400, code: 'WHATSAPP_DATE_ORDER_REQUIRED' });
    expect(recordEvents).not.toHaveBeenCalled();
  });

  it('stores the day-first date, and a longer re-import only adds the new messages', async () => {
    await importWhatsappHistory(await upload(SHORT), { dateOrder: 'dmy' });
    expect(recordEvents.mock.calls[0][0][0].happenedAt).toBe('2024-04-03T18:30:00.000Z');
    const again = await importWhatsappHistory(await upload(LONGER), {});
    expect(again).toMatchObject({ recorded: 1, skipped: 1 });
  });

  it('imports an unambiguous file with no dateOrder and ignores a contradicting one', async () => {
    const res = await importWhatsappHistory(await upload(LONGER), { dryRun: true });
    expect(res.dateOrderAmbiguous).toBe(false);
    await importWhatsappHistory(await upload(LONGER), { dateOrder: 'mdy' });
    expect(recordEvents.mock.calls[0][0][0].happenedAt).toBe('2024-04-03T18:30:00.000Z');
  });
});
