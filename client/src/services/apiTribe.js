import { request } from './apiCore.js';

export const getTribePeople = (options = {}) => {
  const params = new URLSearchParams();
  if (options.search) params.set('search', options.search);
  if (options.ring && options.ring !== 'all') params.set('ring', options.ring);
  const qs = params.toString();
  return request(`/tribe/people${qs ? `?${qs}` : ''}`, { silent: options.silent });
};

export const getTribeCareSummary = (options = {}) => {
  const params = new URLSearchParams();
  if (options.limit) params.set('limit', String(options.limit));
  const qs = params.toString();
  return request(`/tribe/care${qs ? `?${qs}` : ''}`, { silent: options.silent });
};

export const createTribePerson = (data) => request('/tribe/people', {
  method: 'POST',
  body: JSON.stringify(data),
});

export const updateTribePerson = (id, data) => request(`/tribe/people/${id}`, {
  method: 'PUT',
  body: JSON.stringify(data),
});

export const deleteTribePerson = (id) => request(`/tribe/people/${id}`, { method: 'DELETE' });

export const getTribeTouchpoints = (personId, limit = 50) =>
  request(`/tribe/people/${personId}/touchpoints?limit=${limit}`);

export const createTribeTouchpoint = (personId, data = {}) => request(`/tribe/people/${personId}/touchpoints`, {
  method: 'POST',
  body: JSON.stringify(data),
});

export const createTribeCalendarTouchpoint = (personId, data) =>
  request(`/tribe/people/${personId}/touchpoints/calendar`, {
    method: 'POST',
    body: JSON.stringify(data),
  });

export const getTribeMemoryLinks = (personId) => request(`/tribe/people/${personId}/memories`);

export const linkTribeMemory = (personId, data) => request(`/tribe/people/${personId}/memories`, {
  method: 'POST',
  body: JSON.stringify(data),
});

export const unlinkTribeMemory = (personId, memoryId) =>
  request(`/tribe/people/${personId}/memories/${memoryId}`, { method: 'DELETE' });
