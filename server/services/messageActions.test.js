import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runInNewContext } from 'node:vm';
const mocks = vi.hoisted(() => ({ account: vi.fn(), message: vi.fn(), evaluate: vi.fn(), write: vi.fn(), trash: vi.fn(), modify: vi.fn(), correction: vi.fn() }));
vi.mock('./messageAccounts.js', () => ({ getAccount: mocks.account }));
vi.mock('./messageSync.js', () => ({ getMessage: mocks.message, removeMessageFromCache: mocks.write }));
vi.mock('./messagePlaywrightSync.js', () => ({ findOrOpenPage: async () => ({}), getPages: async () => [], isAuthPage: () => false, evaluateOnPage: mocks.evaluate }));
vi.mock('./messageTriageRules.js', () => ({ recordCorrection: mocks.correction }));
vi.mock('./googleAuth.js', () => ({ getAuthenticatedClient: async () => ({}) }));
vi.mock('@googleapis/gmail', () => ({ gmail: () => ({ users: { messages: { trash: mocks.trash, modify: mocks.modify } } }) }));
import { executeAction } from './messageActions.js';
const accountId = '11111111-1111-1111-1111-111111111111';
const message = { id: 'requested', subject: 'Status update', from: { name: 'Example Sender', email: 'sender@example.com' }, date: '2026-09-26 10:30' };

// Execute the actual CDP script against a synthetic provider DOM, including the
// production field reader, click, and confirmation loop. No mailbox/network I/O.
function mailbox(records, { remove = true, scroll = false, missingControl = false } = {}) {
  const attr = values => ({ getAttribute: name => values[name] ?? null });
  const span = (text, title) => ({ ...attr({ title }), textContent: text });
  const list = { isConnected: true, parentElement: null, scrollHeight: scroll ? 100 : 0, clientHeight: 0 };
  const clicked = [];
  let visible;
  visible = records.map((record, index) => {
    const row = {
      ...attr({ 'data-itemid': record.providerRowId, 'data-legacy-message-id': record.providerRowId }),
      isConnected: true, matches: () => !!record.providerRowId,
      querySelector(selector) {
        if (selector === 'div[aria-label="Select a conversation"] > span[aria-label]') return attr({ 'aria-label': record.from?.name });
        if (selector === 'div[aria-label="Select a conversation"]') return { parentElement: { nextElementSibling: { children: [
          { querySelector: () => attr({ title: record.from?.email }) },
          { querySelectorAll: () => [span(record.subject), span(record.date, record.date)] }, span('Preview')
        ] } } };
        if (selector === '[email]') return { ...attr({ email: record.from?.email, name: record.from?.name }), textContent: record.from?.name };
        if (selector === 'td.xW [title]') return attr({ title: record.date });
        if (selector === '.bog') return span(record.subject);
        return null;
      },
      querySelectorAll: () => missingControl ? [] : ['Archive', 'Delete'].map(label => ({ ...attr({ 'aria-label': label }), click() { clicked.push({ index, label }); if (remove) visible = visible.filter(r => r !== row); } }))
    };
    return row;
  });
  list.querySelectorAll = () => visible;
  mocks.evaluate.mockImplementation((_page, script) => runInNewContext(script, {
    document: { querySelector: () => list }, location: { href: 'https://example.com/inbox' }, setTimeout: callback => callback()
  }));
  return clicked;
}
beforeEach(() => { vi.clearAllMocks(); mocks.message.mockResolvedValue({ ...message }); mocks.correction.mockResolvedValue(undefined); });
for (const provider of ['gmail', 'outlook']) describe(`${provider} browser identity`, () => {
  beforeEach(() => mocks.account.mockResolvedValue({ type: provider }));
  it('selects the stable ID despite duplicate blank subjects and removes only its cache record', async () => {
    mocks.message.mockResolvedValue({ ...message, subject: '', providerRowId: 'second' });
    const clicked = mailbox([{ ...message, subject: '', providerRowId: 'first' }, { ...message, subject: '', providerRowId: 'second' }]);
    expect(await executeAction(accountId, message.id, 'delete')).toMatchObject({ success: true, messageId: message.id });
    expect(clicked).toEqual([{ index: 1, label: 'Delete' }]);
    expect(mocks.write).toHaveBeenCalledWith(accountId, 'requested');
  });
  it('requires exact legacy identity instead of a subject substring or first row', async () => {
    const clicked = mailbox([{ ...message, subject: 'Re: Status update' }, { ...message, from: { ...message.from, email: 'other@example.com' } }, message]);
    await executeAction(accountId, message.id, 'archive');
    expect(clicked).toEqual([{ index: 2, label: 'Archive' }]);
  });
  it('matches a cached ISO timestamp to an equivalent complete provider timestamp', async () => {
    mocks.message.mockResolvedValue({ ...message, date: '2026-09-26T10:30:00.000Z' });
    const clicked = mailbox([{ ...message, date: 'Sat, 26 Sep 2026 10:30:00 GMT' }]);
    await executeAction(accountId, message.id, 'archive');
    expect(clicked).toEqual([{ index: 0, label: 'Archive' }]);
  });
  it.each(['duplicate', 'blank', 'missing-date', 'missing-sender', 'missing-id', 'virtualized'])('rejects %s identity without action or cache writes', async scenario => {
    const target = { ...message };
    if (scenario === 'blank') target.subject = '';
    if (scenario === 'missing-date') target.date = '';
    if (scenario === 'missing-sender') target.from = {};
    if (scenario === 'missing-id') target.providerRowId = 'absent';
    mocks.message.mockResolvedValue(target);
    const clicked = mailbox(scenario === 'duplicate' ? [target, target] : [message], { scroll: scenario === 'virtualized' });
    await expect(executeAction(accountId, message.id, 'delete')).rejects.toMatchObject({ status: 409, code: 'MESSAGE_IDENTITY_CONFLICT' });
    expect(clicked).toEqual([]); expect(mocks.write).not.toHaveBeenCalled(); expect(mocks.correction).not.toHaveBeenCalled();
  });
  it('keeps cache when the row remains or CDP returns no confirmation', async () => {
    mailbox([message], { remove: false });
    await expect(executeAction(accountId, message.id, 'archive')).rejects.toMatchObject({ code: 'MESSAGE_ACTION_UNCONFIRMED' });
    mocks.evaluate.mockResolvedValue(null);
    await expect(executeAction(accountId, message.id, 'archive')).rejects.toMatchObject({ code: 'MESSAGE_ACTION_UNCONFIRMED' });
    expect(mocks.write).not.toHaveBeenCalled();
  });
  it('never uses a global action when the target lacks its own control', async () => {
    const clicked = mailbox([message], { missingControl: true });
    await expect(executeAction(accountId, message.id, 'delete')).rejects.toMatchObject({ code: 'MESSAGE_IDENTITY_CONFLICT' });
    expect(clicked).toEqual([]);
  });
});
it('preserves Gmail API-by-ID archive and delete without browser calls', async () => {
  mocks.account.mockResolvedValue({ type: 'gmail' }); mocks.message.mockResolvedValue({ ...message, apiId: 'api-target' });
  await executeAction(accountId, message.id, 'delete'); await executeAction(accountId, message.id, 'archive');
  expect(mocks.trash).toHaveBeenCalledWith({ userId: 'me', id: 'api-target' });
  expect(mocks.modify).toHaveBeenCalledWith({ userId: 'me', id: 'api-target', requestBody: { removeLabelIds: ['INBOX'] } });
  expect(mocks.evaluate).not.toHaveBeenCalled();
});
