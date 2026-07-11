import { request } from './apiCore.js';

// Messages
export const getMessageAccounts = () => request('/messages/accounts');
export const createMessageAccount = (data) => request('/messages/accounts', { method: 'POST', body: JSON.stringify(data) });
export const updateMessageAccount = (id, data) => request(`/messages/accounts/${id}`, { method: 'PUT', body: JSON.stringify(data) });
export const deleteMessageAccount = (id) => request(`/messages/accounts/${id}`, { method: 'DELETE' });
export const syncMessageAccount = (accountId, mode = 'unread', options = {}) => request(`/messages/sync/${accountId}`, { method: 'POST', body: JSON.stringify({ mode }), ...options });
export const getMessageSyncStatus = (accountId) => request(`/messages/sync/${accountId}/status`);
export const evaluateMessages = (data = {}) => request('/messages/evaluate', { method: 'POST', body: JSON.stringify(data) });
export const getMessageInbox = (params = {}) => {
  const qs = new URLSearchParams();
  if (params.accountId) qs.set('accountId', params.accountId);
  if (params.search) qs.set('search', params.search);
  if (params.limit) qs.set('limit', params.limit);
  if (params.offset) qs.set('offset', params.offset);
  const str = qs.toString();
  return request(`/messages/inbox${str ? `?${str}` : ''}`);
};
export const getMessageDetail = (accountId, messageId) => request(`/messages/${accountId}/${messageId}`);
export const getMessageThread = (accountId, threadId) => request(`/messages/thread/${accountId}/${threadId}`);
export const getMessageDrafts = (params = {}) => {
  const qs = new URLSearchParams();
  if (params.accountId) qs.set('accountId', params.accountId);
  if (params.status) qs.set('status', params.status);
  const str = qs.toString();
  return request(`/messages/drafts${str ? `?${str}` : ''}`);
};
export const createMessageDraft = (data) => request('/messages/drafts', { method: 'POST', body: JSON.stringify(data) });
export const generateMessageDraft = (data) => request('/messages/drafts/generate', { method: 'POST', body: JSON.stringify(data) });
export const updateMessageDraft = (id, data) => request(`/messages/drafts/${id}`, { method: 'PUT', body: JSON.stringify(data) });
export const approveMessageDraft = (id) => request(`/messages/drafts/${id}/approve`, { method: 'POST' });
export const sendMessageDraft = (id) => request(`/messages/drafts/${id}/send`, { method: 'POST' });
export const deleteMessageDraft = (id) => request(`/messages/drafts/${id}`, { method: 'DELETE' });
export const getMessageSelectors = () => request('/messages/selectors');
export const updateMessageSelectors = (provider, selectors) => request(`/messages/selectors/${provider}`, { method: 'PUT', body: JSON.stringify({ selectors }) });
export const testMessageSelectors = (provider) => request(`/messages/selectors/${provider}/test`, { method: 'POST' });
export const launchMessageBrowser = (accountId) => request(`/messages/launch/${accountId}`, { method: 'POST' });
export const refreshMessage = (accountId, messageId) =>
  request(`/messages/${accountId}/${messageId}/refresh`, { method: 'POST' });
export const fetchFullContent = (accountId, { force } = {}) =>
  request(`/messages/fetch-full/${accountId}`, { method: 'POST', body: force ? JSON.stringify({ force: true }) : undefined });
export const executeMessageAction = (accountId, messageId, action, options = {}) =>
  request(`/messages/${accountId}/${messageId}/action`, { method: 'POST', body: JSON.stringify({ action }), silent: true, ...options });
export const clearMessageCache = (accountId) =>
  request(`/messages/accounts/${accountId}/cache/clear`, { method: 'POST' });
export const enableGmailApi = () => request('/messages/gmail/enable-api', { method: 'POST' });

// iMessage ingestion (#2151) — read-only chat.db sync, tribe + timeline feed.
export const getImessageStatus = (options = {}) => request('/imessage/status', options);
export const checkImessageSetup = (options = {}) => request('/imessage/setup-check', options);
export const syncImessage = (options = {}) => request('/imessage/sync', { method: 'POST', ...options });

// iMessage manager (#2413) — PortOS-side browse / purge / blocklist (never writes chat.db).
export const getImessageStats = (options = {}) => request('/imessage/stats', options);
export const getImessageConversations = ({ q, limit, silent } = {}) => {
  const params = new URLSearchParams();
  if (q) params.set('q', q);
  if (limit) params.set('limit', String(limit));
  const qs = params.toString();
  return request(`/imessage/conversations${qs ? `?${qs}` : ''}`, { silent });
};
export const getImessageConversationEvents = (chatKey, { limit, before, silent } = {}) => {
  const params = new URLSearchParams();
  if (limit) params.set('limit', String(limit));
  if (before) params.set('before', before);
  const qs = params.toString();
  return request(`/imessage/conversations/${encodeURIComponent(chatKey)}/events${qs ? `?${qs}` : ''}`, { silent });
};
export const purgeImessageConversation = (chatKey, options = {}) =>
  request(`/imessage/conversations/${encodeURIComponent(chatKey)}`, { method: 'DELETE', ...options });
export const deleteImessageEvent = (id, options = {}) =>
  request(`/imessage/events/${encodeURIComponent(id)}`, { method: 'DELETE', ...options });
export const getImessageBlocklist = (options = {}) => request('/imessage/blocklist', options);
export const setImessageBlocklist = (handles, options = {}) =>
  request('/imessage/blocklist', { method: 'PUT', body: JSON.stringify({ handles }), ...options });
export const addImessageBlocklist = (handles, { purgeExisting = false, ...options } = {}) =>
  request('/imessage/blocklist', {
    method: 'POST',
    body: JSON.stringify({ handles, purgeExisting }),
    ...options,
  });
export const removeImessageBlocklist = (handle, options = {}) =>
  request(`/imessage/blocklist/${encodeURIComponent(handle)}`, { method: 'DELETE', ...options });

// Feeds - RSS/Atom Feed Ingestion
export const getFeeds = () => request('/feeds');
export const getFeedStats = (options = {}) => request('/feeds/stats', options);
export const getFeedItems = ({ feedId, unreadOnly } = {}) => {
  const params = new URLSearchParams();
  if (feedId) params.set('feedId', feedId);
  if (unreadOnly) params.set('unreadOnly', 'true');
  return request(`/feeds/items?${params}`);
};
export const addFeed = (url) => request('/feeds', {
  method: 'POST',
  body: JSON.stringify({ url })
});
export const removeFeed = (id) => request(`/feeds/${id}`, { method: 'DELETE' });
export const refreshFeed = (id) => request(`/feeds/${id}/refresh`, { method: 'POST' });
export const refreshAllFeeds = () => request('/feeds/refresh-all', { method: 'POST' });
export const markFeedItemRead = (id) => request(`/feeds/items/${id}/read`, { method: 'POST' });
export const markAllFeedItemsRead = (feedId) => {
  const params = feedId ? `?feedId=${feedId}` : '';
  return request(`/feeds/items/read-all${params}`, { method: 'POST' });
};
