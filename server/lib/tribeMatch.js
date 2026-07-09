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
