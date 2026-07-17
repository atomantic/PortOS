import { Router } from 'express';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validation.js';
import { telegramConfigSchema, telegramTestSchema, telegramMethodSchema, telegramForwardTypesSchema } from '../lib/telegramValidation.js';
import { getSettings, updateSettingsWith } from '../services/settings.js';
import * as telegram from '../services/telegram.js';
import * as telegramBridge from '../services/telegramBridge.js';

const router = Router();

/**
 * Get the active telegram service based on configured method
 */
async function getActiveService() {
  const settings = await getSettings();
  return settings.telegram?.method === 'mcp-bridge' ? telegramBridge : telegram;
}

// GET /api/telegram/status
router.get('/status', asyncHandler(async (req, res) => {
  const settings = await getSettings();
  const method = settings.telegram?.method || 'manual';

  if (method === 'mcp-bridge') {
    const status = telegramBridge.getStatus();
    res.json({
      method,
      ...status,
      hasToken: status.hasBotToken,
      hasChatId: status.hasChatId,
      forwardTypes: settings.telegram?.forwardTypes || []
    });
  } else {
    const status = telegram.getStatus();
    res.json({
      method,
      ...status,
      hasToken: !!settings.secrets?.telegram?.token,
      hasChatId: !!settings.telegram?.chatId,
      forwardTypes: settings.telegram?.forwardTypes || []
    });
  }
}));

// PUT /api/telegram/method
router.put('/method', asyncHandler(async (req, res) => {
  const { method } = validateRequest(telegramMethodSchema, req.body);
  const settings = await getSettings();

  // Save method preference. Merge `telegram` against the FRESHEST snapshot inside
  // the write queue (not the `settings` read above, which can go stale before the
  // queued write lands) so a concurrent settings write isn't clobbered.
  await updateSettingsWith((current) => ({
    ...current,
    telegram: { ...current.telegram, method }
  }));

  // Switch services
  if (method === 'mcp-bridge') {
    // Stop manual bot, start bridge
    await telegram.cleanup();
    const bridgeOk = await telegramBridge.init();
    if (settings.telegram?.forwardTypes) {
      telegramBridge.updateCachedForwardTypes(settings.telegram.forwardTypes);
    }
    const status = telegramBridge.getStatus();
    res.json({
      method,
      ...status,
      hasToken: status.hasBotToken,
      hasChatId: status.hasChatId,
      initialized: bridgeOk
    });
  } else {
    // Stop bridge, start manual bot
    await telegramBridge.cleanup();
    await telegram.init(false);
    if (settings.telegram?.forwardTypes) {
      telegram.updateCachedForwardTypes(settings.telegram.forwardTypes);
    }
    const status = telegram.getStatus();
    res.json({
      method,
      ...status,
      hasToken: !!settings.secrets?.telegram?.token,
      hasChatId: !!settings.telegram?.chatId
    });
  }
}));

// PUT /api/telegram/config (manual bot only)
router.put('/config', asyncHandler(async (req, res) => {
  const { token, chatId } = validateRequest(telegramConfigSchema, req.body);
  const settings = await getSettings();

  // Preserve existing token if a new one wasn't provided
  const finalToken = token || settings.secrets?.telegram?.token;

  if (!finalToken) {
    throw new ServerError('Bot token is required', {
      status: 400,
      code: 'VALIDATION_ERROR'
    });
  }

  // Store token in secrets, chatId in telegram. Merge both sub-objects against
  // the freshest snapshot inside the write queue so a concurrent settings write
  // isn't clobbered. The chatId fallback reads `current` (not the stale `settings`
  // read above) so "keep the existing chatId when none is supplied" resolves
  // against the freshest persisted value; `finalToken` is request-driven (the
  // submitted token, else whatever was stored when we validated it).
  const saved = await updateSettingsWith((current) => ({
    ...current,
    secrets: { ...current.secrets, telegram: { token: finalToken } },
    telegram: { ...current.telegram, chatId: chatId || current.telegram?.chatId || '' }
  }));

  // Initialize bot — send test message only if chatId is configured. Derive from
  // the PERSISTED result (not the pre-write `settings` read) so the init decision
  // and response match exactly what was saved, even if another write landed first.
  const hasChatId = !!saved.telegram?.chatId;
  await telegram.init(hasChatId);
  const status = telegram.getStatus();

  res.json({
    ...status,
    hasToken: true,
    hasChatId
  });
}));

// DELETE /api/telegram/config
router.delete('/config', asyncHandler(async (req, res) => {
  const settings = await getSettings();
  const method = settings.telegram?.method || 'manual';

  if (method === 'mcp-bridge') {
    await telegramBridge.cleanup();
  } else {
    await telegram.cleanup();
  }

  await updateSettingsWith((current) => ({
    ...current,
    telegram: null,
    secrets: { ...current.secrets, telegram: undefined }
  }));

  res.json({ success: true });
}));

// POST /api/telegram/test
router.post('/test', asyncHandler(async (req, res) => {
  const { message: rawMessage } = validateRequest(telegramTestSchema, req.body);
  const message = rawMessage || '🧪 Test message from PortOS';
  const service = await getActiveService();
  const sendResult = await service.sendMessage(message);

  if (!sendResult.success) {
    throw new ServerError(sendResult.error || 'Failed to send test message', {
      status: 502,
      code: 'TELEGRAM_SEND_FAILED'
    });
  }

  res.json({ success: true });
}));

// PUT /api/telegram/forward-types
router.put('/forward-types', asyncHandler(async (req, res) => {
  const { forwardTypes } = validateRequest(telegramForwardTypesSchema, req.body);

  await updateSettingsWith((current) => ({
    ...current,
    telegram: { ...current.telegram, forwardTypes }
  }));

  // Update cache on both services (only the active one matters)
  telegram.updateCachedForwardTypes(forwardTypes);
  telegramBridge.updateCachedForwardTypes(forwardTypes);

  res.json({ success: true, forwardTypes });
}));

// POST /api/telegram/bridge/reload — reload bridge config from MCP plugin files
router.post('/bridge/reload', asyncHandler(async (req, res) => {
  await telegramBridge.reload();
  const status = telegramBridge.getStatus();
  res.json(status);
}));

export default router;
