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
 * Normalize a phone handle to a stable E.164-ish key so a stored phone matches an iMessage/Signal handle (`chat.db` stores an email or an E.164 phone). Deterministic, no library: strip all but digits and a leading `+`;
 * a `+` country code passes through as `+<digits>`; a bare 11-digit US number starting with `1` and a bare 10-digit number (assumed NANP, `+1`) become `+1…`; anything else becomes `+<digits>` so two spellings still collide.
 * Returns `''` with no usable digits. An `@`-bearing value is NOT a phone; callers route it through `normalizeIdentifier`.
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

/** Classify a raw handle (iMessage/Signal `chat.db` `handle.id`, or a calendar/message counterpart) into `{ email, phone }`, exactly one set: a value containing `@` is an email, otherwise a phone. */
export function identityFromHandle(handle) {
  const raw = handle == null ? '' : String(handle).trim();
  if (!raw) return {};
  if (raw.includes('@')) return { email: normalizeIdentifier(raw) };
  const phone = normalizePhone(raw);
  return phone ? { phone } : {};
}

/**
 * Build lookup indexes from tribe people: `{ byIdentifier: Map<email, personId>, byPhone: Map<e164, personId>, byName: Map<name, personId[]> }`.
 * The first person to claim an identifier/phone wins (meant to be unique); names collect every owner so ambiguity is detectable.
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

/** Resolve one `{ email, phone, name }` identity to a personId or `null`: email/handle, then phone (E.164), then exact unique name. */
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

/** Resolve many identities (`{ email, phone, name }` objects or bare handle strings, classified via `identityFromHandle`) to a de-duplicated Set of personIds (organizer + attendee yield one id). */
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
// Network-scoped identity axis (#34, decided on #10): the `tribe_identities` (kind, network, handle) key, a THIRD axis separate from identityFromHandle, which classifies a bare string of unknown
// provenance by testing for `@` and so misclassifies a Matrix-style id like `@discord_123:beeper.com` as an email (#15, deferred to this work). These functions only see an already-scoped Beeper `handle`
// (`User.phoneNumber` or `User.username`, never `User.id`), so that collision doesn't apply; what does is #15's other finding: a digit-bearing non-phone handle must never collapse into a fabricated
// E.164 key. `classifyNetworkHandle` takes the phone branch only when the value contains NO letters, never merely "has enough digits".
// ---------------------------------------------------------------------------

// Lowercase, trim, strip a leading '@' (the normalization #10 specifies before tribe_identities).
export function normalizeNetworkHandle(value) {
  if (value == null) return '';
  return String(value).trim().toLowerCase().replace(/^@+/, '');
}

// Phone-SHAPED only when, after stripping spaces/hyphens/parens/dots and an optional leading '+', every character is a digit; any letter ("user5550100199") takes the 'handle' branch (the #15 hazard).
const PHONE_SHAPE_RE = /^\+?[0-9]+$/;
// E.164 numbers run ~7-15 digits (some Pacific island plans are 7). A shorter all-digit token (PIN-like username) is refused as a phone. Residual ambiguity for a long all-digit non-phone id
// (a Discord snowflake) is an accepted limit: nothing upstream feeds one through `handle` (source_user_id carries those).
const MIN_PHONE_DIGITS = 7;
const MAX_PHONE_DIGITS = 15;

/** Classify an already network-scoped Beeper handle (never a bare `User.id` / Matrix id) into the `tribe_identities` `{ kind, handle }` shape, or `null` when blank: `'phone'` (E.164 via normalizePhone) or `'handle'` (lowercased, trimmed, `@`-stripped). */
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

// Soft-delete parity: a `tribe_person_id` cache column reads as "linked" consistently wherever a beeper_participants row is shaped.

/**
 * A `beeper_participants.tribe_person_id` cache column plus the joined `tribe_people.deleted` flag, collapsed to ONE answer. `tribe.deletePerson` is a SOFT delete (the FK's ON DELETE CASCADE never fires),
 * so the raw column can point at a person who no longer counts. Both row shapers (`services/beeper/beeperConversations.js`, `services/beeper/beeperTribe.js`) call this so a soft-deleted link reads as unlinked everywhere (`null`,
 * never a dead id with no re-link affordance); extracted because two copies had drifted (one nulled the id, the other did not).
 */
export function resolveLinkedPersonId(tribePersonId, tribePersonDeleted) {
  return tribePersonId && !tribePersonDeleted ? tribePersonId : null;
}

/**
 * The idempotency key a calendar event carries on `tribe_touchpoints.dedupe_key`: ONE builder for the sync auto-logger (`calendarSync.js`) and the manual route (`tribe.createCalendarTouchpoint`) so a hand-logged
 * and a synced event collide on the unique index. Keyed on the provider id when present (the cache's `externalId || id` convention); null when the event has no usable id.
 */
export function calendarTouchpointDedupeKey(accountId, event) {
  const eventKey = event?.externalId || event?.id;
  return eventKey ? `cal:${accountId}:${eventKey}` : null;
}
