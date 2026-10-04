import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import {
  COMPOSE_PHASES, COMPOSE_SELECTOR_DEFAULTS, SEND_ACK_PATTERN, SEND_REFUSAL_PATTERN, buildComposePhaseScript,
  checkAccountIdentity, classifySendOutcome, planDelivery, recipientsMatch, resolveComposeConfig
} from './messageBrowserCompose.js';

// The single click that cannot be undone: only a positive provider signal is success.
describe('classifySendOutcome', () => {
  const clicked = (seen = {}) => ({ submitClicked: true, composeClosed: false, ackSeen: false, refusalSeen: false, ...seen });

  it.each([
    ['a closed compose surface plus a fresh acknowledgement', clicked({ composeClosed: true, ackSeen: true }), 'confirmed'],
    ['an acknowledgement while the compose surface is still open', clicked({ ackSeen: true }), 'unknown'],
    ['a closed compose surface with no acknowledgement', clicked({ composeClosed: true }), 'unknown'],
    ['an acknowledgement contradicted by a refusal', clicked({ composeClosed: true, ackSeen: true, refusalSeen: true }), 'unknown'],
    ['a refusal with the compose surface still open', clicked({ refusalSeen: true }), 'refused'],
    ['nothing observed after the click', clicked(), 'unknown'],
    ['a lost evaluation (timeout, closed socket, in-page throw)', null, 'unknown'],
    ['a non-object result', 'ok', 'unknown'],
    ['a result that never says whether it clicked', { composeClosed: true, ackSeen: true }, 'unknown'],
    ['an explicit refusal to click', { submitClicked: false, code: 'CONTROL_MISSING', control: 'composeSend' }, 'not_sent']
  ])('%s → %s', (_label, observed, outcome) => {
    expect(classifySendOutcome(observed).outcome).toBe(outcome);
  });

  it('never reports success without an explicit true for every signal', () => {
    for (const ackSeen of [undefined, 'yes', 1]) {
      expect(classifySendOutcome(clicked({ composeClosed: true, ackSeen })).outcome).not.toBe('confirmed');
    }
  });
});

describe('planDelivery', () => {
  const draft = (overrides = {}) => ({ body: 'Example body', to: ['alice@example.com'], subject: 'Example subject', ...overrides });
  const target = (overrides = {}) => ({ id: 'msg-1', threadId: 'thread-1', providerRowId: 'row-1', subject: 'Re', from: { name: 'Bob Example', email: 'Bob@Example.com' }, ...overrides });

  it('plans an explicit recipient list, normalizing display-name forms', () => {
    const { plan } = planDelivery('outlook', draft({ to: ['Alice <Alice@Example.com>', 'alice@example.com'], cc: ['carol@example.com'] }));
    expect(plan).toMatchObject({ to: ['alice@example.com'], cc: ['carol@example.com'], subject: 'Example subject', reply: null });
  });

  it('answers the sender of the message a bare reply was written for, and locates it by provider row id', () => {
    const planned = planDelivery('outlook', draft({ to: [], replyToMessageId: 'msg-1', threadId: 'thread-1' }), target());
    expect(planned.plan).toMatchObject({ to: ['bob@example.com'], reply: { providerRowId: 'row-1' } });
  });

  it.each([
    ['an empty body', 'outlook', { body: '  ' }, null, 'DRAFT_NOT_DELIVERABLE'],
    ['no recipient at all', 'outlook', { to: [] }, null, 'DRAFT_NOT_DELIVERABLE'],
    ['a bare reply whose sender has no email', 'outlook', { to: [], replyToMessageId: 'msg-1' }, target({ from: { name: 'Bob' } }), 'DRAFT_NOT_DELIVERABLE'],
    ['a new Outlook message without a subject', 'outlook', { subject: ' ' }, null, 'DRAFT_NOT_DELIVERABLE'],
    ['Cc on a Teams chat', 'teams', { cc: ['carol@example.com'] }, null, 'DRAFT_NOT_DELIVERABLE'],
    ['a reply with no target', 'outlook', { replyToMessageId: 'msg-1' }, null, 'REPLY_TARGET_NOT_FOUND'],
    ['an Outlook reply whose target has no provider row id', 'outlook', { replyToMessageId: 'msg-1' }, target({ providerRowId: null }), 'REPLY_TARGET_UNIDENTIFIABLE'],
    ['a thread that is not the target\'s thread', 'teams', { replyToMessageId: 'msg-1', threadId: 'thread-2' }, target(), 'THREAD_MISMATCH'],
    ['an account type with no browser transport', 'gmail', {}, null, 'SEND_NOT_SUPPORTED']
  ])('refuses %s', (_label, type, overrides, replyTarget, code) => {
    expect(planDelivery(type, draft(overrides), replyTarget)).toMatchObject({ ok: false, code });
  });

  it('plans a Teams reply by the explicit recipient and needs no subject or row id', () => {
    const planned = planDelivery('teams', draft({ subject: '', replyToMessageId: 'msg-1' }), target({ providerRowId: null }));
    expect(planned).toMatchObject({ ok: true, plan: { to: ['alice@example.com'], reply: null } });
  });
});

describe('what the page may show before the click', () => {
  const plan = { to: ['alice@example.com'], cc: ['carol@example.com'] };

  it('requires exactly the planned recipients — no extras, none missing', () => {
    expect(recipientsMatch(plan, { to: ['Alice@Example.com'], cc: ['carol@example.com'] })).toBe(true);
    expect(recipientsMatch(plan, { to: ['alice@example.com', 'mallory@example.com'], cc: ['carol@example.com'] })).toBe(false);
    expect(recipientsMatch(plan, { to: ['alice@example.com'], cc: [] })).toBe(false);
    expect(recipientsMatch(plan, undefined)).toBe(false);
  });

  it('refuses a visible identity that is not the account\'s and an unverifiable one when another account could be signed in', () => {
    expect(checkAccountIdentity({ expected: 'me@example.com', observed: { emails: ['other@example.com'] }, required: false })).toMatchObject({ ok: false, code: 'ACCOUNT_IDENTITY_MISMATCH' });
    expect(checkAccountIdentity({ expected: 'me@example.com', observed: { emails: ['ME@example.com'] }, required: true })).toEqual({ ok: true });
    expect(checkAccountIdentity({ expected: 'me@example.com', observed: { emails: [] }, required: true })).toMatchObject({ ok: false, code: 'ACCOUNT_IDENTITY_UNVERIFIED' });
    expect(checkAccountIdentity({ expected: '', observed: { emails: [] }, required: true })).toMatchObject({ ok: false, code: 'ACCOUNT_IDENTITY_UNVERIFIED' });
    expect(checkAccountIdentity({ expected: 'me@example.com', observed: { emails: [] }, required: false })).toEqual({ ok: true });
  });
});

describe('resolveComposeConfig', () => {
  it('layers stored overrides over the defaults and ignores unknown keys and bad patterns', () => {
    const config = resolveComposeConfig('outlook', {
      composeSend: ' button.send ', messageRow: 'ignored', sendAckPattern: 'delivered', sendRefusalPattern: '(unclosed'
    });
    expect(config.sels.composeSend).toBe('button.send');
    expect(config.sels.newMail).toBe(COMPOSE_SELECTOR_DEFAULTS.outlook.newMail);
    expect(config.sels).not.toHaveProperty('messageRow');
    expect(config.ackPattern).toBe('delivered');
    expect(config.refusalPattern).toBe(SEND_REFUSAL_PATTERN);
    expect(resolveComposeConfig('outlook', undefined).ackPattern).toBe(SEND_ACK_PATTERN);
    expect(resolveComposeConfig('gmail', {})).toBeNull();
  });
});

// The scripts run inside the provider tab, so a syntax error or an argument that
// escapes its JSON literal would only show up against a real mailbox.
describe('buildComposePhaseScript', () => {
  const args = { sels: COMPOSE_SELECTOR_DEFAULTS.outlook, token: 'attempt-1', to: ['alice@example.com'], cc: [], subject: 'Example', body: 'Example body', reply: null, ackPattern: SEND_ACK_PATTERN, refusalPattern: SEND_REFUSAL_PATTERN, timeoutMs: 1000 };

  it.each(['outlook', 'teams'].flatMap(provider => COMPOSE_PHASES.map(phase => [provider, phase])))('%s %s compiles', (provider, phase) => {
    const script = buildComposePhaseScript(phase, { ...args, provider, sels: COMPOSE_SELECTOR_DEFAULTS[provider] });
    expect(() => new vm.Script(script)).not.toThrow();
    expect(script).toContain(`"phase":"${phase}"`);
  });

  it('carries hostile text only as a JSON string, never as code', () => {
    const body = `"); globalThis.pwned = true; ("${String.fromCharCode(0x2028)}</script>`; // U+2028 must stay inside the JSON literal
    const script = buildComposePhaseScript('fill', { ...args, provider: 'outlook', body });
    expect(() => new vm.Script(script)).not.toThrow();
    expect(script).toContain(JSON.stringify(body).slice(1, -1));
    expect(() => buildComposePhaseScript('send-now', args)).toThrow(/Unknown compose phase/);
  });
});

// Execute the actual recipient-picker script: a transport stub returning the
// requested address cannot catch a suggestion for a different mailbox.
describe('Teams recipient selection in the provider page', () => {
  it.each([
    ['Ann Example ANN@example.com', true],
    ['Joann Example joann@example.com', false],
    ['Ann Example ann@example.com other@example.com', false],
  ])('selects only an exact, unambiguous address from %s', async (suggestion, accepted) => {
    let selected = false;
    let now = 0;
    const element = (innerText = '') => ({
      innerText, isConnected: true, disabled: false,
      getClientRects: () => [{}], getAttribute: () => null,
      querySelectorAll: () => [], focus() {}, click() {}, setAttribute() {},
    });
    const input = element();
    const box = element();
    const option = { ...element(suggestion), click: () => { selected = true; } };
    const sels = COMPOSE_SELECTOR_DEFAULTS.teams;
    const matches = {
      [sels.newChat]: [element()], [sels.recipientInput]: [input],
      [sels.recipientSuggestion]: [option], [sels.composeBox]: [box],
    };
    const document = {
      execCommand() {},
      querySelector: selector => selector === sels.composeBox ? box : null,
      querySelectorAll: selector => matches[selector] || [],
    };
    const result = await vm.runInNewContext(buildComposePhaseScript('open', {
      provider: 'teams', sels, token: 'attempt-1', to: ['ann@example.com'],
    }), { document, Date: { now: () => { now += 1000; return now; } }, setTimeout: callback => { callback(); } });
    expect(selected).toBe(accepted);
    if (accepted) {
      expect(result.ok).toBe(true);
      expect(recipientsMatch({ to: ['ann@example.com'], cc: [] }, { to: result.resolved, cc: [] })).toBe(true);
    } else {
      expect(result.code).toBe('RECIPIENT_UNRESOLVED');
      expect(result.resolved).toBeUndefined();
    }
  });
});
