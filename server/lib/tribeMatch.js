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
 * Build lookup indexes from a list of tribe people. Returns
 * `{ byIdentifier: Map<email, personId>, byName: Map<name, personId[]> }`.
 * The first person to claim an identifier wins (identifiers are meant to be
 * unique to one person); names collect every owner so ambiguity is detectable.
 */
export function buildPersonMatchIndex(people = []) {
  const byIdentifier = new Map();
  const byName = new Map();
  for (const person of people) {
    if (!person?.id) continue;
    for (const identifier of person.emails || []) {
      const key = normalizeIdentifier(identifier);
      if (key && !byIdentifier.has(key)) byIdentifier.set(key, person.id);
    }
    const nameKey = normalizeIdentifier(person.name);
    if (nameKey) {
      const owners = byName.get(nameKey) || [];
      owners.push(person.id);
      byName.set(nameKey, owners);
    }
  }
  return { byIdentifier, byName };
}

/**
 * Resolve a single `{ email, name }` identity to a personId, or `null`.
 * Email/handle wins; exact unique name is the fallback.
 */
export function matchPerson(identity, index) {
  if (!identity || !index) return null;
  const email = normalizeIdentifier(identity.email);
  if (email && index.byIdentifier.has(email)) return index.byIdentifier.get(email);
  const name = normalizeIdentifier(identity.name);
  if (name) {
    const owners = index.byName.get(name);
    if (owners && owners.length === 1) return owners[0];
  }
  return null;
}

/**
 * Resolve many identities (mixed `{ email, name }` objects or bare email/handle
 * strings) to a de-duplicated Set of personIds. A single event/message that
 * involves the same tracked person twice (organizer + attendee) yields one id.
 */
export function matchPeople(identities = [], index) {
  const ids = new Set();
  if (!index) return ids;
  for (const raw of identities) {
    if (!raw) continue;
    const identity = typeof raw === 'string' ? { email: raw } : raw;
    const id = matchPerson(identity, index);
    if (id) ids.add(id);
  }
  return ids;
}
