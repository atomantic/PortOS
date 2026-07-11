/**
 * Tribe ↔ Contacts bridge (#2415).
 *
 * - enrichTribeFromContacts: fill missing phones/emails on existing people
 *   when a Contacts record matches by phone, email, or exact unique name.
 * - suggestTribeImports: Contacts / iMessage handles not yet in Tribe.
 * - importContactToTribe: create a Tribe person from a cached contact.
 *
 * Never auto-dumps the whole address book into Tribe rings.
 */
import {
  buildPersonMatchIndex,
  matchPerson,
  normalizeIdentifier,
  normalizePhone,
  identityFromHandle,
} from '../lib/tribeMatch.js';
import { loadContactIndex } from './contactsSync.js';
import * as tribe from './tribe.js';
import * as humanActivity from './humanActivity.js';

function personMatchKeys(person) {
  const phones = new Set((person.phones || []).map(normalizePhone).filter(Boolean));
  const emails = new Set((person.emails || []).map(normalizeIdentifier).filter(Boolean));
  return { phones, emails };
}

/**
 * Match a contact to a tribe person: phone/email first, then exact unique name.
 */
export function matchContactToPerson(contact, tribeIndex) {
  for (const p of contact.phones || []) {
    const id = matchPerson({ phone: p }, tribeIndex);
    if (id) return id;
  }
  for (const e of contact.emails || []) {
    const id = matchPerson({ email: e }, tribeIndex);
    if (id) return id;
  }
  if (contact.displayName) {
    const id = matchPerson({ name: contact.displayName }, tribeIndex);
    if (id) return id;
  }
  return null;
}

/**
 * Compute phone/email fills for one person from a matched contact.
 * Returns null when nothing new would be added.
 */
export function computePhoneEmailFill(person, contact) {
  const { phones: haveP, emails: haveE } = personMatchKeys(person);
  const addPhones = (contact.phones || []).filter((p) => p && !haveP.has(p));
  const addEmails = (contact.emails || []).filter((e) => e && !haveE.has(e));
  if (addPhones.length === 0 && addEmails.length === 0) return null;
  return {
    phones: [...(person.phones || []), ...addPhones],
    emails: [...(person.emails || []), ...addEmails],
    addPhones,
    addEmails,
  };
}

/**
 * Scan Contacts cache and fill missing Tribe phones/emails.
 * `dryRun: true` returns planned changes without writing.
 */
export async function enrichTribeFromContacts({ dryRun = false } = {}) {
  const people = await tribe.listPeople();
  const { contacts } = await loadContactIndex();
  const tribeIndex = buildPersonMatchIndex(people);
  // byId for fill math
  const byId = new Map(people.map((p) => [p.id, p]));

  const planned = [];
  const claimed = new Set(); // personId already filled this pass

  for (const contact of contacts) {
    const personId = matchContactToPerson(contact, tribeIndex);
    if (!personId || claimed.has(personId)) continue;
    const person = byId.get(personId);
    if (!person) continue;
    const fill = computePhoneEmailFill(person, contact);
    if (!fill) continue;
    planned.push({
      personId,
      personName: person.name,
      contactId: contact.id,
      contactName: contact.displayName,
      addPhones: fill.addPhones,
      addEmails: fill.addEmails,
    });
    claimed.add(personId);
    if (!dryRun) {
      const updated = await tribe.updatePerson(personId, {
        phones: fill.phones,
        emails: fill.emails,
      });
      if (updated) byId.set(personId, updated);
    }
  }

  return {
    dryRun: Boolean(dryRun),
    matched: planned.length,
    updated: dryRun ? 0 : planned.length,
    changes: planned,
  };
}

/**
 * Suggest contacts that appear in iMessage activity but aren't in Tribe yet.
 * Ranked by event count (handle frequency).
 */
export async function suggestTribeImports({ limit = 50 } = {}) {
  const people = await tribe.listPeople();
  const tribeIndex = buildPersonMatchIndex(people);
  const { contacts, index: contactIndex } = await loadContactIndex();

  // Pull recent-ish imessage events for handle frequency (cap to keep it cheap).
  const events = await humanActivity.listEvents({ source: 'imessage', limit: 2000 });
  const handleCounts = new Map();
  for (const ev of events) {
    const h = ev.metadata?.handle;
    if (!h) continue;
    const key = normalizePhone(h) || normalizeIdentifier(h);
    if (!key) continue;
    // Skip handles already in Tribe.
    const id = identityFromHandle(h);
    if (matchPerson(id, tribeIndex)) continue;
    handleCounts.set(key, (handleCounts.get(key) || 0) + 1);
  }

  // Also surface contacts with phones/emails not in Tribe (even without iMessage).
  const suggestions = [];
  const seenContact = new Set();

  // From iMessage handles → contact or bare handle
  const sortedHandles = [...handleCounts.entries()].sort((a, b) => b[1] - a[1]);
  for (const [key, eventCount] of sortedHandles) {
    let contact = contactIndex.byPhone.get(key) || contactIndex.byEmail.get(key) || null;
    if (contact && seenContact.has(contact.id)) continue;
    if (contact) seenContact.add(contact.id);
    // If no contact, still suggest a bare-handle import shell.
    suggestions.push({
      contactId: contact?.id || null,
      displayName: contact?.displayName || key,
      organization: contact?.organization || null,
      phones: contact?.phones || (key.startsWith('+') ? [key] : []),
      emails: contact?.emails || (key.includes('@') ? [key] : []),
      handle: key,
      eventCount,
      reason: contact ? 'imessage+contacts' : 'imessage-only',
    });
    if (suggestions.length >= limit) break;
  }

  // Top up with unmatched contacts (no iMessage signal yet).
  if (suggestions.length < limit) {
    for (const c of contacts) {
      if (seenContact.has(c.id)) continue;
      if (matchContactToPerson(c, tribeIndex)) continue;
      if ((c.phones || []).length === 0 && (c.emails || []).length === 0) continue;
      seenContact.add(c.id);
      suggestions.push({
        contactId: c.id,
        displayName: c.displayName,
        organization: c.organization || null,
        phones: c.phones || [],
        emails: c.emails || [],
        handle: c.phones?.[0] || c.emails?.[0] || null,
        eventCount: 0,
        reason: 'contacts-only',
      });
      if (suggestions.length >= limit) break;
    }
  }

  return { suggestions, contactsCached: contacts.length, tribeCount: people.length };
}

/**
 * Create a Tribe person from a cached contact (or explicit payload).
 */
export async function importContactToTribe({
  contactId,
  name,
  phones,
  emails,
  organization,
  ring = 'tribe',
  relationship = '',
} = {}) {
  let contact = null;
  if (contactId) {
    const { contacts } = await loadContactIndex();
    contact = contacts.find((c) => c.id === contactId || c.uniqueId === contactId) || null;
  }
  const personName = String(name || contact?.displayName || organization || contact?.organization || '').trim();
  if (!personName) {
    const err = new Error('name is required');
    err.status = 400;
    err.code = 'BAD_REQUEST';
    throw err;
  }
  const personPhones = phones || contact?.phones || [];
  const personEmails = emails || contact?.emails || [];

  // Refuse duplicate: if any phone/email already maps to a person, return that person.
  const people = await tribe.listPeople();
  const tribeIndex = buildPersonMatchIndex(people);
  for (const p of personPhones) {
    const id = matchPerson({ phone: p }, tribeIndex);
    if (id) {
      const existing = people.find((x) => x.id === id);
      return { person: existing, created: false, reason: 'phone-match' };
    }
  }
  for (const e of personEmails) {
    const id = matchPerson({ email: e }, tribeIndex);
    if (id) {
      const existing = people.find((x) => x.id === id);
      return { person: existing, created: false, reason: 'email-match' };
    }
  }

  const notes = organization || contact?.organization
    ? `Imported from Contacts${(organization || contact?.organization) ? ` (${organization || contact.organization})` : ''}`
    : 'Imported from Contacts';

  const person = await tribe.createPerson({
    name: personName,
    ring,
    relationship: relationship || (organization || contact?.organization ? 'contact' : ''),
    phones: personPhones,
    emails: personEmails,
    notes,
    channel: 'iMessage',
  });
  return { person, created: true };
}
