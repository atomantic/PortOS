/**
 * Identity resolution (#2415) — map a phone/email handle to a display name.
 *
 * Priority:
 *   1. Tribe person (phones[] / emails[]) — user-curated relationship graph
 *   2. macOS Contacts cache — AddressBook ingest
 *   3. null (caller falls back to raw handle)
 *
 * Pure given preloaded indexes; async helpers load Tribe + Contacts once.
 */
import {
  buildPersonMatchIndex,
  identityFromHandle,
  matchPerson,
  normalizeIdentifier,
  normalizePhone,
} from '../lib/tribeMatch.js';
import { loadContactIndex, resolveHandleAgainstContacts } from './contactsSync.js';

/**
 * Resolve one raw handle against tribe + contact indexes.
 * Returns:
 *   {
 *     displayName, organization?, personId?, contactId?,
 *     source: 'tribe' | 'contacts' | null,
 *     handle, phone?, email?
 *   }
 */
export function resolveHandle(handle, { tribeIndex, contactIndex } = {}) {
  const raw = handle == null ? '' : String(handle).trim();
  const identity = identityFromHandle(raw);
  const base = {
    handle: raw,
    phone: identity.phone || null,
    email: identity.email || null,
    displayName: null,
    organization: null,
    personId: null,
    contactId: null,
    source: null,
  };
  if (!raw) return base;

  if (tribeIndex) {
    const personId = matchPerson(identity, tribeIndex);
    if (personId) {
      const person = tribeIndex.byId?.get(personId);
      return {
        ...base,
        displayName: person?.name || raw,
        personId,
        source: 'tribe',
      };
    }
  }

  const fromContacts = resolveHandleAgainstContacts(raw, contactIndex);
  if (fromContacts) {
    return {
      ...base,
      displayName: fromContacts.displayName,
      organization: fromContacts.organization,
      contactId: fromContacts.contactId,
      source: 'contacts',
    };
  }

  return base;
}

/**
 * Best label for UI: resolved displayName, else organization, else raw handle.
 */
export function displayLabel(resolution, fallback = '') {
  if (resolution?.displayName) {
    if (resolution.organization && resolution.source === 'contacts'
      && resolution.displayName !== resolution.organization) {
      // "Jane Doe · Acme" when both person name and company exist
      // Keep simple: only append org when the display name looks like a person
      // (not already the org).
      return resolution.displayName;
    }
    return resolution.displayName;
  }
  if (resolution?.organization) return resolution.organization;
  return fallback || resolution?.handle || '';
}

/**
 * Load Tribe people + Contacts cache and build a combined resolver context.
 * `tribeIndex` includes `byId` for name lookup after matchPerson.
 */
export async function loadResolverContext() {
  const [{ listPeople }, contactBundle] = await Promise.all([
    import('./tribe.js'),
    loadContactIndex(),
  ]);
  const people = await listPeople().catch(() => []);
  const base = buildPersonMatchIndex(people);
  const byId = new Map(people.map((p) => [p.id, p]));
  return {
    people,
    tribeIndex: { ...base, byId },
    contactIndex: contactBundle.index,
    contacts: contactBundle.contacts,
    contactsSyncedAt: contactBundle.syncedAt,
  };
}

/**
 * Resolve many handles with one shared context (avoids N Tribe loads).
 */
export function resolveHandles(handles = [], ctx) {
  const out = new Map();
  for (const h of handles) {
    if (h == null || h === '') continue;
    if (out.has(h)) continue;
    out.set(h, resolveHandle(h, ctx));
  }
  return out;
}

/**
 * Enrich a conversation-like row that has `handle` / `title` / `participants`.
 */
export function enrichConversationRow(row, ctx) {
  if (!row) return row;
  const handle = row.handle || '';
  // Also try title when it looks like a handle (phone/email) and handle is empty.
  const probe = handle || (row.title && (row.title.includes('@') || /^\+?\d[\d\s().-]{6,}$/.test(row.title))
    ? row.title
    : '');
  const res = resolveHandle(probe, ctx);
  const label = displayLabel(res, row.title || handle || 'iMessage');
  // Prefer resolved name over a title that is just the raw handle.
  const titleIsHandle = row.title && (
    row.title === handle
    || row.title === res.phone
    || row.title === res.email
    || row.title === probe
  );
  return {
    ...row,
    title: (titleIsHandle || !row.title) ? label : row.title,
    displayName: label,
    organization: res.organization || null,
    personId: res.personId || null,
    contactId: res.contactId || null,
    identitySource: res.source,
    resolvedHandle: res.phone || res.email || handle || null,
  };
}

/**
 * Enrich activity events: attach counterpart displayName on participants + title.
 */
export function enrichActivityEvent(event, ctx) {
  if (!event) return event;
  const handle = event.metadata?.handle || '';
  const res = resolveHandle(handle, ctx);
  const participants = (event.participants || []).map((p) => {
    const key = p.phone || p.email || '';
    if (!key) return p;
    const pr = resolveHandle(key, ctx);
    if (!pr.displayName) return p;
    return {
      ...p,
      name: p.name || pr.displayName,
      personId: p.personId || pr.personId || undefined,
    };
  });
  const titleIsHandle = event.title && handle && (
    event.title === handle || event.title === res.phone || event.title === res.email
  );
  const label = displayLabel(res, event.title || handle || '');
  return {
    ...event,
    title: (titleIsHandle || !event.title) ? (label || event.title) : event.title,
    displayName: label || null,
    personId: res.personId || null,
    contactId: res.contactId || null,
    identitySource: res.source,
    participants,
  };
}

// Re-export normalize helpers used by tribe enrich.
export { normalizeIdentifier, normalizePhone, identityFromHandle };
