import { request } from './apiCore.js';

// Human-activity timeline (#2150). Day view + filtered event list.

export const getTimelineDay = (options = {}) => {
  const params = new URLSearchParams();
  if (options.date) params.set('date', options.date);
  const qs = params.toString();
  return request(`/timeline/day${qs ? `?${qs}` : ''}`, { silent: options.silent });
};

export const getTimelineEvents = (options = {}) => {
  const params = new URLSearchParams();
  if (options.from) params.set('from', options.from);
  if (options.to) params.set('to', options.to);
  if (options.source) params.set('source', options.source);
  if (options.kind) params.set('kind', options.kind);
  if (options.personId) params.set('personId', options.personId);
  if (options.limit) params.set('limit', String(options.limit));
  const qs = params.toString();
  return request(`/timeline/events${qs ? `?${qs}` : ''}`, { silent: options.silent });
};
