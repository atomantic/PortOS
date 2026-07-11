/**
 * Pure-logic + injectable-dep tests for the opt-out automation engine
 * (issue #2145): disclosure guardrail, lane selection, template rendering,
 * anti-phishing verification scoring, planner ordering, and the lane/run-loop
 * wiring. No network / DB — privacyBrokers transitions + the message/vault/scan
 * services are mocked so the orchestration is exercised without Postgres.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const transitionCase = vi.fn(async (id, to, patch) => ({ id, state: to, ...patch }));
const listBrokers = vi.fn(async () => []);
const listBrokerCases = vi.fn(async () => []);
const getBroker = vi.fn(async () => null);

vi.mock('./privacyBrokers.js', () => ({
  transitionCase,
  listBrokers,
  listBrokerCases,
  getBroker,
  getCaseForBroker: vi.fn(async () => null),
}));
vi.mock('./privacyVault.js', () => ({ listScanEligibleValues: vi.fn(async () => []) }));
vi.mock('./privacyScan.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, probeBroker: vi.fn(async () => ({ skipped: true, reason: 'inconclusive' })) };
});
const createDraft = vi.fn(async (d) => ({ id: 'draft-1', status: 'draft', ...d }));
const approveDraft = vi.fn(async () => ({ id: 'draft-1', status: 'approved' }));
vi.mock('./messageDrafts.js', () => ({ createDraft, approveDraft }));
vi.mock('./messageAccounts.js', () => ({ listAccounts: vi.fn(async () => [{ id: 'acct-1', type: 'gmail' }]) }));
vi.mock('./messageSync.js', () => ({ getMessages: vi.fn(async () => ({ messages: [] })) }));
vi.mock('./settings.js', () => ({ getSettings: vi.fn(async () => ({ privacy: { recheck: {} } })) }));

const {
  DISCLOSURE_ALLOWLIST, buildDisclosurePayload, computeDisclosedFields, renderDisclosedSummary,
  chooseLane, chooseEmailTemplate, fillTemplate, renderOptOutEmail,
  brokerDomains, scoreVerificationEmail, planOptOutActions,
  emailLane, webFormLane, runOptOutPass, runVerificationPass, getOptOutDigest,
} = await import('./privacyOptOut.js');
const scan = await import('./privacyScan.js');
const settings = await import('./settings.js');

beforeEach(() => {
  vi.clearAllMocks();
  transitionCase.mockImplementation(async (id, to, patch) => ({ id, state: to, ...patch }));
  listBrokers.mockResolvedValue([]);
  listBrokerCases.mockResolvedValue([]);
  getBroker.mockResolvedValue(null);
  createDraft.mockImplementation(async (d) => ({ id: 'draft-1', status: 'draft', ...d }));
  settings.getSettings.mockResolvedValue({ privacy: { recheck: {} } });
});

const SCAN_VALUES = [
  { type: 'legal_name', value: 'Jane Q Doe' },
  { type: 'email', value: 'jane@example.com' },
  { type: 'phone', value: '+1 503 555 0100' },
  { type: 'address', value: '1 Oak Ave, Portland, OR 97201', status: 'current' },
];

describe('buildDisclosurePayload', () => {
  it('populates only allowlisted keys from vault scan values', () => {
    const p = buildDisclosurePayload(SCAN_VALUES);
    expect(p).toEqual({ full_name: 'Jane Q Doe', email: 'jane@example.com', phone: '+1 503 555 0100', city: 'Portland', state: 'OR' });
    for (const k of Object.keys(p)) expect(DISCLOSURE_ALLOWLIST).toContain(k);
  });
  it('prefers a current address for city/state', () => {
    const p = buildDisclosurePayload([
      { type: 'legal_name', value: 'A B' },
      { type: 'address', value: 'Salem, OR', status: 'previous' },
      { type: 'address', value: 'Austin, TX', status: 'current' },
    ]);
    expect(p.city).toBe('Austin');
    expect(p.state).toBe('TX');
  });
  it('includes dob only when present as a scan value', () => {
    const p = buildDisclosurePayload([...SCAN_VALUES, { type: 'dob', value: '1990-01-01' }]);
    expect(p.dob).toBe('1990-01-01');
  });
});

describe('computeDisclosedFields — allowlist ∩ broker ∩ available', () => {
  const payload = { full_name: 'Jane Q Doe', email: 'jane@example.com', phone: '1', city: 'Portland', state: 'OR' };
  it('intersects the fixed allowlist with the broker declared fields we hold', () => {
    const broker = { disclosureFields: ['full_name', 'city', 'state', 'email', 'listing_url'] };
    expect(computeDisclosedFields(broker, payload)).toEqual(['full_name', 'email', 'city', 'state']);
  });
  it('adds listing_url only when the case has one', () => {
    const broker = { disclosureFields: ['full_name', 'listing_url'] };
    expect(computeDisclosedFields(broker, payload)).toEqual(['full_name']);
    expect(computeDisclosedFields(broker, payload, { listingUrls: ['https://x/1'] })).toEqual(['full_name', 'listing_url']);
  });
  it('never emits a field outside the allowlist even if the broker asks', () => {
    const broker = { disclosureFields: ['full_name', 'ssn', 'passport', 'mothers_maiden'] };
    const withEvil = { ...payload, ssn: '123', passport: 'X' };
    expect(computeDisclosedFields(broker, withEvil)).toEqual(['full_name']);
  });
});

describe('chooseLane', () => {
  it('email method with an address → email', () => {
    expect(chooseLane({ optout: { method: 'email', email: 'p@b.com' } })).toBe('email');
  });
  it('web_form method with a url → web_form', () => {
    expect(chooseLane({ optout: { method: 'web_form', url: 'https://b.com/optout' } })).toBe('web_form');
  });
  it('anti-bot walled form with an email fallback → email', () => {
    expect(chooseLane({ antibot: true, optout: { method: 'web_form', url: 'https://b.com/o', email: 'p@b.com' } })).toBe('email');
  });
  it('no channel → human', () => {
    expect(chooseLane({ optout: { method: 'fax' } })).toBe('human');
  });
});

describe('chooseEmailTemplate', () => {
  it('CA-address subject → ccpa', () => {
    expect(chooseEmailTemplate({ optout: { notes: '' } }, { state: 'CA' })).toBe('ccpa');
  });
  it('gdpr note wins', () => {
    expect(chooseEmailTemplate({ optout: { notes: 'Use the GDPR lane' } })).toBe('gdpr');
  });
  it('default generic', () => {
    expect(chooseEmailTemplate({ optout: { notes: '' } }, { state: 'OR' })).toBe('generic');
  });
});

describe('fillTemplate + renderOptOutEmail', () => {
  it('fills tokens and collapses unknowns', () => {
    expect(fillTemplate('Hi {{a}} / {{missing}}', { a: 'X' })).toBe('Hi X / ');
  });
  it('splits subject from body and injects disclosure', async () => {
    const templateLoader = async () => 'Subject: Opt-out for {{fullName}}\n\nBody\n{{disclosedSummary}}\n';
    const out = await renderOptOutEmail({
      broker: { name: 'Spokeo', disclosureFields: ['full_name', 'email'] },
      payload: { full_name: 'Jane Q Doe', email: 'jane@example.com' },
      disclosedFields: ['full_name', 'email'],
      templateLoader,
      now: new Date('2026-07-08T00:00:00Z'),
    });
    expect(out.subject).toBe('Opt-out for Jane Q Doe');
    expect(out.body).toContain('Full name: Jane Q Doe');
    expect(out.body).toContain('Email: jane@example.com');
    expect(out.body).not.toMatch(/^Subject:/m);
  });
});

describe('brokerDomains + scoreVerificationEmail (anti-phishing)', () => {
  const broker = { urls: { home: 'https://www.spokeo.com' }, optout: { url: 'https://www.spokeo.com/optout', email: 'privacy@spokeo.com' } };
  it('collects the broker domains', () => {
    expect(brokerDomains(broker)).toContain('spokeo.com');
  });
  it('trusts a confirmation email with a matching link domain', () => {
    const msg = { subject: 'Confirm your opt-out', body: 'Please click https://www.spokeo.com/confirm?t=abc to complete your removal.' };
    const s = scoreVerificationEmail(msg, broker);
    expect(s.isConfirmation).toBe(true);
    expect(s.verificationUrl).toContain('spokeo.com/confirm');
  });
  it('rejects a look-alike phishing domain', () => {
    const msg = { subject: 'Confirm your opt-out', body: 'Click https://spokeo-confirm.evil.com/x to complete.' };
    const s = scoreVerificationEmail(msg, broker);
    expect(s.isConfirmation).toBe(false);
    expect(s.reason).toBe('no_domain_match');
  });
  it('rejects a matching-domain email that is not a confirmation', () => {
    const msg = { subject: 'Your weekly newsletter', body: 'News from https://www.spokeo.com/blog' };
    expect(scoreVerificationEmail(msg, broker).isConfirmation).toBe(false);
  });
});

describe('planOptOutActions ordering', () => {
  it('cluster parents first, then found before indirect, then by name', () => {
    const cwb = [
      { case: { state: 'indirect_exposure' }, broker: { name: 'Zeta', clusterParent: null } },
      { case: { state: 'found' }, broker: { name: 'Beta', clusterParent: 'parent' } },
      { case: { state: 'found' }, broker: { name: 'Alpha', clusterParent: null } },
    ];
    const { submit } = planOptOutActions(cwb);
    expect(submit.map((s) => s.broker.name)).toEqual(['Alpha', 'Zeta', 'Beta']);
  });
  it('splits verify-poll states out', () => {
    const cwb = [
      { case: { state: 'submitted' }, broker: { name: 'A' } },
      { case: { state: 'found' }, broker: { name: 'B' } },
    ];
    const { submit, verify } = planOptOutActions(cwb);
    expect(submit).toHaveLength(1);
    expect(verify).toHaveLength(1);
  });
});

describe('emailLane', () => {
  const broker = { id: 'mylife', name: 'MyLife', optout: { method: 'email', email: 'privacy@mylife.com' }, disclosureFields: ['full_name', 'email'] };
  const payload = { full_name: 'Jane Q Doe', email: 'jane@example.com' };
  it('creates a draft locked to the broker address and transitions to submitted', async () => {
    const res = await emailLane(broker, { id: 'c1' }, { disclosedFields: ['full_name', 'email'], payload, autoApprove: false });
    expect(res.outcome).toBe('submitted');
    expect(createDraft).toHaveBeenCalledWith(expect.objectContaining({ to: ['privacy@mylife.com'], generatedBy: 'privacy-optout' }));
    expect(approveDraft).not.toHaveBeenCalled();
    const states = transitionCase.mock.calls.map((c) => c[1]);
    expect(states).toEqual(['optout_in_progress', 'submitted']);
  });
  it('auto-approves + sends when the toggle is on', async () => {
    const sender = vi.fn(async () => ({ success: true }));
    const res = await emailLane(broker, { id: 'c1' }, { disclosedFields: ['full_name', 'email'], payload, autoApprove: true, sender });
    expect(approveDraft).toHaveBeenCalledWith('draft-1');
    expect(sender).toHaveBeenCalledWith('draft-1');
    expect(res.sent).toBe(true);
  });
  it('queues a human task when the broker has no email', async () => {
    const res = await emailLane({ id: 'x', optout: {} }, { id: 'c1' }, { disclosedFields: ['full_name'], payload });
    expect(res.outcome).toBe('human_task_queued');
  });
});

describe('webFormLane', () => {
  const broker = { id: 'spokeo', name: 'Spokeo', optout: { method: 'web_form', url: 'https://www.spokeo.com/optout', playbook: ['step 1'] }, disclosureFields: ['full_name', 'email', 'listing_url'] };
  it('default (auto-submit off) → human_task_queued with the playbook', async () => {
    const res = await webFormLane(broker, { id: 'c1' }, { disclosedFields: ['full_name'], payload: {}, listingUrls: [], autoSubmit: false });
    expect(res.outcome).toBe('human_task_queued');
    expect(transitionCase).toHaveBeenCalledWith('c1', 'human_task_queued', expect.objectContaining({ channel: 'web_form' }));
  });
  it('auto-submit + anti-bot wall → blocked (never defeated)', async () => {
    const probe = vi.fn(async () => ({ outcome: 'blocked', evidence: { wall: 'captcha' } }));
    const res = await webFormLane(broker, { id: 'c1', state: 'found' }, { disclosedFields: ['full_name'], payload: {}, listingUrls: [], autoSubmit: true, probe });
    expect(res.outcome).toBe('blocked');
  });
  it('a reappeared case that hits a wall → human_task_queued (state machine safe)', async () => {
    const probe = vi.fn(async () => ({ outcome: 'blocked' }));
    const res = await webFormLane(broker, { id: 'c1', state: 'reappeared' }, { disclosedFields: ['full_name'], payload: {}, listingUrls: [], autoSubmit: true, probe });
    expect(res.outcome).toBe('human_task_queued');
  });
  it('auto-submit success → submitted', async () => {
    const probe = vi.fn(async () => ({ outcome: 'submitted', screenshot: 's.png' }));
    const res = await webFormLane(broker, { id: 'c1' }, { disclosedFields: ['full_name'], payload: {}, listingUrls: [], autoSubmit: true, probe });
    expect(res.outcome).toBe('submitted');
    const states = transitionCase.mock.calls.map((c) => c[1]);
    expect(states).toEqual(['optout_in_progress', 'submitted']);
  });
});

describe('runOptOutPass', () => {
  it('aborts when there is no scan-eligible name', async () => {
    const vault = await import('./privacyVault.js');
    vault.listScanEligibleValues.mockResolvedValueOnce([]);
    const res = await runOptOutPass({ runVerification: false });
    expect(res.reason).toBe('no_disclosure_identity');
  });
  it('routes a found email-broker through the email lane', async () => {
    const vault = await import('./privacyVault.js');
    vault.listScanEligibleValues.mockResolvedValue(SCAN_VALUES);
    listBrokers.mockResolvedValue([{ id: 'mylife', name: 'MyLife', optout: { method: 'email', email: 'privacy@mylife.com' }, disclosureFields: ['full_name', 'email'], clusterParent: null }]);
    listBrokerCases.mockResolvedValue([{ id: 'c1', brokerId: 'mylife', state: 'found', evidence: {} }]);
    const res = await runOptOutPass({ runVerification: false });
    expect(res.submitted[0].lane).toBe('email');
    expect(res.submitted[0].outcome).toBe('submitted');
  });
  it('reads autonomy toggles from settings', async () => {
    const vault = await import('./privacyVault.js');
    vault.listScanEligibleValues.mockResolvedValue(SCAN_VALUES);
    settings.getSettings.mockResolvedValue({ privacy: { recheck: { autoApproveOptOutEmails: true, autoSubmitWebForms: true } } });
    listBrokers.mockResolvedValue([]);
    listBrokerCases.mockResolvedValue([]);
    const res = await runOptOutPass({ runVerification: false });
    expect(res.autonomy).toEqual({ autoApprove: true, autoSubmit: true });
  });
});

describe('runVerificationPass', () => {
  it('advances submitted → verification_pending on a trusted confirmation', async () => {
    const broker = { id: 'spokeo', urls: { home: 'https://www.spokeo.com' }, optout: { url: 'https://www.spokeo.com/optout' } };
    getBroker.mockResolvedValue(broker);
    listBrokerCases
      .mockResolvedValueOnce([{ id: 'c1', brokerId: 'spokeo', state: 'submitted', evidence: {} }])
      .mockResolvedValueOnce([]); // no verification_pending/awaiting to re-scan
    const messagesProvider = vi.fn(async () => ({ messages: [{ id: 'm1', subject: 'Confirm your opt-out', body: 'Click https://www.spokeo.com/confirm to complete removal.' }] }));
    const res = await runVerificationPass({ messagesProvider });
    expect(res.advanced).toHaveLength(1);
    expect(transitionCase).toHaveBeenCalledWith('c1', 'verification_pending', expect.anything());
  });
  it('confirms removal only when a read-only re-scan returns not_found', async () => {
    const broker = { id: 'spokeo', urls: { search: 'https://www.spokeo.com/{firstName}-{lastName}/{state}' } };
    getBroker.mockResolvedValue(broker);
    const vault = await import('./privacyVault.js');
    vault.listScanEligibleValues.mockResolvedValue(SCAN_VALUES);
    listBrokerCases
      .mockResolvedValueOnce([]) // no submitted
      .mockResolvedValueOnce([{ id: 'c2', brokerId: 'spokeo', state: 'awaiting_processing', evidence: {} }]);
    const removalProbe = vi.fn(async () => ({ verdict: 'not_found' }));
    const res = await runVerificationPass({ removalProbe });
    expect(res.confirmed).toHaveLength(1);
    expect(transitionCase).toHaveBeenCalledWith('c2', 'confirmed_removed', expect.objectContaining({ viaRescan: true }));
  });
  it('leaves a still-listed case untouched', async () => {
    getBroker.mockResolvedValue({ id: 'spokeo', urls: { search: 'https://www.spokeo.com/{firstName}/{state}' } });
    const vault = await import('./privacyVault.js');
    vault.listScanEligibleValues.mockResolvedValue(SCAN_VALUES);
    listBrokerCases
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 'c3', brokerId: 'spokeo', state: 'verification_pending', evidence: {} }]);
    const removalProbe = vi.fn(async () => ({ verdict: 'found', found: true }));
    const res = await runVerificationPass({ removalProbe });
    expect(res.confirmed).toHaveLength(0);
  });
});

describe('getOptOutDigest', () => {
  it('aggregates human-task + blocked cases with playbook + reason', async () => {
    listBrokerCases.mockImplementation(async ({ state } = {}) => {
      if (state === 'human_task_queued') return [{ id: 'h1', brokerId: 'wp', brokerName: 'Whitepages', state, reason: 'auto_submit_disabled', evidence: { optout_url: 'https://wp/o', playbook: ['call back'] } }];
      if (state === 'blocked') return [{ id: 'b1', brokerId: 'rad', brokerName: 'Radaris', state, reason: 'antibot_wall', evidence: { search_url: 'https://rad/p/Jane/Doe/' } }];
      return [];
    });
    const digest = await getOptOutDigest();
    expect(digest.total).toBe(2);
    expect(digest.humanTasks).toBe(1);
    expect(digest.blocked).toBe(1);
    expect(digest.items[0].playbook).toEqual(['call back']);
    // Blocked items surface the filled search URL for a manual browser check.
    expect(digest.items[1].searchUrl).toBe('https://rad/p/Jane/Doe/');
  });
});
