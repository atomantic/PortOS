/** Persistent Chief-of-Staff mind conversation and lifecycle routes. */

import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { getDomainMode } from '../lib/domainAutonomy.js';
import { PERSISTENT_MIND_LIMITS } from '../lib/persistentMind.js';
import { MAX_SCREENSHOT_BYTES } from '../lib/uploadLimits.js';
import {
  normalizePersistentMindCapabilities,
  PERSISTENT_MIND_CAPABILITIES_SCHEMA_VERSION,
  PERSISTENT_MIND_CLEANUP_SCOPES,
  PERSISTENT_MIND_TOOL_BOUNDARIES,
  PERSISTENT_MIND_TOOL_CATALOG,
} from '../lib/persistentMindCapabilities.js';
import {
  PERSISTENT_MIND_ID,
  PERSISTENT_MIND_TRAJECTORY_LIMITS,
  parsePersistentMindCursor,
} from '../lib/persistentMindTrajectory.js';
import { normalizePersistentMindProfile } from '../lib/persistentMindProfile.js';
import { normalizePersistentMindPrompt } from '../lib/persistentMindPrompt.js';
import { publicPersistentMindState } from '../lib/persistentMindPublic.js';
import { validateRequest } from '../lib/validation.js';
import { readPersistentMindEvents, readPersistentMindHistory } from '../services/agentRunEventLog.js';
import { loadState } from '../services/cosState.js';
import {
  appendPersistentMindAnnotation,
  createPersistentMindMemory,
  preparePersistentMindContext,
  promotePersistentMindMemory,
  readPersistentMindMemories,
  readPersistentMindRollups,
  updatePersistentMindMemory,
} from '../services/persistentMindContext.js';
import { getProviderById } from '../services/providers.js';
import { persistentMindHarnessInfo } from '../services/persistentMindAdapter.js';
import { cleanupPersistentMind } from '../services/persistentMindMaintenance.js';
import { resolvePersistentMindImageCapability } from '../services/persistentMindImageCapability.js';
import { readPersistentMindTaskCatalog } from '../services/persistentMindTaskCapability.js';
import { inspectPersistentMindRuntime } from '../services/persistentMindRuntime.js';
import { readPersistentMindVisibility } from '../services/persistentMindVisibility.js';
import {
  createPersistentMindAttachment,
  deletePersistentMindAttachment,
  enqueuePersistentMindMessage,
  getPersistentMindState,
  pausePersistentMind,
  resumePersistentMind,
  startPersistentMind,
  stopPersistentMind,
} from '../services/persistentMindSupervisor.js';

const router = Router();

const idempotencyId = z.string().trim().min(1).max(200);
const eventId = z.string().trim().min(1).max(128);
const text = z.string().trim().min(1).max(PERSISTENT_MIND_LIMITS.MAX_MESSAGE_CHARS);
const messageText = z.string().trim().max(PERSISTENT_MIND_LIMITS.MAX_MESSAGE_CHARS).optional();
const attachmentId = z.string()
  .trim()
  .min(1)
  .max(PERSISTENT_MIND_LIMITS.MAX_ATTACHMENT_ID_CHARS)
  .regex(/^[A-Za-z0-9_-]+$/, 'invalid attachment id');
const imageReference = z.union([
  attachmentId,
  z.object({ attachmentId }).strict(),
]);
const mindReadSchema = z.object({
  cursor: z.string().max(260).refine((value) => parsePersistentMindCursor(value) !== null, 'Invalid cursor').optional(),
  limit: z.coerce.number().int().positive().max(PERSISTENT_MIND_TRAJECTORY_LIMITS.maxPageSize).optional(),
}).strict();
const visibilityReadSchema = z.object({
  refresh: z.enum(['true', 'false']).transform((value) => value === 'true').optional(),
}).strict();
const messageSchema = z.object({
  id: idempotencyId,
  text: messageText,
  images: z.array(imageReference).max(PERSISTENT_MIND_LIMITS.MAX_MESSAGE_IMAGES).optional(),
}).strict().superRefine((value, ctx) => {
  const images = Array.isArray(value.images) ? value.images : [];
  const ids = images.map((image) => typeof image === 'string' ? image : image.attachmentId);
  if (!value.text && ids.length === 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['text'], message: 'text or at least one image is required' });
  }
  if (new Set(ids).size !== ids.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['images'], message: 'image references must be unique' });
  }
});
const attachmentUploadSchema = z.object({
  filename: z.string().trim().min(1).max(PERSISTENT_MIND_LIMITS.MAX_ATTACHMENT_FILENAME_CHARS),
  data: z.string().min(1).max(Math.ceil(MAX_SCREENSHOT_BYTES * 4 / 3) + 16),
}).strict();
const attachmentParamsSchema = z.object({ attachmentId }).strict();
const annotationSchema = z.object({
  id: idempotencyId,
  text,
  turnId: z.string().trim().min(1).max(128).nullable().optional(),
  targetEventId: eventId.nullable().optional(),
}).strict();
const pauseSchema = z.object({ reason: z.string().trim().min(1).max(PERSISTENT_MIND_LIMITS.MAX_REASON_CHARS).optional() }).strict();
const acknowledgementSchema = z.object({ id: idempotencyId }).strict();
const eventParamsSchema = z.object({ eventId }).strict();
const promotionSchema = z.object({
  id: idempotencyId,
  approved: z.literal(true),
  content: z.string().trim().min(1).max(10_240),
  summary: z.string().trim().max(500).optional(),
  turnId: z.string().trim().min(1).max(128).nullable().optional(),
  type: z.enum(['fact', 'preference', 'pattern', 'insight', 'context']).optional(),
  category: z.string().trim().min(1).max(100).optional(),
  tags: z.array(z.string().trim().min(1).max(100)).max(20).optional(),
}).strict();
const memoryType = z.enum(['fact', 'learning', 'observation', 'decision', 'preference', 'context']);
const memoryFields = {
  content: z.string().trim().min(1).max(10_240),
  summary: z.string().trim().max(500).optional(),
  type: memoryType,
  category: z.string().trim().min(1).max(100),
  tags: z.array(z.string().trim().min(1).max(50)).max(20),
  importance: z.number().min(0).max(1),
};
const memoryInputSchema = z.object({
  ...memoryFields,
  type: memoryFields.type.optional().default('observation'),
  category: memoryFields.category.optional().default('other'),
  tags: memoryFields.tags.optional().default([]),
  importance: memoryFields.importance.optional().default(0.5),
}).strict();
const memoryUpdateSchema = z.object(memoryFields).partial().strict().refine(
  (value) => Object.keys(value).length > 0,
  'At least one memory field is required'
);
const memoryParamsSchema = z.object({ memoryId: z.string().trim().min(1).max(128) }).strict();
const cleanupSchema = z.object({
  scopes: z.array(z.enum(PERSISTENT_MIND_CLEANUP_SCOPES))
    .min(1)
    .max(PERSISTENT_MIND_CLEANUP_SCOPES.length)
    .refine((scopes) => new Set(scopes).size === scopes.length, 'cleanup scopes must be unique'),
  reason: z.string().trim().min(1).max(300).optional(),
  confirmation: z.literal('CLEAR'),
}).strict();

const requireSuccess = (result) => {
  if (result?.success === false) {
    throw new ServerError(result.error || 'Persistent mind request was refused', {
      status: Number.isInteger(result.status) ? result.status : 409,
      code: result.code || 'INVALID_STATE',
    });
  }
  return result;
};

const requireMindEvent = async (targetEventId) => {
  const events = await readPersistentMindHistory(PERSISTENT_MIND_ID);
  if (!events.some((event) => event.eventId === targetEventId)) {
    throw new ServerError('Persistent mind event not found', { status: 404, code: 'NOT_FOUND' });
  }
};

router.get('/mind', asyncHandler(async (req, res) => {
  const query = validateRequest(mindReadSchema, req.query);
  const [history, state, root] = await Promise.all([
    readPersistentMindEvents({ mindId: PERSISTENT_MIND_ID, ...query }),
    getPersistentMindState(),
    loadState(),
  ]);
  const profile = normalizePersistentMindProfile(root.config?.persistentMindProfile);
  const capabilities = normalizePersistentMindCapabilities(root.config?.persistentMindCapabilities);
  const provider = profile.providerId ? await getProviderById(profile.providerId) : null;
  const imageCapability = await resolvePersistentMindImageCapability({ provider, model: profile.model });
  const { snapshot: _snapshot, ...publicHistory } = history;
  res.json({
    ...publicHistory,
    state: publicPersistentMindState(state),
    profile: {
      enabled: profile.enabled,
      providerId: profile.providerId || null,
      model: profile.model || null,
      effort: profile.effort || null,
      thinkingInterface: profile.thinkingInterface,
      wakeIntervalMinutes: profile.wakeIntervalMinutes,
    },
    capabilities,
    harness: persistentMindHarnessInfo(provider),
    imageCapability,
    autonomyMode: getDomainMode(root.config, 'cos'),
  });
}));

router.get('/mind/context', asyncHandler(async (_req, res) => {
  const root = await loadState();
  const prompt = normalizePersistentMindPrompt(root.config?.persistentMindPrompt);
  const profile = normalizePersistentMindProfile(root.config?.persistentMindProfile);
  const [memories, rollups, provider] = await Promise.all([
    readPersistentMindMemories(PERSISTENT_MIND_ID),
    readPersistentMindRollups(PERSISTENT_MIND_ID),
    profile.providerId ? getProviderById(profile.providerId) : null,
  ]);
  const preview = await preparePersistentMindContext({
    mindId: PERSISTENT_MIND_ID,
    identity: prompt.identity,
    instructions: prompt.instructions,
    memories,
  });
  res.json({
    prompt,
    preview,
    memories,
    rollups,
    harness: persistentMindHarnessInfo(provider),
  });
}));

// Keep the persistent mind's authority inventory separate from the broader
// onboard-tools registry. Those tools belong to other agent surfaces and are
// not direct capabilities of the persistent mind.
router.get('/mind/tools', asyncHandler(async (_req, res) => {
  const root = await loadState();
  const capabilities = normalizePersistentMindCapabilities(root.config?.persistentMindCapabilities);
  const taskCatalog = capabilities.createTasks
    ? await readPersistentMindTaskCatalog({ includeAllApps: true })
    : null;
  if (taskCatalog && Array.isArray(taskCatalog.apps)) {
    const allowed = Array.isArray(capabilities.allowedAppIds) ? new Set(capabilities.allowedAppIds) : null;
    taskCatalog.apps = taskCatalog.apps.map((app) => ({
      ...app,
      granted: !allowed || allowed.has(app.id),
    }));
  }
  res.json({
    schemaVersion: PERSISTENT_MIND_CAPABILITIES_SCHEMA_VERSION,
    capabilities,
    boundaries: PERSISTENT_MIND_TOOL_BOUNDARIES,
    taskCatalog,
    tools: PERSISTENT_MIND_TOOL_CATALOG.map((tool) => ({
      ...tool,
      granted: capabilities[tool.capability] === true,
    })),
  });
}));

router.get('/mind/runtime', asyncHandler(async (_req, res) => {
  const [root, state] = await Promise.all([loadState(), getPersistentMindState()]);
  const prompt = normalizePersistentMindPrompt(root.config?.persistentMindPrompt);
  const profile = normalizePersistentMindProfile(root.config?.persistentMindProfile);
  const providerId = state.activeTurn?.providerId || profile.providerId;
  const provider = providerId ? await getProviderById(providerId) : null;
  res.json(await inspectPersistentMindRuntime({ state, profile, prompt, provider }));
}));

router.get('/mind/visibility', asyncHandler(async (req, res) => {
  const { refresh = false } = validateRequest(visibilityReadSchema, req.query);
  const [root, state] = await Promise.all([loadState(), getPersistentMindState()]);
  const prompt = normalizePersistentMindPrompt(root.config?.persistentMindPrompt);
  const profile = normalizePersistentMindProfile(root.config?.persistentMindProfile);
  const providerId = state.activeTurn?.providerId || profile.providerId;
  const provider = providerId ? await getProviderById(providerId) : null;
  res.json(await readPersistentMindVisibility({ root, state, profile, prompt, provider, force: refresh }));
}));

router.post('/mind/memories', asyncHandler(async (req, res) => {
  const input = validateRequest(memoryInputSchema, req.body);
  const memory = await createPersistentMindMemory(input);
  res.status(201).json({ success: true, memory });
}));

router.put('/mind/memories/:memoryId', asyncHandler(async (req, res) => {
  const { memoryId } = validateRequest(memoryParamsSchema, req.params);
  const updates = validateRequest(memoryUpdateSchema, req.body);
  const memory = await updatePersistentMindMemory(memoryId, updates);
  if (!memory) throw new ServerError('Persistent mind memory not found', { status: 404, code: 'NOT_FOUND' });
  res.json({ success: true, memory });
}));

router.post('/mind/cleanup', asyncHandler(async (req, res) => {
  const { confirmation: _confirmation, ...input } = validateRequest(cleanupSchema, req.body);
  // A user-initiated cleanup creates a stable boundary: stop inference first so
  // an in-flight turn cannot immediately repopulate state from the old context.
  await stopPersistentMind({ waitForTurn: true });
  const result = await cleanupPersistentMind({ ...input, requestedBy: 'user' });
  const state = await getPersistentMindState();
  res.json({ ...result, state: publicPersistentMindState(state) });
}));

router.post('/mind/attachments', asyncHandler(async (req, res) => {
  const input = validateRequest(attachmentUploadSchema, req.body);
  res.status(201).json(requireSuccess(await createPersistentMindAttachment(input)));
}));

router.delete('/mind/attachments/:attachmentId', asyncHandler(async (req, res) => {
  const { attachmentId: id } = validateRequest(attachmentParamsSchema, req.params);
  res.json(requireSuccess(await deletePersistentMindAttachment(id)));
}));

router.post('/mind/messages', asyncHandler(async (req, res) => {
  const input = validateRequest(messageSchema, req.body);
  res.status(202).json(requireSuccess(await enqueuePersistentMindMessage(input)));
}));

router.post('/mind/annotations', asyncHandler(async (req, res) => {
  const input = validateRequest(annotationSchema, req.body);
  if (input.targetEventId) await requireMindEvent(input.targetEventId);
  const result = await appendPersistentMindAnnotation(input);
  if (result.error) throw new ServerError(result.error, { status: 409, code: 'INVALID_STATE' });
  res.status(202).json({ success: true, duplicate: result.duplicate === true, annotationId: input.id });
}));

router.post('/mind/start', asyncHandler(async (_req, res) => {
  res.json(requireSuccess(await startPersistentMind()));
}));

router.post('/mind/pause', asyncHandler(async (req, res) => {
  const { reason } = validateRequest(pauseSchema, req.body ?? {});
  const result = requireSuccess(await pausePersistentMind(reason));
  res.json({ success: true, state: publicPersistentMindState(result.state) });
}));

router.post('/mind/resume', asyncHandler(async (_req, res) => {
  res.json(requireSuccess(await resumePersistentMind()));
}));

router.post('/mind/stop', asyncHandler(async (_req, res) => {
  res.json(requireSuccess(await stopPersistentMind()));
}));

router.post('/mind/events/:eventId/acknowledge', asyncHandler(async (req, res) => {
  const { eventId: targetEventId } = validateRequest(eventParamsSchema, req.params);
  const { id } = validateRequest(acknowledgementSchema, req.body);
  await requireMindEvent(targetEventId);
  const result = await appendPersistentMindAnnotation({
    id,
    targetEventId,
    text: 'Acknowledged by user',
  });
  if (result.error) throw new ServerError(result.error, { status: 409, code: 'INVALID_STATE' });
  res.status(202).json({ success: true, duplicate: result.duplicate === true, acknowledgementId: id });
}));

router.post('/mind/events/:eventId/promote', asyncHandler(async (req, res) => {
  const { eventId: sourceEventId } = validateRequest(eventParamsSchema, req.params);
  const input = validateRequest(promotionSchema, req.body);
  await requireMindEvent(sourceEventId);
  const result = requireSuccess(await promotePersistentMindMemory({ ...input, sourceEventId }));
  res.status(201).json({ success: true, memoryId: result.memory?.id || null });
}));

export default router;
