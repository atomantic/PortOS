import { request } from './apiCore.js';

export const BUCKET_MODES = Object.freeze(['auto-merge', 'inbox']);

// ---- Buckets ----
export const listShareBuckets = (options) => request('/sharing/buckets', options);

export const createShareBucket = (data, options) => request('/sharing/buckets', {
  method: 'POST',
  body: JSON.stringify(data),
  ...options,
});

export const updateShareBucket = (id, patch, options) => request(`/sharing/buckets/${encodeURIComponent(id)}`, {
  method: 'PUT',
  body: JSON.stringify(patch),
  ...options,
});

export const deleteShareBucket = (id, options) => request(`/sharing/buckets/${encodeURIComponent(id)}`, {
  method: 'DELETE',
  ...options,
});

// ---- Export ----
// body: { kind: 'series'|'universe'|'media', ids?: string[], items?: [{kind,ref}] }
export const exportToShareBucket = (bucketId, body, options) => request(`/sharing/buckets/${encodeURIComponent(bucketId)}/export`, {
  method: 'POST',
  body: JSON.stringify(body),
  ...options,
});

// ---- Inbox ----
export const listShareInbox = (bucketId, options) => request(`/sharing/buckets/${encodeURIComponent(bucketId)}/inbox`, options);

export const promoteShareInboxItem = (bucketId, manifestId, options) => request(
  `/sharing/buckets/${encodeURIComponent(bucketId)}/inbox/${encodeURIComponent(manifestId)}/promote`,
  { method: 'POST', ...options },
);

export const dismissShareInboxItem = (bucketId, manifestId, options) => request(
  `/sharing/buckets/${encodeURIComponent(bucketId)}/inbox/${encodeURIComponent(manifestId)}/dismiss`,
  { method: 'POST', ...options },
);

// ---- Activity ----
export const listShareActivity = (bucketId, options) => request(`/sharing/buckets/${encodeURIComponent(bucketId)}/activity`, options);

// ---- Subscriptions (persistent, kind=series|universe) ----
export const listShareSubscriptions = (filter = {}, options) => {
  const qs = new URLSearchParams();
  if (filter.bucketId) qs.set('bucketId', filter.bucketId);
  if (filter.recordKind) qs.set('recordKind', filter.recordKind);
  if (filter.recordId) qs.set('recordId', filter.recordId);
  const query = qs.toString();
  return request(`/sharing/subscriptions${query ? `?${query}` : ''}`, options);
};

export const subscribeToShareBucket = ({ bucketId, recordKind, recordId }, options) =>
  request('/sharing/subscriptions', {
    method: 'POST',
    body: JSON.stringify({ bucketId, recordKind, recordId }),
    ...options,
  });

export const unsubscribeFromShareBucket = (subscriptionId, options) =>
  request(`/sharing/subscriptions/${encodeURIComponent(subscriptionId)}`, {
    method: 'DELETE',
    ...options,
  });
