import { request } from './apiCore.js';

// Agent Personalities
export const getAgentPersonalities = (userId = null) => {
  const params = userId ? `?userId=${encodeURIComponent(userId)}` : '';
  return request(`/agents/personalities${params}`);
};
export const getAgentPersonality = (id) => request(`/agents/personalities/${id}`);
export const createAgentPersonality = (data) => request('/agents/personalities', {
  method: 'POST',
  body: JSON.stringify(data)
});
export const updateAgentPersonality = (id, data) => request(`/agents/personalities/${id}`, {
  method: 'PUT',
  body: JSON.stringify(data)
});
export const deleteAgentPersonality = (id) => request(`/agents/personalities/${id}`, { method: 'DELETE' });
export const toggleAgentPersonality = (id, enabled) => request(`/agents/personalities/${id}/toggle`, {
  method: 'POST',
  body: JSON.stringify({ enabled })
});
export const generateAgentPersonality = (seedData, providerId, model) => request('/agents/personalities/generate', {
  method: 'POST',
  body: JSON.stringify({ seed: seedData, providerId, model })
});
