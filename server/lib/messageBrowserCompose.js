// Confirmed draft delivery through the authenticated Outlook / Teams browser tab.
//
// Everything here is pure: it plans a delivery, builds the scripts the CDP page
// evaluates, and judges what the page reported. The I/O (finding the tab, running
// each phase, serializing sends) lives in `services/messagePlaywrightSync.js`.
//
// A browser submit has no idempotency key, so the contract is asymmetric:
//   - every phase BEFORE the single submit click is side-effect free (a failure
//     there is a definite "not sent" and the draft may be re-approved), and
//   - once the click has happened, anything short of a positive provider signal
//     is "delivery unknown" — never success, never an automatic retry.
import { readOutlookMessageRow } from './messageBrowserIdentity.js';

// Best-effort defaults for each provider's web UI. They are NOT validated against
// a live mailbox in this repository — the DOM changes without notice — so every
// key can be overridden per provider in the Messages selectors file
// (`data/messages/selectors.json`). A selector that stops matching degrades to a
// definite "control missing" failure before anything is sent.
export const COMPOSE_SELECTOR_DEFAULTS = Object.freeze({
  outlook: Object.freeze({
    accountIdentity: '#O365_MainLink_Me, button[aria-label^="Account manager"]',
    newMail: 'button[aria-label="New mail"]',
    replyButton: 'button[aria-label="Reply"]',
    composeBody: '[role="textbox"][aria-label="Message body"]',
    composeSend: 'button[aria-label="Send"]',
    composeDiscard: 'button[aria-label="Discard"]',
    composeSubject: 'input[aria-label="Add a subject"]',
    toField: '[aria-label="To"]',
    ccField: '[aria-label="Cc"]',
    showCc: 'button[aria-label="Cc"]'
  }),
  teams: Object.freeze({
    accountIdentity: 'button[aria-label^="Your profile"], [data-tid="me-control-avatar"]',
    newChat: 'button[aria-label="New chat"]',
    recipientInput: 'input[aria-label^="To"]',
    recipientSuggestion: '[role="option"]',
    composeBox: '[role="textbox"][aria-label^="Type a"]',
    composeSend: 'button[aria-label="Send"]',
    sentMessage: '[data-tid="chat-pane-message"]'
  })
});

// What the page says when a send went through / was refused. Matched against NEW
// live-region text only (anything already on screen before the click is ignored).
export const SEND_ACK_PATTERN = '(^|\\b)(message sent|your message (was|has been) sent|sent successfully)\\b';
export const SEND_REFUSAL_PATTERN = "couldn.?t send|could not send|failed to send|unable to send|didn.?t send|wasn.?t sent|not sent|try again";

export const SUBMIT_OBSERVE_MS = 20000;
// Must outlast the in-page observation window or a slow-but-successful send reads as a lost connection.
export const SUBMIT_EVALUATE_TIMEOUT_MS = SUBMIT_OBSERVE_MS + 10000;

/** Merge the stored per-provider overrides over the defaults. Unknown keys are ignored. */
export function resolveComposeConfig(provider, stored) {
  const defaults = COMPOSE_SELECTOR_DEFAULTS[provider];
  if (!defaults) return null;
  const override = key => (typeof stored?.[key] === 'string' && stored[key].trim() ? stored[key].trim() : null);
  const validPattern = key => {
    const candidate = override(key);
    if (!candidate) return null;
    try { new RegExp(candidate, 'i'); return candidate; } catch { return null; }
  };
  const sels = Object.fromEntries(Object.entries(defaults).map(([key, value]) => [key, override(key) ?? value]));
  return {
    sels,
    ackPattern: validPattern('sendAckPattern') ?? SEND_ACK_PATTERN,
    refusalPattern: validPattern('sendRefusalPattern') ?? SEND_REFUSAL_PATTERN
  };
}

const EMAIL_RE = /^[^\s<>@,;"]+@[^\s<>@,;"]+\.[^\s<>@,;"]+$/;

/** `Alice <alice@example.com>` / `alice@example.com` → lowercase address, else null. */
function normalizeEmail(value) {
  if (typeof value !== 'string') return null;
  const angle = value.match(/<([^<>]+)>\s*$/);
  const candidate = (angle ? angle[1] : value).trim().toLowerCase();
  return EMAIL_RE.test(candidate) ? candidate : null;
}

const asList = value => (Array.isArray(value) ? value : value ? [value] : []);
const unique = list => [...new Set(list)];

/**
 * Decide whether a browser-send draft can be delivered at all, and to whom —
 * BEFORE the draft is claimed, so a refusal leaves its approval intact.
 * `replyTarget` is the cached message the draft answers, already scoped to the
 * draft's own account by the caller. Returns `{ ok: true, plan }` or
 * `{ ok: false, status, code, error }`.
 */
export function planDelivery(accountType, draft, replyTarget = null) {
  const refuse = (status, code, error) => ({ ok: false, status, code, error });
  const isTeams = accountType === 'teams';
  if (!COMPOSE_SELECTOR_DEFAULTS[accountType]) {
    return refuse(501, 'SEND_NOT_SUPPORTED', "Sending from this account isn't supported yet — copy the draft");
  }
  const body = typeof draft.body === 'string' ? draft.body : '';
  if (!body.trim()) return refuse(400, 'DRAFT_NOT_DELIVERABLE', 'Draft has no message body');

  const to = asList(draft.to).map(normalizeEmail);
  const cc = asList(draft.cc).map(normalizeEmail);
  if (to.includes(null) || cc.includes(null)) {
    return refuse(400, 'DRAFT_NOT_DELIVERABLE', 'Recipients must be plain email addresses');
  }

  const isReply = Boolean(draft.replyToMessageId);
  if (isReply) {
    if (!replyTarget) return refuse(409, 'REPLY_TARGET_NOT_FOUND', 'The message this draft replies to is no longer in this account — sync and retry');
    if (draft.threadId && replyTarget.threadId && draft.threadId !== replyTarget.threadId) {
      return refuse(409, 'THREAD_MISMATCH', 'This draft does not belong to the thread of the message it replies to');
    }
    // Outlook replies are located by the provider's row id; a title match is a guess about whose mail to answer.
    if (!isTeams && !replyTarget.providerRowId) {
      return refuse(409, 'REPLY_TARGET_UNIDENTIFIABLE', 'This message has no provider identity yet — sync the account and retry');
    }
  }

  // An explicit recipient list wins; a bare reply answers the sender it was written for.
  const answered = isReply ? normalizeEmail(replyTarget.from?.email) : null;
  const recipients = unique(to.length ? to : answered ? [answered] : []);
  if (!recipients.length) return refuse(400, 'DRAFT_NOT_DELIVERABLE', 'Add a recipient email address before sending');
  if (isTeams && cc.length) return refuse(400, 'DRAFT_NOT_DELIVERABLE', 'Teams chats have no Cc — remove the Cc recipients');

  // A new Outlook message without a subject raises a confirmation dialog, which is
  // one more ambiguous step; a reply keeps the subject the provider already wrote.
  const subject = typeof draft.subject === 'string' ? draft.subject.trim() : '';
  if (!isTeams && !isReply && !subject) return refuse(400, 'DRAFT_NOT_DELIVERABLE', 'Add a subject before sending');

  return {
    ok: true,
    plan: {
      to: recipients,
      cc: unique(cc),
      subject,
      body,
      reply: isReply && !isTeams
        ? { providerRowId: replyTarget.providerRowId, subject: replyTarget.subject || '', from: replyTarget.from?.name || '' }
        : null
    }
  };
}

const sameSet = (a, b) => a.length === b.length && a.every(item => b.includes(item));

/** The recipients the page shows must be exactly the planned ones — no extras, none missing. */
export function recipientsMatch(plan, shown) {
  const to = unique(asList(shown?.to).map(normalizeEmail).filter(Boolean));
  const cc = unique(asList(shown?.cc).map(normalizeEmail).filter(Boolean));
  return sameSet(to, plan.to) && sameSet(cc, plan.cc);
}

/**
 * One tab serves one signed-in identity, but several accounts of a type can exist.
 * A visible identity that is not this account's is a definite refusal; an identity
 * the page does not reveal is only acceptable when no other account could be the
 * one signed in (`required` = more than one enabled account of this type).
 */
export function checkAccountIdentity({ expected, observed, required }) {
  const want = normalizeEmail(expected);
  const seen = asList(observed?.emails).map(normalizeEmail).filter(Boolean);
  if (want && seen.length) {
    return seen.includes(want) ? { ok: true } : { ok: false, code: 'ACCOUNT_IDENTITY_MISMATCH' };
  }
  return required ? { ok: false, code: 'ACCOUNT_IDENTITY_UNVERIFIED' } : { ok: true };
}

/**
 * Judge what the submit phase reported. `observed` is the page's return value, or
 * null when the evaluation was lost (timeout, closed socket, in-page exception) —
 * which cannot be told apart from "the click already happened".
 *   not_sent  — the page explicitly says it never clicked submit
 *   confirmed — the compose surface closed AND a fresh provider signal appeared
 *   refused   — the provider rejected it and the compose surface is still open
 *   unknown   — everything else after a click
 */
export function classifySendOutcome(observed) {
  if (!observed || typeof observed !== 'object') return { outcome: 'unknown' };
  if (observed.submitClicked === false) {
    return { outcome: 'not_sent', code: observed.code || 'CONTROL_MISSING', control: observed.control };
  }
  if (observed.submitClicked !== true) return { outcome: 'unknown' };
  if (observed.refusalSeen === true && observed.composeClosed !== true) return { outcome: 'refused' };
  if (observed.ackSeen === true && observed.composeClosed === true && observed.refusalSeen !== true) {
    return { outcome: 'confirmed' };
  }
  return { outcome: 'unknown' };
}

export const COMPOSE_PROVIDER_LABEL = Object.freeze({ outlook: 'Outlook', teams: 'Teams' });

/** Map a pre-submit in-page failure to the structured failure the sender returns. */
export function describeComposeFailure(provider, failure) {
  const label = COMPOSE_PROVIDER_LABEL[provider] || provider;
  // A lost evaluation (no result at all) says nothing about which control failed.
  if (!failure) return { status: 502, code: 'PROVIDER_TAB_UNAVAILABLE', error: `The ${label} tab did not respond — nothing was sent` };
  const code = failure.code;
  if (code === 'COMPOSE_BUSY') {
    return { status: 409, code: 'PROVIDER_COMPOSE_BUSY', error: `A ${label} compose window is already open in the browser — send or close it, then retry` };
  }
  if (code === 'REPLY_TARGET_UNLOCATED') {
    return { status: 409, code: 'REPLY_TARGET_UNLOCATED', error: `The original message is not visible in the open ${label} mailbox — open its folder, sync, and retry` };
  }
  if (code === 'RECIPIENT_UNRESOLVED') {
    return { status: 409, code: 'RECIPIENT_UNRESOLVED', error: `${label} could not resolve every recipient — nothing was sent` };
  }
  if (code === 'RECIPIENT_MISMATCH') {
    return { status: 409, code: 'RECIPIENT_MISMATCH', error: `${label} recipients do not match the approved draft — nothing was sent` };
  }
  if (code === 'CONTENT_MISMATCH') {
    return { status: 502, code: 'PROVIDER_CONTENT_MISMATCH', error: `${label} did not accept the approved text — nothing was sent` };
  }
  const control = failure.control ? ` (${failure.control})` : '';
  return { status: 502, code: 'PROVIDER_CONTROL_MISSING', error: `The ${label} page is missing a compose control${control} — update the Messages selectors; nothing was sent` };
}

// ── In-page code ────────────────────────────────────────────────────────────
// Each function below is serialized with toString() and evaluated inside the
// provider tab, so it must not close over module scope: every dependency arrives
// as an argument (`args` is JSON, never interpolated as executable text).

function pageHelpers() {
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const visible = el => Boolean(el) && el.isConnected && el.getClientRects().length > 0;
  const usable = el => visible(el) && !el.disabled && el.getAttribute('aria-disabled') !== 'true';
  // Exactly one usable match or nothing: an ambiguous control is never guessed at.
  const only = (scope, selector) => {
    const hits = [...scope.querySelectorAll(selector)].filter(usable);
    return hits.length === 1 ? hits[0] : null;
  };
  const waitFor = async (probe, timeoutMs = 10000) => {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const value = probe();
      if (value) return value;
      await sleep(150);
    }
    return null;
  };
  const norm = text => String(text || '').replace(/\s+/g, ' ').trim();
  const labelOf = el => [el.getAttribute('aria-label'), el.getAttribute('title'), el.innerText].filter(Boolean).join(' ');
  const emailsIn = scope => {
    const found = new Set();
    if (!scope) return [];
    const scan = text => {
      for (const match of String(text || '').match(/[^\s<>@,;"()]+@[^\s<>@,;"()]+\.[^\s<>@,;"()]+/g) || []) found.add(match.toLowerCase());
    };
    for (const el of [scope, ...scope.querySelectorAll('*')]) {
      scan(el.getAttribute('title'));
      scan(el.getAttribute('aria-label'));
      scan(el.getAttribute('data-email'));
    }
    scan(scope.innerText);
    return [...found];
  };
  const typeInto = (el, text) => {
    el.focus();
    document.execCommand('insertText', false, text);
  };
  const tagged = token => document.querySelector('[data-portos-send-token="' + token + '"]');
  return { sleep, visible, usable, only, waitFor, norm, labelOf, emailsIn, typeInto, tagged };
}

// Identity of whoever the tab is signed in as — read-only, runs before anything is touched.
async function probeIdentityInPage(args, h) {
  const el = document.querySelector(args.sels.accountIdentity);
  return { found: Boolean(el), emails: el ? h.emailsIn(el) : [] };
}

async function openComposeInPage(args, h, readRow) {
  const { provider, sels, token } = args;
  if (provider === 'outlook') {
    if (document.querySelector(sels.composeBody)) return { code: 'COMPOSE_BUSY' };
    if (args.reply) {
      const listbox = document.querySelector("[role='listbox']");
      if (!listbox || !args.reply.providerRowId) return { code: 'REPLY_TARGET_UNLOCATED' };
      const matches = () => [...listbox.querySelectorAll('[role="option"]')]
        .filter(row => readRow(row).providerRowId === args.reply.providerRowId);
      const scroller = listbox.closest('[role="region"]') || listbox.parentElement;
      let found = matches();
      for (let step = 0; step < 30 && found.length === 0 && scroller; step++) {
        scroller.scrollBy(0, 600);
        await h.sleep(300);
        found = matches();
      }
      if (found.length !== 1) return { code: 'REPLY_TARGET_UNLOCATED' };
      found[0].scrollIntoView({ block: 'center' });
      found[0].click();
      const reply = await h.waitFor(() => h.only(document, sels.replyButton));
      if (!reply) return { code: 'CONTROL_MISSING', control: 'replyButton' };
      reply.click();
    } else {
      const newMail = h.only(document, sels.newMail);
      if (!newMail) return { code: 'CONTROL_MISSING', control: 'newMail' };
      newMail.click();
    }
    const body = await h.waitFor(() => document.querySelector(sels.composeBody));
    if (!body) return { code: 'COMPOSE_NOT_OPENED' };
    // The compose surface is the nearest ancestor of the body that also holds Send.
    let root = body.parentElement;
    while (root && !root.querySelector(sels.composeSend)) root = root.parentElement;
    if (!root) return { code: 'CONTROL_MISSING', control: 'composeSend' };
    root.setAttribute('data-portos-send-token', token);
    return { ok: true };
  }

  // Teams: a new chat addressed by email, never the currently focused conversation.
  const existing = document.querySelector(sels.composeBox);
  if (existing && h.norm(existing.innerText)) return { code: 'COMPOSE_BUSY' };
  const newChat = h.only(document, sels.newChat);
  if (!newChat) return { code: 'CONTROL_MISSING', control: 'newChat' };
  newChat.click();
  const input = await h.waitFor(() => h.only(document, sels.recipientInput));
  if (!input) return { code: 'CONTROL_MISSING', control: 'recipientInput' };
  const resolved = [];
  for (const address of args.to) {
    h.typeInto(input, address);
    const option = await h.waitFor(() => {
      const hits = [...document.querySelectorAll(sels.recipientSuggestion)]
        .filter(el => {
          const emails = h.emailsIn(el);
          return h.visible(el) && emails.length === 1 && emails[0] === address;
        });
      return hits.length === 1 ? hits[0] : null;
    }, 6000);
    if (!option) return { code: 'RECIPIENT_UNRESOLVED' };
    option.click();
    resolved.push(...h.emailsIn(option));
    await h.sleep(300);
  }
  const box = await h.waitFor(() => h.only(document, sels.composeBox));
  if (!box) return { code: 'CONTROL_MISSING', control: 'composeBox' };
  box.setAttribute('data-portos-send-token', token);
  return { ok: true, resolved };
}

async function fillComposeInPage(args, h) {
  const { provider, sels, token } = args;
  const root = h.tagged(token);
  if (!root) return { code: 'COMPOSE_LOST' };
  const insertAtStart = (editor, text) => {
    editor.focus();
    const range = document.createRange();
    range.setStart(editor, 0);
    range.collapse(true);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    document.execCommand('insertText', false, text);
  };

  if (provider === 'teams') {
    insertAtStart(root, args.body);
    return { ok: true, bodyOk: h.norm(root.innerText).includes(h.norm(args.body)) };
  }

  const fieldInput = field => field.matches('input, [contenteditable="true"], [role="textbox"]')
    ? field : field.querySelector('input, [contenteditable="true"], [role="textbox"]');
  const addRecipients = async (selector, addresses) => {
    if (!addresses.length) return true;
    const field = root.querySelector(selector);
    const input = field && fieldInput(field);
    if (!input) return false;
    for (const address of addresses) {
      h.typeInto(input, address + ';');
      await h.sleep(250);
    }
    return true;
  };

  let subjectOk = true;
  if (!args.reply) {
    if (args.cc.length && !root.querySelector(sels.ccField)) {
      h.only(root, sels.showCc)?.click();
      await h.sleep(300);
    }
    if (!(await addRecipients(sels.toField, args.to))) return { code: 'CONTROL_MISSING', control: 'toField' };
    if (!(await addRecipients(sels.ccField, args.cc))) return { code: 'CONTROL_MISSING', control: 'ccField' };
    const subject = h.only(root, sels.composeSubject);
    if (!subject) return { code: 'CONTROL_MISSING', control: 'composeSubject' };
    subject.focus();
    subject.select?.();
    document.execCommand('insertText', false, args.subject);
    subjectOk = subject.value === args.subject;
  }

  const editor = root.querySelector(sels.composeBody);
  if (!editor) return { code: 'CONTROL_MISSING', control: 'composeBody' };
  insertAtStart(editor, args.body);
  return {
    ok: true,
    subjectOk,
    bodyOk: h.norm(editor.innerText).includes(h.norm(args.body)),
    to: h.emailsIn(root.querySelector(sels.toField)),
    cc: h.emailsIn(root.querySelector(sels.ccField))
  };
}

// The ONE place a message can leave. It clicks Send at most once and never throws
// after the click: whatever it saw is reported, and the caller judges it.
async function submitComposeInPage(args, h) {
  const { provider, sels, token } = args;
  const root = h.tagged(token);
  if (!root) return { submitClicked: false, code: 'COMPOSE_LOST' };
  const send = h.only(provider === 'teams' ? document : root, sels.composeSend);
  if (!send) return { submitClicked: false, code: 'CONTROL_MISSING', control: 'composeSend' };

  const ack = new RegExp(args.ackPattern, 'i');
  const refusal = new RegExp(args.refusalPattern, 'i');
  const liveTexts = () => [...document.querySelectorAll('[role="status"], [role="alert"], [aria-live="polite"], [aria-live="assertive"]')]
    .map(el => h.norm(el.innerText)).filter(Boolean);
  const textsBefore = new Set(liveTexts());
  const chatMessages = () => (provider === 'teams' ? [...document.querySelectorAll(sels.sentMessage)] : []);
  const messagesBefore = new Set(chatMessages());
  const needle = h.norm(args.body).slice(0, 120);

  send.click();
  const observed = { submitClicked: true, composeClosed: false, ackSeen: false, refusalSeen: false };
  try {
    const end = Date.now() + args.timeoutMs;
    while (Date.now() < end) {
      await h.sleep(200);
      const fresh = liveTexts().filter(text => !textsBefore.has(text));
      if (fresh.some(text => refusal.test(text))) observed.refusalSeen = true;
      if (provider === 'teams') {
        // Teams acknowledges by rendering our own message in the thread.
        const mine = chatMessages().filter(el => !messagesBefore.has(el) && h.norm(el.innerText).includes(needle));
        if (mine.length) observed.ackSeen = true;
        if (mine.some(el => refusal.test(h.norm(el.innerText)))) observed.refusalSeen = true;
        observed.composeClosed = !root.isConnected || h.norm(root.innerText) === '';
      } else {
        observed.composeClosed = !root.isConnected;
        if (fresh.some(text => ack.test(text))) observed.ackSeen = true;
      }
      if (observed.refusalSeen || (observed.ackSeen && observed.composeClosed)) break;
    }
  } catch {
    // Observation only — the click already happened, so report what was seen.
  }
  return observed;
}

// Only ever runs BEFORE the click: removes our own tagged compose surface.
async function discardComposeInPage(args, h) {
  const { provider, sels, token } = args;
  const root = h.tagged(token);
  if (!root) return { discarded: false };
  if (provider === 'teams') {
    root.focus();
    document.execCommand('selectAll');
    document.execCommand('delete');
    return { discarded: true };
  }
  const discard = h.only(root, sels.composeDiscard);
  if (!discard) return { discarded: false };
  discard.click();
  await h.sleep(500);
  const confirm = [...document.querySelectorAll('[role="dialog"] button, [role="alertdialog"] button')]
    .find(button => /^discard$/i.test(h.norm(button.innerText || button.getAttribute('aria-label'))));
  confirm?.click();
  return { discarded: true };
}

const PHASES = {
  probe: probeIdentityInPage,
  open: openComposeInPage,
  fill: fillComposeInPage,
  submit: submitComposeInPage,
  discard: discardComposeInPage
};

export const COMPOSE_PHASES = Object.freeze(Object.keys(PHASES));

/** Source for one CDP evaluation. `args` is serialized as JSON, never interpolated as code. */
export function buildComposePhaseScript(phase, args) {
  const run = PHASES[phase];
  if (!run) throw new Error(`Unknown compose phase: ${phase}`);
  return `(${run.toString()})(${JSON.stringify({ ...args, phase })}, (${pageHelpers.toString()})(), ${readOutlookMessageRow.toString()})`;
}
