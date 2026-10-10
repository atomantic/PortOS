import { beforeEach, describe, expect, it, vi } from 'vitest';
import vm from 'node:vm';

const findOrOpenPage = vi.fn();
const isAuthPage = vi.fn();
const evaluateOnPage = vi.fn();
const listCdpPages = vi.fn();
vi.mock('./browserService.js', () => ({ findOrOpenPage, isAuthPage, evaluateOnPage, listCdpPages }));

const tryReadFile = vi.fn();
vi.mock('../lib/fileUtils.js', async () => {
  const actual = await vi.importActual('../lib/fileUtils.js');
  return { ...actual, tryReadFile };
});

const { testSelectors, syncPlaywright, sendPlaywright, refreshMessageDetail } = await import('./messagePlaywrightSync.js');

const OPEN_PAGE = { url: 'https://outlook.office.com/mail/', webSocketDebuggerUrl: 'ws://x' };

describe('testSelectors', () => {
  beforeEach(() => {
    findOrOpenPage.mockReset();
    isAuthPage.mockReset();
    evaluateOnPage.mockReset();
    tryReadFile.mockReset();
  });

  it('reports no-browser when no CDP tab could be found or opened', async () => {
    findOrOpenPage.mockResolvedValue(null);

    const result = await testSelectors('outlook');

    expect(result.status).toBe('no-browser');
    expect(result.results).toEqual({});
    expect(isAuthPage).not.toHaveBeenCalled();
  });

  it('reports auth-required without evaluating selectors when the tab is a login redirect', async () => {
    findOrOpenPage.mockResolvedValue(OPEN_PAGE);
    isAuthPage.mockReturnValue(true);

    const result = await testSelectors('outlook');

    expect(result.status).toBe('auth-required');
    expect(evaluateOnPage).not.toHaveBeenCalled();
  });

  it('reports no-selectors when the provider has none configured', async () => {
    findOrOpenPage.mockResolvedValue(OPEN_PAGE);
    isAuthPage.mockReturnValue(false);
    tryReadFile.mockResolvedValue(JSON.stringify({}));

    const result = await testSelectors('outlook');

    expect(result.status).toBe('no-selectors');
    expect(evaluateOnPage).not.toHaveBeenCalled();
  });

  it('reports ok when every configured selector matches at least one element', async () => {
    findOrOpenPage.mockResolvedValue(OPEN_PAGE);
    isAuthPage.mockReturnValue(false);
    tryReadFile.mockResolvedValue(JSON.stringify({ outlook: { messageRow: "[role='listbox'] [role='option']" } }));
    evaluateOnPage.mockResolvedValue(12);

    const result = await testSelectors('outlook');

    expect(result.status).toBe('ok');
    expect(result.results.messageRow).toEqual({ selector: "[role='listbox'] [role='option']", matches: 12 });
  });

  it('reports partial when at least one configured selector matches zero elements', async () => {
    findOrOpenPage.mockResolvedValue(OPEN_PAGE);
    isAuthPage.mockReturnValue(false);
    tryReadFile.mockResolvedValue(JSON.stringify({
      outlook: { messageRow: "[role='listbox'] [role='option']", extra: '.gone' },
    }));
    evaluateOnPage.mockResolvedValueOnce(3).mockResolvedValueOnce(0);

    const result = await testSelectors('outlook');

    expect(result.status).toBe('partial');
    expect(result.results.extra).toEqual({ selector: '.gone', matches: 0 });
  });

  it('treats a failed evaluation (null) as zero matches rather than throwing', async () => {
    findOrOpenPage.mockResolvedValue(OPEN_PAGE);
    isAuthPage.mockReturnValue(false);
    tryReadFile.mockResolvedValue(JSON.stringify({ outlook: { messageRow: "[role='listbox'] [role='option']" } }));
    evaluateOnPage.mockResolvedValue(null);

    const result = await testSelectors('outlook');

    expect(result.status).toBe('partial');
    expect(result.results.messageRow.matches).toBe(0);
  });
});

it('retains the ingested provider row ID when detail is unavailable', async () => {
  findOrOpenPage.mockResolvedValue(OPEN_PAGE);
  isAuthPage.mockReturnValue(false);
  tryReadFile.mockResolvedValue('{}');
  evaluateOnPage.mockReset();
  evaluateOnPage.mockResolvedValueOnce([{ providerRowId: 'stable-row', from: 'Example Sender', subject: 'Example subject', date: '2026-09-26' }]);
  evaluateOnPage.mockResolvedValue({ found: false });
  const result = await syncPlaywright({ id: 'example-account', type: 'outlook' }, { messages: [] });
  expect(result.messages).toEqual([expect.objectContaining({ providerRowId: 'stable-row', subject: 'Example subject' })]);
});

// Teams' list view exposes no trusted read-state marker, so a Teams sync must record
// read state as unknown (null) — not manufacture read messages (#9968). Runs the real
// generated extraction script against a synthetic DOM, independent of the requested mode.
it('records Teams read state as unknown for both sync modes', async () => {
  findOrOpenPage.mockResolvedValue({ url: 'https://teams.microsoft.com/', webSocketDebuggerUrl: 'ws://x' });
  isAuthPage.mockReturnValue(false);
  tryReadFile.mockResolvedValue('{}');
  const document = { querySelectorAll: () => [
    { innerText: 'Alice Example\nHello there\n10:00' },
    { innerText: 'Bob Example\n3 unread messages\n09:00' }
  ] };
  const scripts = [];
  evaluateOnPage.mockReset();
  evaluateOnPage.mockImplementation(async (_page, script) => { scripts.push(script); return vm.runInNewContext(script, { document }); });

  for (const mode of ['unread', 'full']) {
    const result = await syncPlaywright({ id: 'example-account', type: 'teams' }, { messages: [] }, null, { mode });
    expect(result.messages).toHaveLength(2);
    for (const message of result.messages) expect(message).toMatchObject({ isRead: null, isUnread: null });
  }
  expect(scripts[0]).toBe(scripts[1]);
});

// These fixtures expose only the configured document selector, run the actual
// production row reader and browser scripts, and model virtualized paints/clicks.
describe('Outlook configured row extraction', () => {
  const account = { id: 'example-account', type: 'outlook' };
  const defaultSelector = "[role='listbox'] [role='option']";
  const customSelector = '.example-mail[data-label="quoted\\value"]';
  const record = (id, isUnread = true) => ({ providerRowId: id, isUnread,
    from: 'Example Sender', subject: 'Example subject', date: '2026-10-10', preview: 'Example preview' });

  function mailbox(paints, { selector = customSelector, container = 'region' } = {}) {
    let paint = 0;
    let opened = false;
    const clicked = [];
    const attr = values => ({ getAttribute: name => values[name] ?? null });
    const span = (text, title) => ({ ...attr({ title }), textContent: text });
    const scroll = {
      scrollHeight: 1000, clientHeight: 100,
      contains: () => true,
      scrollBy: vi.fn(() => { paint = Math.min(paint + 1, paints.length - 1); }),
      scrollTo: vi.fn(() => { paint = 0; })
    };
    const staticRegion = { contains: () => true, scrollBy() {}, scrollTo() {} };
    if (container === 'nested') scroll.parentElement = staticRegion;
    const list = { parentElement: scroll };
    const rows = paints.map(records => records.map(data => ({
      ...attr({ 'data-itemid': data.providerRowId }), parentElement: container === 'none' ? null : container === 'list' ? list : scroll,
      closest: sel => container === 'nested' && sel === '[role="region"]' ? staticRegion
        : container === 'region' && sel === '[role="region"]' ? scroll
        : container === 'list' && sel.includes('[role="listbox"]') ? list : null,
      scrollIntoView() {},
      click() { clicked.push(data.providerRowId); opened = true; },
      querySelector(sel) {
        if (sel === 'button[aria-label="Mark as read"]') return data.isUnread ? {} : null;
        if (sel === 'div[aria-label="Select a conversation"] > span[aria-label]') return attr({ 'aria-label': data.from });
        if (sel === 'div[aria-label="Select a conversation"]') return { parentElement: { nextElementSibling: { children: [
          { querySelector: () => attr({ title: 'sender@example.com' }) },
          { querySelectorAll: () => [span(data.subject), span(data.date, data.date)] }, span(data.preview)
        ] } } };
        return null;
      }
    })));
    const body = { innerText: 'Example full body' };
    const pane = {
      innerText: 'Example subject', querySelector: () => body,
      querySelectorAll: sel => sel === '[aria-label="Email message"]' ? [] : [body]
    };
    const document = {
      querySelector: sel => opened && sel === 'main[aria-label="Reading Pane"]' ? pane : null,
      querySelectorAll(sel) {
        if (sel === '[' || sel === '') throw new SyntaxError('Invalid selector');
        return sel === selector ? rows[paint] : [];
      }
    };
    evaluateOnPage.mockImplementation((_page, script) => vm.runInNewContext(script, {
      document, location: { href: 'https://example.com/mail/' },
      getComputedStyle: el => ({ overflowY: el === scroll ? 'auto' : 'visible' }), setTimeout: callback => callback()
    }));
    return { clicked, scroll };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    evaluateOnPage.mockReset();
    findOrOpenPage.mockResolvedValue(OPEN_PAGE);
    listCdpPages.mockResolvedValue([OPEN_PAGE]);
    isAuthPage.mockReturnValue(false);
    tryReadFile.mockResolvedValue(JSON.stringify({ outlook: { messageRow: customSelector } }));
  });

  it('uses the tested override for sync detail and refresh, preserving the exact provider row ID', async () => {
    // Identical subject/sender/date must not pull the other conversation's detail.
    const { clicked } = mailbox([[record('first'), record('second')]]);
    expect(await testSelectors('outlook')).toMatchObject({ status: 'ok', results: { messageRow: { matches: 2 } } });
    const result = await syncPlaywright(account, { messages: [] });
    expect(result).toMatchObject({ status: 'success', inboxComplete: false });
    expect(result.messages.map(m => m.providerRowId)).toEqual(['first', 'second']);
    expect(result.messages.every(m => m.bodyFull && m.bodyText === 'Example full body')).toBe(true);
    expect(clicked).toEqual(['first', 'second']);
    expect(await refreshMessageDetail(account, result.messages[1])).toEqual([
      expect.objectContaining({ body: 'Example full body' })
    ]);
    expect(clicked).toEqual(['first', 'second', 'second']);
  });

  it.each(['region', 'list', 'overflow', 'nested'])('retains bounded full/unread virtualized scrolling with a %s container', async container => {
    for (const selector of [defaultSelector, customSelector]) {
      tryReadFile.mockResolvedValue(selector === defaultSelector ? '{}' : JSON.stringify({ outlook: { messageRow: selector } }));
      for (const mode of ['unread', 'full']) {
        mailbox([[record('unread')], [record('read', false)]], { selector, container });
        // First get IDs at the service boundary, then use that cache to isolate list scrolling.
        const cache = { messages: [] };
        const first = await syncPlaywright(account, cache, null, { mode });
        cache.messages = first.messages;
        const { scroll } = mailbox([[record('unread')], [record('read', false)]], { selector, container });
        const result = await syncPlaywright(account, cache, null, { mode });
        expect(result).toMatchObject({ status: 'success', inboxComplete: false });
        expect(result.messages.map(m => m.providerRowId)).toEqual(mode === 'full' ? ['unread', 'read'] : ['unread']);
        expect(result.messages.map(m => m.isRead)).toEqual(mode === 'full' ? [false, true] : [false]);
        expect(scroll.scrollBy).toHaveBeenCalledTimes(mode === 'full' ? 21 : 10);
        expect(scroll.scrollTo).toHaveBeenLastCalledWith(0, 0);
      }
    }
  });

  it('caps full/unread extraction even when more rows are visible', async () => {
    for (const [mode, cap] of [['unread', 100], ['full', 200]]) {
      const { scroll } = mailbox([Array.from({ length: 210 }, (_, i) => record(`row-${i}`))]);
      const result = await syncPlaywright(account, { messages: [] }, null, { mode });
      expect(result.messages).toHaveLength(cap);
      expect(result.inboxComplete).toBe(false);
      expect(scroll.scrollBy).not.toHaveBeenCalled();
    }
  });

  it('reports invalid selectors in Test, sync and refresh instead of using default rows', async () => {
    mailbox([[record('unrelated')]], { selector: defaultSelector });
    tryReadFile.mockResolvedValue(JSON.stringify({ outlook: { messageRow: '[' } }));
    expect(await testSelectors('outlook')).toMatchObject({ status: 'partial', results: { messageRow: { matches: 0, error: expect.stringContaining('Invalid Outlook') } } });
    expect(await syncPlaywright(account, { messages: [] })).toMatchObject({ status: 'extraction-failed', messages: [], error: expect.stringContaining('Messages > Sync') });
    expect(await refreshMessageDetail(account, { providerRowId: 'unrelated' })).toMatchObject({ error: 'invalid-selector' });
  });

  it('reports unusable containers rather than reporting a successful empty inbox', async () => {
    const { clicked } = mailbox([[record('first')]], { container: 'none' });
    expect(await syncPlaywright(account, { messages: [] })).toMatchObject({ status: 'extraction-failed', error: expect.stringContaining('scrollable list') });
    expect(await refreshMessageDetail(account, { providerRowId: 'first' })).toMatchObject({ error: 'invalid-container' });
    expect(clicked).toEqual([]);
  });

  it('refuses ambiguous detail immediately even if scrolling would leave a unique target', async () => {
    const { clicked, scroll } = mailbox([[record('duplicate'), record('duplicate')], [record('duplicate')]]);
    expect(await refreshMessageDetail(account, { providerRowId: 'duplicate' })).toBeNull();
    expect(clicked).toEqual([]);
    expect(scroll.scrollBy).not.toHaveBeenCalled();
  });
});

// Browser-delivered drafts. evaluateOnPage is scripted per compose phase, so the
// whole success / failure / ambiguity matrix runs with no mailbox and no recipient.
describe('sendPlaywright', () => {
  const OUTLOOK_PAGE = { id: 'page-1', type: 'page', url: 'https://outlook.office.com/mail/', webSocketDebuggerUrl: 'ws://page' };
  const TEAMS_PAGE = { id: 'page-2', type: 'page', url: 'https://teams.microsoft.com/v2/', webSocketDebuggerUrl: 'ws://teams' };
  const outlook = { id: 'acct-1', type: 'outlook', email: 'me@example.com' };
  const teams = { id: 'acct-2', type: 'teams', email: '' };
  const draft = (overrides = {}) => ({ id: 'draft-1', sendAttemptId: 'attempt-1', body: 'Example body', to: ['alice@example.com'], cc: [], subject: 'Example subject', ...overrides });
  const CONFIRMED = { submitClicked: true, composeClosed: true, ackSeen: true, refusalSeen: false };

  const phaseOf = script => script.match(/"phase":"(\w+)"/)?.[1];
  const phasesRun = () => evaluateOnPage.mock.calls.map(([, script]) => phaseOf(script));
  const scriptBrowser = (overrides = {}) => {
    const phases = {
      probe: { found: true, emails: [] },
      open: { ok: true },
      fill: { ok: true, subjectOk: true, bodyOk: true, to: ['alice@example.com'], cc: [] },
      submit: CONFIRMED,
      discard: { discarded: true },
      ...overrides
    };
    evaluateOnPage.mockImplementation(async (_page, script, options) => {
      const value = phases[phaseOf(script)];
      return typeof value === 'function' ? value(script, options) : value;
    });
  };

  beforeEach(() => {
    findOrOpenPage.mockReset();
    isAuthPage.mockReset().mockReturnValue(false);
    evaluateOnPage.mockReset();
    tryReadFile.mockReset().mockResolvedValue(null);
    // A service-worker target for the same host must never be mistaken for the page.
    listCdpPages.mockReset().mockResolvedValue([{ type: 'service_worker', url: 'https://outlook.office.com/mail/sw.js', webSocketDebuggerUrl: 'ws://sw' }, OUTLOOK_PAGE, TEAMS_PAGE]);
    scriptBrowser();
  });

  it('confirms an Outlook send only after one pass through probe, open, fill and a single submit', async () => {
    expect(await sendPlaywright(outlook, draft())).toEqual({ success: true, confirmed: true });
    expect(phasesRun()).toEqual(['probe', 'open', 'fill', 'submit']);
    expect(evaluateOnPage.mock.calls.every(([page]) => page === OUTLOOK_PAGE)).toBe(true);
    expect(findOrOpenPage).not.toHaveBeenCalled();
    const [, submitScript, options] = evaluateOnPage.mock.calls.at(-1);
    expect(submitScript).toContain('"body":"Example body"');
    expect(options.timeout).toBeGreaterThan(20000);
  });

  it('answers a cached Outlook message by its provider row id and sends to its sender', async () => {
    scriptBrowser({ fill: { ok: true, subjectOk: true, bodyOk: true, to: ['bob@example.com'], cc: [] } });
    const replyTarget = { providerRowId: 'row-1', subject: 'Example', from: { name: 'Bob Example', email: 'bob@example.com' } };
    const result = await sendPlaywright(outlook, draft({ to: [], replyToMessageId: 'msg-1' }), { replyTarget });
    expect(result).toEqual({ success: true, confirmed: true });
    const openScript = evaluateOnPage.mock.calls.find(([, script]) => phaseOf(script) === 'open')[1];
    expect(openScript).toContain('"providerRowId":"row-1"');
    expect(openScript).toContain('"to":["bob@example.com"]');
  });

  it('delivers a Teams chat to the resolved recipient on the Teams tab', async () => {
    scriptBrowser({ open: { ok: true, resolved: ['alice@example.com'] }, fill: { ok: true, bodyOk: true } });
    expect(await sendPlaywright(teams, draft({ subject: '' }))).toEqual({ success: true, confirmed: true });
    expect(evaluateOnPage.mock.calls.every(([page]) => page === TEAMS_PAGE)).toBe(true);
  });

  describe('before anything is submitted', () => {
    it.each([
      ['no tab for the provider is open', () => listCdpPages.mockResolvedValue([]), 'PROVIDER_TAB_UNAVAILABLE', []],
      ['the tab has no debugger connection', () => listCdpPages.mockResolvedValue([{ ...OUTLOOK_PAGE, webSocketDebuggerUrl: undefined }]), 'PROVIDER_TAB_UNAVAILABLE', []],
      ['the login has expired', () => isAuthPage.mockReturnValue(true), 'PROVIDER_LOGIN_REQUIRED', []],
      ['the tab never answers the identity probe', () => scriptBrowser({ probe: null }), 'PROVIDER_TAB_UNAVAILABLE', ['probe']],
      ['the tab is signed in as someone else', () => scriptBrowser({ probe: { found: true, emails: ['other@example.com'] } }), 'ACCOUNT_IDENTITY_MISMATCH', ['probe']]
    ])('%s: fails without opening a compose window', async (_label, arrange, code, ran) => {
      arrange();
      expect(await sendPlaywright(outlook, draft())).toMatchObject({ success: false, code });
      expect(phasesRun()).toEqual(ran);
    });

    it('blocks an unverifiable sign-in when several accounts share the provider', async () => {
      expect(await sendPlaywright(outlook, draft(), { requireIdentity: true })).toMatchObject({ success: false, status: 409, code: 'ACCOUNT_IDENTITY_UNVERIFIED' });
      expect(phasesRun()).toEqual(['probe']);
      scriptBrowser({ probe: { found: true, emails: ['ME@example.com'] } });
      expect(await sendPlaywright(outlook, draft(), { requireIdentity: true })).toMatchObject({ success: true });
    });

    it.each([
      ['a compose control is missing', { open: { code: 'CONTROL_MISSING', control: 'newMail' } }, 'PROVIDER_CONTROL_MISSING'],
      ['a compose window is already in use', { open: { code: 'COMPOSE_BUSY' } }, 'PROVIDER_COMPOSE_BUSY'],
      ['the page stops answering while opening', { open: null }, 'PROVIDER_TAB_UNAVAILABLE'],
      ['the shown recipients differ from the approved ones', { fill: { ok: true, subjectOk: true, bodyOk: true, to: ['alice@example.com', 'mallory@example.com'], cc: [] } }, 'RECIPIENT_MISMATCH'],
      ['the typed text did not take', { fill: { ok: true, subjectOk: true, bodyOk: false, to: ['alice@example.com'], cc: [] } }, 'PROVIDER_CONTENT_MISMATCH']
    ])('%s: removes its own compose window and never reaches submit', async (_label, overrides, code) => {
      scriptBrowser(overrides);
      expect(await sendPlaywright(outlook, draft())).toMatchObject({ success: false, code });
      expect(phasesRun()).not.toContain('submit');
      expect(phasesRun().at(-1)).toBe('discard');
    });

    it('refuses a Teams recipient the picker did not resolve to exactly the planned address', async () => {
      scriptBrowser({ open: { ok: true, resolved: ['someone-else@example.com'] } });
      expect(await sendPlaywright(teams, draft({ subject: '' }))).toMatchObject({ success: false, code: 'RECIPIENT_MISMATCH' });
      expect(phasesRun()).not.toContain('submit');
    });

    it('reports a throw before the click as a definite failure', async () => {
      evaluateOnPage.mockImplementation(async (_page, script) => {
        if (phaseOf(script) === 'open') throw new Error('Example socket failure');
        return { found: true, emails: [] };
      });
      expect(await sendPlaywright(outlook, draft())).toMatchObject({ success: false, status: 502, code: 'SEND_FAILED' });
      expect(phasesRun()).not.toContain('submit');
    });

    it('stops at a deliverability problem before touching the browser', async () => {
      expect(await sendPlaywright(outlook, draft({ to: [] }))).toMatchObject({ success: false, code: 'DRAFT_NOT_DELIVERABLE' });
      expect(evaluateOnPage).not.toHaveBeenCalled();
      expect(await sendPlaywright({ id: 'acct-3', type: 'gmail' }, draft())).toMatchObject({ success: false, status: 501, code: 'SEND_NOT_SUPPORTED' });
    });
  });

  describe('after the single submit click', () => {
    const lastPhases = () => phasesRun().slice(-2);

    it.each([
      ['the evaluation is lost', null],
      ['the compose window closed but nothing acknowledged it', { ...CONFIRMED, ackSeen: false }],
      ['the acknowledgement arrived while the window stayed open', { ...CONFIRMED, composeClosed: false }],
      ['the page reported an acknowledgement and a refusal', { ...CONFIRMED, refusalSeen: true }]
    ])('%s: reports unknown delivery, never discards, never retries', async (_label, submit) => {
      scriptBrowser({ submit });
      expect(await sendPlaywright(outlook, draft())).toMatchObject({ success: false, deliveryUnknown: true, status: 502, code: 'DELIVERY_UNKNOWN' });
      expect(phasesRun().filter(phase => phase === 'submit')).toHaveLength(1);
      expect(phasesRun()).not.toContain('discard');
      expect(lastPhases()).toEqual(['fill', 'submit']);
    });

    it('reports a provider refusal as a definite failure and leaves the compose window for the user', async () => {
      scriptBrowser({ submit: { submitClicked: true, composeClosed: false, ackSeen: false, refusalSeen: true } });
      expect(await sendPlaywright(outlook, draft())).toMatchObject({ success: false, status: 502, code: 'PROVIDER_REFUSED' });
      expect(phasesRun()).not.toContain('discard');
    });

    it('treats a missing Send control as not sent and clears the compose window', async () => {
      scriptBrowser({ submit: { submitClicked: false, code: 'CONTROL_MISSING', control: 'composeSend' } });
      expect(await sendPlaywright(outlook, draft())).toMatchObject({ success: false, code: 'PROVIDER_CONTROL_MISSING' });
      expect(lastPhases()).toEqual(['submit', 'discard']);
    });

    it('reports a throw while submitting as unknown delivery, because the click may have happened', async () => {
      evaluateOnPage.mockImplementation(async (_page, script) => {
        if (phaseOf(script) === 'submit') throw new Error('Example socket failure');
        return { probe: { found: true, emails: [] }, open: { ok: true }, fill: { ok: true, subjectOk: true, bodyOk: true, to: ['alice@example.com'], cc: [] } }[phaseOf(script)];
      });
      expect(await sendPlaywright(outlook, draft())).toMatchObject({ success: false, deliveryUnknown: true, code: 'DELIVERY_UNKNOWN' });
      expect(phasesRun()).not.toContain('discard');
    });
  });

  it('serializes sends through one provider tab but lets another provider proceed', async () => {
    const gate = Promise.withResolvers();
    const flush = () => new Promise(resolve => setImmediate(resolve));
    let submits = 0;
    scriptBrowser({
      submit: async () => {
        if (++submits === 1) await gate.promise;
        return CONFIRMED;
      },
      open: { ok: true, resolved: ['alice@example.com'] },
      fill: { ok: true, subjectOk: true, bodyOk: true, to: ['alice@example.com'], cc: [] }
    });
    const first = sendPlaywright(outlook, draft());
    await vi.waitFor(() => expect(submits).toBe(1));
    const second = sendPlaywright(outlook, draft({ id: 'draft-2', sendAttemptId: 'attempt-2' }));
    const otherProvider = await sendPlaywright(teams, draft({ id: 'draft-3', sendAttemptId: 'attempt-3', subject: '' }));
    await flush();
    expect(otherProvider).toMatchObject({ success: true });
    expect(phasesRun().filter(phase => phase === 'probe')).toHaveLength(2); // first Outlook + the Teams send
    gate.resolve();
    expect(await first).toMatchObject({ success: true });
    expect(await second).toMatchObject({ success: true });
    expect(phasesRun().filter(phase => phase === 'probe')).toHaveLength(3);
    expect(submits).toBe(3);
  });
});
