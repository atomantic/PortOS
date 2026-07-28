import { request } from './apiCore.js';

export const listGames = (options = {}) => request('/games', options);
export const getGame = (id, options = {}) => request(`/games/${encodeURIComponent(id)}`, options);

export const createGame = (body, options = {}) => request('/games', {
  method: 'POST',
  body: JSON.stringify(body),
  ...options,
});

export const updateGame = (id, patch, options = {}) => request(`/games/${encodeURIComponent(id)}`, {
  method: 'PATCH',
  body: JSON.stringify(patch),
  ...options,
});

export const deleteGame = (id, options = {}) => request(`/games/${encodeURIComponent(id)}`, {
  method: 'DELETE',
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

export const unbindGameMusic = (id, bindingId, options = {}) => request(
  `/games/${encodeURIComponent(id)}/music/${encodeURIComponent(bindingId)}`,
  { method: 'DELETE', ...options },
);

export const compileGameAssets = (id, options = {}) => request(
  `/games/${encodeURIComponent(id)}/compile`,
  { method: 'POST', ...options },
);

export const requestGameFeedback = (id, body, options = {}) => request(
  `/games/${encodeURIComponent(id)}/feedback`,
  { method: 'POST', body: JSON.stringify(body), ...options },
);
