/**
 * Tribe identity matcher — pure, deterministic mapping of a calendar attendee /
 * message counterpart ({ email, name }) back to a tracked Tribe person (#2033).
 *
 * Matching is intentionally deterministic (no LLM, no fuzzy string distance):
 *   1. Email / handle — authoritative. Compared case-insensitively against the
 *      identifiers the user stored on the person record (`person.emails`).
 *   2. Exact name — case-insensitive, and only when EXACTLY ONE tracked person
 *      owns that name (ambiguous names never resolve, so a shared first name can
 *      not mis-log). This is a convenience fallback before the user has recorded
 *      any emails; fuzzy name-matching is a separate consent-gated follow-up.
 */

export function normalizeIdentifier(value) {
  if (value == null) return '';
  return String(value).trim().toLowerCase();
}

/**
 * Normalize a phone handle to a stable E.164-ish key so a person's stored phone
 * matches an iMessage/Signal handle (`chat.db` stores handles as either an email
 * or an E.164 phone like `+15551234567`). Deterministic, no external library:
 *
 *   - strip every character except digits and a leading `+`;
 *   - a value that already carries a `+` country code passes through as `+<digits>`;
 *   - a bare 11-digit US number starting with `1` gets a `+` (`15551234567` → `+15551234567`);
 *   - a bare 10-digit US number is assumed NANP and prefixed `+1` (`5551234567` → `+15551234567`);
 *   - anything else (already-international bare digits, short codes) is returned as
 *     `+<digits>` so two spellings of the same number still collide.
 *
 * Returns `''` when there is no usable digit sequence. An `@`-bearing value is NOT
 * a phone — callers route those through `normalizeIdentifier` (email path) instead.
 */
export function normalizePhone(value) {
  if (value == null) return '';
  const raw = String(value).trim();
  if (!raw || raw.includes('@')) return '';
  const hasPlus = raw.startsWith('+');
  const digits = raw.replace(/\D/g, '');
  if (!digits) return '';
  if (hasPlus) return `+${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  return `+${digits}`;
}

/**
 * Classify a raw handle (from an iMessage/Signal `chat.db` `handle.id`, or a
 * calendar/message counterpart) into `{ email, phone }` — exactly one is set.
 * A value containing `@` is an email; otherwise it's treated as a phone.
 */
export function identityFromHandle(handle) {
  const raw = handle == null ? '' : String(handle).trim();
  if (!raw) return {};
  if (raw.includes('@')) return { email: normalizeIdentifier(raw) };
  const phone = normalizePhone(raw);
  return phone ? { phone } : {};
}

/**
 * Build lookup indexes from a list of tribe people. Returns
 * `{ byIdentifier: Map<email, personId>, byPhone: Map<e164, personId>, byName: Map<name, personId[]> }`.
 * The first person to claim an identifier/phone wins (they're meant to be unique
 * to one person); names collect every owner so ambiguity is detectable.
 */
export function buildPersonMatchIndex(people = []) {
  const byIdentifier = new Map();
  const byPhone = new Map();
  const byName = new Map();
  for (const person of people) {
    if (!person?.id) continue;
    for (const identifier of person.emails || []) {
      const key = normalizeIdentifier(identifier);
      if (key && !byIdentifier.has(key)) byIdentifier.set(key, person.id);
    }
    for (const rawPhone of person.phones || []) {
      const key = normalizePhone(rawPhone);
      if (key && !byPhone.has(key)) byPhone.set(key, person.id);
    }
    const nameKey = normalizeIdentifier(person.name);
    if (nameKey) {
      const owners = byName.get(nameKey) || [];
      owners.push(person.id);
      byName.set(nameKey, owners);
    }
  }
  return { byIdentifier, byPhone, byName };
}

/**
 * Resolve a single `{ email, phone, name }` identity to a personId, or `null`.
 * Email/handle wins, then phone (E.164-normalized), then exact unique name.
 */
export function matchPerson(identity, index) {
  if (!identity || !index) return null;
  const email = normalizeIdentifier(identity.email);
  if (email && index.byIdentifier.has(email)) return index.byIdentifier.get(email);
  const phone = normalizePhone(identity.phone);
  if (phone && index.byPhone?.has(phone)) return index.byPhone.get(phone);
  const name = normalizeIdentifier(identity.name);
  if (name) {
    const owners = index.byName.get(name);
    if (owners && owners.length === 1) return owners[0];
  }
  return null;
}

/**
 * Resolve many identities (mixed `{ email, phone, name }` objects or bare
 * email/handle strings) to a de-duplicated Set of personIds. A single
 * event/message that involves the same tracked person twice (organizer +
 * attendee) yields one id. A bare string is classified as email-or-phone via
 * `identityFromHandle`, so a raw `+15551234567` handle resolves by phone.
 */
export function matchPeople(identities = [], index) {
  const ids = new Set();
  if (!index) return ids;
  for (const raw of identities) {
    if (!raw) continue;
    const identity = typeof raw === 'string' ? identityFromHandle(raw) : raw;
    const id = matchPerson(identity, index);
    if (id) ids.add(id);
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Network-scoped identity axis (#34, decided on #10) — the `tribe_identities`
// table's (kind, network, handle) key. This is a THIRD axis, deliberately
// separate from identityFromHandle above: identityFromHandle classifies a bare
// string of unknown provenance (an iMessage/Signal `chat.db` handle) by
// testing for `@`, which is exactly what makes it misclassify a Matrix-style
// id like `@discord_123:beeper.com` as an email (#15 — closed as
// "not reachable from any live iMessage/Signal caller", but explicitly
// deferred to this identity work rather than fixed in place).
//
// The functions below never see a raw source_user_id / Matrix id — callers
// pass an already-scoped Beeper `handle` value (`User.phoneNumber` or
// `User.username`, never `User.id`), so the `@`-vs-Matrix collision does not
// apply here. What DOES apply, and what these functions guard against, is
// #15's other finding: a digit-bearing (but non-phone) handle must never
// collapse into a fabricated E.164 key. `classifyNetworkHandle` only takes the
// phone branch when the value contains NO letters at all — a plausible
// phone-shaped string — never merely "has enough digits".
// ---------------------------------------------------------------------------

// Lowercase, trim, strip a leading '@' — the normalization #10 specifies for
// a network handle before it reaches tribe_identities.
export function normalizeNetworkHandle(value) {
  if (value == null) return '';
  return String(value).trim().toLowerCase().replace(/^@+/, '');
}

// A string is phone-SHAPED only when, after stripping spaces/hyphens/
// parens/dots and an optional leading '+', every remaining character is a
// digit. Any letter (a Discord/Slack/X username, "user5550100199") takes the
// 'handle' branch instead — the #15 hazard, guarded here rather than reusing
// normalizePhone's bare "strip everything but digits" behavior blind to
// letters.
const PHONE_SHAPE_RE = /^\+?[0-9]+$/;
// Real-world E.164 numbers run roughly 7-15 digits (a handful of short-country
// numbers, e.g. some Pacific island plans, are as short as 7). A shorter
// all-digit token (a PIN-like username) is refused as a phone rather than
// fabricating an implausible key — residual ambiguity for a genuinely long
// all-digit non-phone id (a full Discord snowflake) is an accepted,
// documented limit: nothing upstream is expected to feed one through `handle`
// (source_user_id carries those, and is never routed through this function).
const MIN_PHONE_DIGITS = 7;
const MAX_PHONE_DIGITS = 15;

/**
 * Classify an already network-scoped Beeper handle (`User.phoneNumber` or
 * `User.username` — never a bare `User.id` / Matrix id) into the
 * `tribe_identities` `{ kind, handle }` shape, or `null` for a blank value.
 * `kind` is `'phone'` (handle normalized E.164 via normalizePhone) or
 * `'handle'` (lowercased/trimmed/`@`-stripped username).
 */
export function classifyNetworkHandle(value) {
  const raw = value == null ? '' : String(value).trim();
  if (!raw) return null;
  const stripped = raw.replace(/[\s().-]/g, '');
  if (PHONE_SHAPE_RE.test(stripped)) {
    const digits = stripped.replace(/^\+/, '');
    if (digits.length >= MIN_PHONE_DIGITS && digits.length <= MAX_PHONE_DIGITS) {
      const phone = normalizePhone(stripped);
      if (phone) return { kind: 'phone', handle: phone };
    }
  }
  const handle = normalizeNetworkHandle(raw);
  return handle ? { kind: 'handle', handle } : null;
}

// ---------------------------------------------------------------------------
// Soft-delete parity — a `tribe_person_id` cache column reads as "linked"
// consistently everywhere a beeper_participants row is shaped.
// ---------------------------------------------------------------------------

/**
 * A `beeper_participants.tribe_person_id` cache column, plus the joined
 * `tribe_people.deleted` flag it was read alongside, collapsed to ONE answer.
 * `tribe.deletePerson` is a SOFT delete — it never fires the FK's ON DELETE
 * CASCADE — so the raw column can go on pointing at a person who no longer
 * counts as one. Every reader of a participant row (the conversation/list
 * shaper in `services/beeperConversations.js`, and `services/beeperTribe.js`'s
 * own row shaper) calls this SAME function so a soft-deleted link reads as
 * unlinked everywhere at once: `null`, never a dead id with no re-link
 * affordance in the UI. Extracted here rather than duplicated in both
 * services precisely because two independent copies had already drifted —
 * one nulled the id, the other did not.
 */
export function resolveLinkedPersonId(tribePersonId, tribePersonDeleted) {
  return tribePersonId && !tribePersonDeleted ? tribePersonId : null;
}
