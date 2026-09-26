import {
  buildCapabilityRows,
  summarizeCapabilities,
  summarizeSetupCapabilities,
} from '../lib/capabilityMap.js';
import { getAllProviders, getProviderById } from './providers.js';
import { getProviderPrerequisiteReadinessMap } from './providerPrerequisites.js';
import { getProviderReadinessMap } from './providerReadiness.js';
import { getAllProviderStatuses } from './providerStatus.js';
import { listAccounts as listCalendarAccounts } from './calendarAccounts.js';
import { listAccounts as listMessageAccounts } from './messageAccounts.js';
import { countMemories } from './memoryBackend.js';
import { getConfig as getCosConfig } from './cos.js';
import { getVoiceConfig } from './voice/config.js';
import { getNetworkExposureSetupStatus } from '../lib/networkExposure.js';
import { getGenomeSummary } from './genome.js';
import { getSettings } from './settings.js';
import * as telegram from './telegram.js';
import * as telegramBridge from './telegramBridge.js';
import { getAppStatusSummary } from './appProcessStatus.js';


// Resolve whether a memory-embedding provider is actually reachable-by-config
// (mirrors memoryEmbeddings.initConfig) without firing the live LM Studio probe
// — the probe auto-loads a model as a side effect, which a read-only status
// page must not trigger.
async function resolveEmbeddingProviderConfigured() {
  const cosConfig = await getCosConfig();
  const providerId = cosConfig?.embeddingProviderId || 'lmstudio';
  const provider = await getProviderById(providerId);
  // Mirror memoryEmbeddings.initConfig exactly: it keys off `endpoint` alone and
  // does NOT gate on `enabled`, so embeddings still generate from a disabled-but-
  // endpoint'd provider. Checking `enabled` here would misreport that as "off".
  return !!provider?.endpoint;
}

async function resolveTelegram() {
  const settings = await getSettings();
  const method = settings?.telegram?.method || 'manual';
  if (method === 'mcp-bridge') {
    const status = telegramBridge.getStatus();
    return { method, hasToken: status.hasBotToken, hasChatId: status.hasChatId, connected: status.connected };
  }
  const status = telegram.getStatus();
  return {
    method,
    hasToken: !!settings?.secrets?.telegram?.token,
    hasChatId: !!settings?.telegram?.chatId,
    connected: status.connected,
  };
}

// GET /api/capabilities — capability map of every connected system.
export async function getCapabilitiesSnapshot() {
  const unavailable = new Set();
  const failed = (id, fallback) => () => {
    unavailable.add(id);
    return fallback;
  };
  const providersPromise = getAllProviders().catch(failed('providers', { providers: [] }));
  const providerPrerequisiteReadinessPromise = providersPromise.then((data) => {
    const providers = Array.isArray(data?.providers) ? data.providers : [];
    const enabled = providers.filter((provider) => provider?.enabled !== false);
    return getProviderPrerequisiteReadinessMap(providers, { candidates: enabled });
  }).catch(failed('providers', null));
  const providerLocalReadinessPromise = providersPromise.then((data) => {
    const providers = Array.isArray(data?.providers) ? data.providers : [];
    const enabled = providers.filter((provider) => provider?.enabled !== false);
    return getProviderReadinessMap(enabled);
  }).catch(() => null);

  const [
    providersData,
    providerPrerequisiteReadiness,
    providerLocalReadiness,
    providerStatuses,
    calendarAccounts,
    messageAccounts,
    memoryCount,
    embeddingProviderConfigured,
    voiceConfig,
    genome,
    telegramStatus,
    appSummary,
    network,
    settings,
  ] = await Promise.all([
    providersPromise,
    providerPrerequisiteReadinessPromise,
    providerLocalReadinessPromise,
    Promise.resolve().then(() => getAllProviderStatuses()).catch(failed('providers', {})),
    listCalendarAccounts().catch(failed('calendar', [])),
    listMessageAccounts().catch(failed('messages', [])),
    countMemories({ status: 'active' }).catch(failed('brain', 0)),
    resolveEmbeddingProviderConfigured().catch(failed('brain', false)),
    getVoiceConfig().catch(failed('voice', {})),
    getGenomeSummary().catch(failed('genome', { uploaded: false })),
    resolveTelegram().catch(failed('telegram', {})),
    getAppStatusSummary().catch(failed('apps', { total: 0 })),
    getNetworkExposureSetupStatus().catch(failed('network', {})),
    getSettings(),
  ]);

  const rows = buildCapabilityRows({
    providers: providersData?.providers ?? [],
    providerPrerequisiteReadiness,
    providerLocalReadiness,
    providerStatuses,
    calendarAccounts,
    messageAccounts,
    memoryCount: Number(memoryCount) || 0,
    embeddingProviderConfigured,
    voiceConfig,
    network,
    genome,
    telegram: telegramStatus,
    appSummary,
  }).map(row => unavailable.has(row.id)
    ? { ...row, status: 'warn', summary: 'Readiness unavailable — probe failed', setupComplete: false }
    : row);

  return {
    timestamp: new Date().toISOString(),
    summary: summarizeCapabilities(rows),
    optionalSummary: summarizeCapabilities(rows.filter((row) => row.setupRequired !== true && row.id !== 'network')),
    setup: summarizeSetupCapabilities(rows),
    capabilities: rows,
    network,
    networkSetupPreference: settings.networkSetupPreference || null,
  };
}

