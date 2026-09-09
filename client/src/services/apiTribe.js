import { request } from './apiCore.js';

export const getTribePeople = (options = {}) => {
  const params = new URLSearchParams();
  if (options.search) params.set('search', options.search);
  if (options.ring && options.ring !== 'all') params.set('ring', options.ring);
  const qs = params.toString();
  return request(`/tribe/people${qs ? `?${qs}` : ''}`, { silent: options.silent });
};

// Emails/phones shared by more than one person (#5908) — a non-blocking report,
// never a merge. Read-only and cheap: safe to call on every Tribe page load.
export const getTribeDuplicateIdentifiers = (options = {}) =>
  request('/tribe/duplicate-identifiers', { silent: options.silent });

// Single-person read (#99) — the roster row from `getTribePeople` never carries
// `identities` (that join only runs on this single-person read), so the person
// form fetches this on select to render the "Linked on Beeper" block.
export const getTribePerson = (id, options = {}) =>
  request(`/tribe/people/${id}`, { silent: options.silent });

export const getTribeCareSummary = (options = {}) => {
  const params = new URLSearchParams();
  if (options.limit) params.set('limit', String(options.limit));
  const qs = params.toString();
  return request(`/tribe/care${qs ? `?${qs}` : ''}`, { silent: options.silent });
};

// `options` lets a caller suppress request()'s auto-toast with `{ silent: true }`
// when it already renders its own error UI.
export const createTribePerson = (data, options = {}) => request('/tribe/people', {
  method: 'POST',
  body: JSON.stringify(data),
  ...options,
});

export const updateTribePerson = (id, data, options = {}) => request(`/tribe/people/${id}`, {
  method: 'PUT',
  body: JSON.stringify(data),
  ...options,
});

export const deleteTribePerson = (id, options = {}) => request(`/tribe/people/${id}`, { method: 'DELETE', ...options });

export const getTribeTouchpoints = (personId, limit = 50) =>
  request(`/tribe/people/${personId}/touchpoints?limit=${limit}`);

export const createTribeTouchpoint = (personId, data = {}, options = {}) => request(`/tribe/people/${personId}/touchpoints`, {
  method: 'POST',
  body: JSON.stringify(data),
  ...options,
});

export const getTribeMemoryLinks = (personId) => request(`/tribe/people/${personId}/memories`);

export const linkTribeMemory = (personId, data, options = {}) => request(`/tribe/people/${personId}/memories`, {
  method: 'POST',
  body: JSON.stringify(data),
  ...options,
});

export const unlinkTribeMemory = (personId, memoryId, options = {}) =>
  request(`/tribe/people/${personId}/memories/${memoryId}`, { method: 'DELETE', ...options });

// Unanswered inbound threads from Tribe people, detected from the activity
// timeline (#2158). Read-only, no LLM.
export const getTribeOutreach = (options = {}) => {
  const params = new URLSearchParams();
  if (options.limit) params.set('limit', String(options.limit));
  const qs = params.toString();
  return request(`/tribe/outreach${qs ? `?${qs}` : ''}`, { silent: options.silent });
};

// Generate a grounded outreach draft for one detected thread (user-action-gated
// LLM call). Never sends — returns the filed draft for review.
export const generateTribeOutreachDraft = (seed, options = {}) =>
  request('/tribe/outreach/draft', {
    method: 'POST',
    body: JSON.stringify(seed),
    ...options,
  });

// Beeper participant → Tribe person (#34), called from the inline action on a
// thread participant (#35). `linkBeeperParticipant` never creates a person;
// `createTribePersonFromBeeper` does both in one step. The server derives the
// identity's network from the participant's own conversation — it is
// deliberately not a client-supplied field.
export const linkBeeperParticipant = ({ conversationId, sourceUserId, personId }, options = {}) =>
  request('/tribe/beeper/link', {
    method: 'POST',
    body: JSON.stringify({ conversationId, sourceUserId, personId }),
    ...options,
  });

export const createTribePersonFromBeeper = ({ conversationId, sourceUserId, name, ring, relationship }, options = {}) =>
  request('/tribe/beeper/link-new', {
    method: 'POST',
    body: JSON.stringify({ conversationId, sourceUserId, name, ring, relationship }),
    ...options,
  });

// Remove one Beeper identity claim from a person (#99) — the person form's
// "Linked on Beeper" block. `identityId` is a `tribe_identities.id` from that
// person's `identities[]`, not a participant key.
export const unlinkBeeperIdentity = (identityId, options = {}) =>
  request(`/tribe/beeper/identities/${identityId}`, { method: 'DELETE', ...options });

// Release a participant's link to whichever Tribe person currently owns it
// (#97 part B) — the counterpart `linkBeeperParticipant` never had. Idempotent:
// unlinking an already-unlinked participant is a 200 no-op, never an error.
export const unlinkBeeperParticipant = ({ conversationId, sourceUserId }, options = {}) =>
  request('/tribe/beeper/link', {
    method: 'DELETE',
    body: JSON.stringify({ conversationId, sourceUserId }),
    ...options,
  });
