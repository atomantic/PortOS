import { Router } from 'express';
import { asyncHandler } from '../lib/errorHandler.js';
import { buildCapabilityRows, summarizeCapabilities } from '../lib/capabilityMap.js';
import { getAllProviders, getProviderById } from '../services/providers.js';
import { getAllProviderStatuses } from '../services/providerStatus.js';
import { listAccounts as listCalendarAccounts } from '../services/calendarAccounts.js';
import { listAccounts as listMessageAccounts } from '../services/messageAccounts.js';
import { countMemories } from '../services/memoryBackend.js';
import { getConfig as getCosConfig } from '../services/cos.js';
import { getVoiceConfig } from '../services/voice/config.js';
import { getNetworkExposureStatus } from '../lib/networkExposure.js';
import { getGenomeSummary } from '../services/genome.js';
import { getSettings } from '../services/settings.js';
import * as telegram from '../services/telegram.js';
import * as telegramBridge from '../services/telegramBridge.js';
import * as apps from '../services/apps.js';

const router = Router();

// Resolve whether a memory-embedding provider is actually reachable-by-config
// (mirrors memoryEmbeddings.initConfig) without firing the live LM Studio probe
// — the probe auto-loads a model as a side effect, which a read-only status
// page must not trigger.
async function resolveEmbeddingProviderConfigured() {
  const cosConfig = await getCosConfig().catch(() => ({}));
  const providerId = cosConfig?.embeddingProviderId || 'lmstudio';
  const provider = await getProviderById(providerId).catch(() => null);
  // Mirror memoryEmbeddings.initConfig exactly: it keys off `endpoint` alone and
  // does NOT gate on `enabled`, so embeddings still generate from a disabled-but-
  // endpoint'd provider. Checking `enabled` here would misreport that as "off".
  return !!provider?.endpoint;
}

async function resolveTelegram() {
  const settings = await getSettings().catch(() => ({}));
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
router.get('/', asyncHandler(async (req, res) => {
  const [
    providersData,
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
  ] = await Promise.all([
    getAllProviders().catch(() => ({ providers: [] })),
    Promise.resolve().then(() => getAllProviderStatuses()).catch(() => ({})),
    listCalendarAccounts().catch(() => []),
    listMessageAccounts().catch(() => []),
    countMemories({ status: 'active' }).catch(() => 0),
    resolveEmbeddingProviderConfigured().catch(() => false),
    getVoiceConfig().catch(() => ({})),
    getGenomeSummary().catch(() => ({ uploaded: false })),
    resolveTelegram().catch(() => ({})),
    apps.getAppStatusSummary().catch(() => ({ total: 0 })),
    // Synchronous in-memory read — wrap so a cert-meta read failure degrades
    // to {} instead of 500-ing the whole page (no try/catch in route bodies).
    Promise.resolve().then(() => getNetworkExposureStatus()).catch(() => ({})),
  ]);

  const rows = buildCapabilityRows({
    providers: providersData?.providers ?? [],
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
  });

  res.json({
    timestamp: new Date().toISOString(),
    summary: summarizeCapabilities(rows),
    capabilities: rows,
  });
}));

export default router;
