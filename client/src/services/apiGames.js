import { request } from './apiCore.js';

export const listGames = (options = {}) => request('/games', options);
export const getGame = (id, options = {}) => request(`/games/${encodeURIComponent(id)}`, options);
export const getGameIntegrity = (id, options = {}) =>
  request(`/games/${encodeURIComponent(id)}/integrity`, options);

export const createGame = (body, options = {}) => request('/games', {
  method: 'POST',
  body: JSON.stringify(body),
  ...options,
});

export const bindGameSprite = (id, spriteId, options = {}) => request(
  `/games/${encodeURIComponent(id)}/sprites`,
  { method: 'POST', body: JSON.stringify({ spriteId }), ...options },
);

export const unbindGameSprite = (id, spriteId, options = {}) => request(
  `/games/${encodeURIComponent(id)}/sprites/${encodeURIComponent(spriteId)}`,
  { method: 'DELETE', ...options },
);

export const bindGameMusic = (id, trackId, options = {}) => request(
  `/games/${encodeURIComponent(id)}/music`,
  { method: 'POST', body: JSON.stringify({ trackId }), ...options },
);

export const updateGameMusic = (id, bindingId, patch, options = {}) => request(
  `/games/${encodeURIComponent(id)}/music/${encodeURIComponent(bindingId)}`,
  { method: 'PATCH', body: JSON.stringify(patch), ...options },
);

export const unbindGameMusic = (id, bindingId, options = {}) => request(
  `/games/${encodeURIComponent(id)}/music/${encodeURIComponent(bindingId)}`,
  { method: 'DELETE', ...options },
);

// Pass { acknowledgeOverwrite: true } after a 409 PUBLISH_DEST_OCCUPIED to
// consent to replacing destination bytes PortOS never published.
export const publishGameMusic = (id, bindingId, body = {}, options = {}) => request(
  `/games/${encodeURIComponent(id)}/music/${encodeURIComponent(bindingId)}/publish`,
  { method: 'POST', body: JSON.stringify(body), ...options },
);

export const bindGameArtwork = (id, binding, options = {}) => request(
  `/games/${encodeURIComponent(id)}/artwork`,
  { method: 'POST', body: JSON.stringify(binding), ...options },
);

export const updateGameArtwork = (id, bindingId, patch, options = {}) => request(
  `/games/${encodeURIComponent(id)}/artwork/${encodeURIComponent(bindingId)}`,
  { method: 'PATCH', body: JSON.stringify(patch), ...options },
);

export const unbindGameArtwork = (id, bindingId, options = {}) => request(
  `/games/${encodeURIComponent(id)}/artwork/${encodeURIComponent(bindingId)}`,
  { method: 'DELETE', ...options },
);

export const publishGameArtwork = (id, bindingId, body = {}, options = {}) => request(
  `/games/${encodeURIComponent(id)}/artwork/${encodeURIComponent(bindingId)}/publish`,
  { method: 'POST', body: JSON.stringify(body), ...options },
);

export const compileGameAssets = (id, options = {}) => request(
  `/games/${encodeURIComponent(id)}/compile`,
  { method: 'POST', ...options },
);

export const requestGameFeedback = (id, body, options = {}) => request(
  `/games/${encodeURIComponent(id)}/feedback`,
  { method: 'POST', body: JSON.stringify(body), ...options },
);
