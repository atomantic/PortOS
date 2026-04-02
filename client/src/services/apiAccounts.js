import { request } from './apiCore.js';

// Platform Accounts
export const getPlatformAccounts = (agentId = null, platform = null) => {
  const params = new URLSearchParams();
  if (agentId) params.set('agentId', agentId);
  if (platform) params.set('platform', platform);
  const query = params.toString();
  return request(`/agents/accounts${query ? `?${query}` : ''}`);
};
export const getPlatformAccount = (id) => request(`/agents/accounts/${id}`);
export const createPlatformAccount = (data) => request('/agents/accounts', {
  method: 'POST',
  body: JSON.stringify(data)
});
export const registerPlatformAccount = (agentId, platform, name, description) => request('/agents/accounts', {
  method: 'POST',
  body: JSON.stringify({ agentId, platform, name, description })
});
export const deletePlatformAccount = (id) => request(`/agents/accounts/${id}`, { method: 'DELETE' });
export const testPlatformAccount = (id) => request(`/agents/accounts/${id}/test`, { method: 'POST' });
export const claimPlatformAccount = (id) => request(`/agents/accounts/${id}/claim`, { method: 'POST' });

// Agent Tools
export const generateAgentPost = (agentId, accountId, submolt, providerId, model) => request('/agents/tools/generate-post', {
  method: 'POST',
  body: JSON.stringify({ agentId, accountId, submolt, providerId, model })
});
export const generateAgentComment = (agentId, accountId, postId, parentId, providerId, model) => request('/agents/tools/generate-comment', {
  method: 'POST',
  body: JSON.stringify({ agentId, accountId, postId, parentId, providerId, model })
});
export const publishAgentPost = (agentId, accountId, submolt, title, content) => request('/agents/tools/publish-post', {
  method: 'POST',
  body: JSON.stringify({ agentId, accountId, submolt, title, content })
});
export const publishAgentComment = (agentId, accountId, postId, content, parentId) => request('/agents/tools/publish-comment', {
  method: 'POST',
  body: JSON.stringify({ agentId, accountId, postId, content, parentId })
});
export const engageAgent = (agentId, accountId, maxComments, maxVotes) => request('/agents/tools/engage', {
  method: 'POST',
  body: JSON.stringify({ agentId, accountId, maxComments, maxVotes })
});
export const getAgentFeed = (accountId, sort, limit) => {
  const params = new URLSearchParams({ accountId });
  if (sort) params.set('sort', sort);
  if (limit) params.set('limit', limit);
  return request(`/agents/tools/feed?${params}`);
};
export const getAgentRelevantPosts = (agentId, accountId, maxResults) => {
  const params = new URLSearchParams({ agentId, accountId });
  if (maxResults) params.set('maxResults', maxResults);
  return request(`/agents/tools/relevant-posts?${params}`);
};
export const getAgentSubmolts = (accountId) => request(`/agents/tools/submolts?accountId=${accountId}`);
export const getAgentPost = (accountId, postId) => request(`/agents/tools/post/${postId}?accountId=${accountId}`);
export const getAgentRateLimits = (accountId) => request(`/agents/tools/rate-limits?accountId=${accountId}`);
export const getAgentPublished = (agentId, accountId, days = 7) =>
  request(`/agents/tools/published?agentId=${agentId}&accountId=${accountId}&days=${days}`);
export const checkAgentPosts = (agentId, accountId, days, maxReplies, maxUpvotes) =>
  request('/agents/tools/check-posts', {
    method: 'POST',
    body: JSON.stringify({ agentId, accountId, days, maxReplies, maxUpvotes })
  });

// Moltworld Tools
export const moltworldJoin = (accountId, x, y, thinking, say, sayTo, agentId) =>
  request('/agents/tools/moltworld/join', {
    method: 'POST',
    body: JSON.stringify({ accountId, agentId, x, y, thinking, say, sayTo })
  });
export const moltworldBuild = (accountId, agentId, x, y, z, type, action) =>
  request('/agents/tools/moltworld/build', {
    method: 'POST',
    body: JSON.stringify({ accountId, agentId, x, y, z, type, action })
  });
export const moltworldExplore = (accountId, agentId, x, y, thinking) =>
  request('/agents/tools/moltworld/explore', {
    method: 'POST',
    body: JSON.stringify({ accountId, agentId, x, y, thinking })
  });
export const moltworldStatus = (accountId) =>
  request(`/agents/tools/moltworld/status?accountId=${accountId}`);
export const moltworldBalance = (accountId) =>
  request(`/agents/tools/moltworld/balance?accountId=${accountId}`);
export const moltworldRateLimits = (accountId) =>
  request(`/agents/tools/moltworld/rate-limits?accountId=${accountId}`);
export const moltworldThink = (accountId, thought, agentId) =>
  request('/agents/tools/moltworld/think', {
    method: 'POST',
    body: JSON.stringify({ accountId, agentId, thought })
  });
export const moltworldSay = (accountId, message, sayTo, agentId) =>
  request('/agents/tools/moltworld/say', {
    method: 'POST',
    body: JSON.stringify({ accountId, agentId, message, ...(sayTo ? { sayTo } : {}) })
  });

// Moltworld Action Queue
export const moltworldGetQueue = (agentId) =>
  request(`/agents/tools/moltworld/queue/${agentId}`);
export const moltworldAddToQueue = (agentId, actionType, params, scheduledFor) =>
  request('/agents/tools/moltworld/queue', {
    method: 'POST',
    body: JSON.stringify({ agentId, actionType, params, scheduledFor })
  });
export const moltworldRemoveFromQueue = (id) =>
  request(`/agents/tools/moltworld/queue/${id}`, { method: 'DELETE' });

// Moltworld WebSocket Relay
export const moltworldWsConnect = (accountId) =>
  request('/agents/tools/moltworld/ws/connect', {
    method: 'POST',
    body: JSON.stringify({ accountId })
  });
export const moltworldWsDisconnect = () =>
  request('/agents/tools/moltworld/ws/disconnect', { method: 'POST' });
export const moltworldWsStatus = () =>
  request('/agents/tools/moltworld/ws/status');
export const moltworldWsMove = (x, y, thought) =>
  request('/agents/tools/moltworld/ws/move', {
    method: 'POST',
    body: JSON.stringify({ x, y, ...(thought ? { thought } : {}) })
  });
export const moltworldWsThink = (thought) =>
  request('/agents/tools/moltworld/ws/think', {
    method: 'POST',
    body: JSON.stringify({ thought })
  });
export const moltworldWsNearby = (radius) =>
  request('/agents/tools/moltworld/ws/nearby', {
    method: 'POST',
    body: JSON.stringify({ ...(radius ? { radius } : {}) })
  });
export const moltworldWsInteract = (to, payload) =>
  request('/agents/tools/moltworld/ws/interact', {
    method: 'POST',
    body: JSON.stringify({ to, payload })
  });

// Agent Drafts
export const getAgentDrafts = (agentId) => request(`/agents/tools/drafts?agentId=${agentId}`);
export const createAgentDraft = (data) => request('/agents/tools/drafts', {
  method: 'POST',
  body: JSON.stringify(data)
});
export const updateAgentDraft = (agentId, draftId, data) => request(`/agents/tools/drafts/${draftId}?agentId=${agentId}`, {
  method: 'PUT',
  body: JSON.stringify(data)
});
export const deleteAgentDraft = (agentId, draftId) => request(`/agents/tools/drafts/${draftId}?agentId=${agentId}`, {
  method: 'DELETE'
});
