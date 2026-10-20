// Pure helpers for server/scripts/moltworld-explore.mjs, kept importable so a test
// can pin that the Moltworld credential never reaches stdout or a PortOS URL.

/** Pick the active Moltworld account. `personalityId` is the PortOS agent the UI queues under. */
export function pickMoltworldAccount(accounts) {
  const account = Object.values(accounts || {}).find(a => a.platform === 'moltworld' && a.status === 'active');
  if (!account) return null;
  return {
    agentId: account.credentials.agentId || account.credentials.apiKey,
    personalityId: account.agentId,
    name: account.credentials.username || account.platformData?.registrationName || 'Explorer',
  };
}

export const buildQueueUrl = (base, personalityId) =>
  `${base}/api/agents/tools/moltworld/queue/${encodeURIComponent(personalityId)}`;

export const explorerBanner = (name) => `🌍 Moltworld Explorer — ${name}`;

/** Bearer header for PortOS API calls; empty when no instance password is set. */
export const portosAuthHeaders = (env = process.env) =>
  env.PORTOS_API_TOKEN ? { Authorization: `Bearer ${env.PORTOS_API_TOKEN}` } : {};
