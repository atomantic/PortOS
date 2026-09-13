import { request } from './apiCore.js';

// Decks — playing-card / tarot deck designer (Create → Decks). Decks are
// db-primary and machine-local; card images live in the shared gallery.
// `options` is forwarded to the request helper so callers that own their own
// error UI can pass `{ silent: true }`. Paths stay literal template strings so
// the client↔server route-parity scan can resolve every call site.

const json = (method, body) => ({ method, body: JSON.stringify(body ?? {}) });

export const listDecks = (options) => request('/decks', options);

export const getDeck = (id, options) => request(`/decks/${encodeURIComponent(id)}`, options);

export const createDeck = (data, options) => request('/decks', { ...json('POST', data), ...options });

export const updateDeck = (id, patch, options) =>
  request(`/decks/${encodeURIComponent(id)}`, { ...json('PATCH', patch), ...options });

export const deleteDeck = (id, options) =>
  request(`/decks/${encodeURIComponent(id)}`, { method: 'DELETE', ...options });

export const updateDeckCard = (id, cardId, patch, options) =>
  request(`/decks/${encodeURIComponent(id)}/cards/${encodeURIComponent(cardId)}`, { ...json('PATCH', patch), ...options });

// Stateless: returns `{ sample, proposed, diff, rationale, llm }` for review.
export const analyzeDeckSample = (id, { image, title, providerId, model, effort } = {}, options) =>
  request(`/decks/${encodeURIComponent(id)}/analyze-sample`, {
    ...json('POST', { image, title, providerId, model, effort }), ...options,
  });

// Persist a reviewed sample; `adopt` applies the proposed style guide too.
export const addDeckSample = (id, { sample, adopt } = {}, options) =>
  request(`/decks/${encodeURIComponent(id)}/samples`, { ...json('POST', { sample, adopt }), ...options });

export const removeDeckSample = (id, sampleId, options) =>
  request(`/decks/${encodeURIComponent(id)}/samples/${encodeURIComponent(sampleId)}`, { method: 'DELETE', ...options });

// Casting (universe-linked decks) + prompt writing. Returns
// `{ deck, written, requested, cast, llm }`.
export const generateDeckPrompts = (id, body = {}, options) =>
  request(`/decks/${encodeURIComponent(id)}/generate-prompts`, { ...json('POST', body), ...options });

// Batch render — `{ cardIds?, onlyMissing?, mode?, model?, seed? }` →
// `{ mode, jobs: [{ cardId, key, jobId }], skipped }`.
export const renderDeckCards = (id, body = {}, options) =>
  request(`/decks/${encodeURIComponent(id)}/render`, { ...json('POST', body), ...options });

export const renderDeckCard = (id, cardId, body = {}, options) =>
  request(`/decks/${encodeURIComponent(id)}/cards/${encodeURIComponent(cardId)}/render`, { ...json('POST', body), ...options });
