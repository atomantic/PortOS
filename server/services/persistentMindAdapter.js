/**
 * Production text-provider adapter for the persistent Chief-of-Staff mind.
 *
 * The adapter deliberately uses the non-interactive provider runner. API and
 * headless CLI providers are stable service transports; TUI providers remain
 * supported for compatibility, but their terminal startup/scrape lifecycle is
 * exposed to the UI as the least reliable choice. Provider fallback is off:
 * the configured model is part of this mind's identity.
 */

import { z } from 'zod';
import {
  PERSISTENT_MIND_TASK_LIMITS,
  normalizePersistentMindCapabilities,
  persistentMindTaskRequestSchema,
} from '../lib/persistentMindCapabilities.js';
import { PERSISTENT_MIND_ID } from '../lib/persistentMindTrajectory.js';
import { parseLLMJSON } from '../lib/llmText.js';
import { loadState } from './cosState.js';
import { readPersistentMindMemories } from './persistentMindContext.js';
import { normalizePersistentMindPrompt } from '../lib/persistentMindPrompt.js';
import { runPromptThroughProvider } from './promptRunner.js';
import { stopRun } from './runner.js';
import {
  buildPersistentMindTaskCapabilityPrompt,
  executePersistentMindTaskRequests,
  readPersistentMindTaskCatalog,
} from './persistentMindTaskCapability.js';

const HEARTBEAT_INTERVAL_MS = 60_000;

const memoryCandidateSchema = z.object({
  content: z.string().trim().min(1).max(10_240),
  summary: z.string().trim().max(500).optional().default(''),
  type: z.enum(['fact', 'learning', 'observation', 'decision', 'preference', 'context']).optional().default('observation'),
  category: z.string().trim().min(1).max(100).optional().default('other'),
  tags: z.array(z.string().trim().min(1).max(50)).max(20).optional().default([]),
}).strict();

export const persistentMindResponseSchema = z.object({
  thinkingSummary: z.string().trim().max(4_000).optional().default(''),
  message: z.string().trim().max(8_000).optional().default(''),
  memoryCandidates: z.array(memoryCandidateSchema).max(5).optional().default([]),
  taskRequests: z.array(persistentMindTaskRequestSchema)
    .max(PERSISTENT_MIND_TASK_LIMITS.maxPerTurn)
    .optional()
    .default([]),
  selfWake: z.object({
    reason: z.string().trim().min(1).max(500),
    delayMinutes: z.number().int().min(1).max(10_080),
  }).strict().nullable().optional().default(null),
}).strict();

export function persistentMindHarnessInfo(provider) {
  const type = provider?.type || null;
  if (type === 'api') {
    return {
      type,
      label: 'Direct API',
      recommendation: 'recommended',
      detail: 'Best fit for a persistent service: structured HTTP, clean cancellation, streaming, and no terminal state. Ollama, llama.cpp, LM Studio, vLLM, and compatible cloud endpoints use this lane.',
    };
  }
  if (type === 'cli') {
    return {
      type,
      label: 'Headless CLI',
      recommendation: 'supported',
      detail: 'Reliable when the vendor CLI owns authentication or model access, with more process startup overhead than a direct API.',
    };
  }
  if (type === 'tui') {
    return {
      type,
      label: 'Interactive TUI',
      recommendation: 'not-recommended',
      detail: 'Compatibility lane only. Startup selectors, terminal redraws, response-file handoff, and screen scraping make it fragile for an unattended long-lived mind.',
    };
  }
  return {
    type,
    label: 'Unknown harness',
    recommendation: 'unavailable',
    detail: 'Choose a configured API or headless CLI text provider.',
  };
}

const currentWakeText = (wake) => {
  if (wake?.kind === 'message') {
    return `A human message is waiting. Reply directly to it.\nmessageId=${wake.message?.id || 'unknown'}\n${wake.message?.text || ''}`;
  }
  return `This is a self-directed wake. Continue one worthwhile thread from the trajectory.\nreason=${wake?.reason || 'scheduled reflection'}`;
};

export function buildPersistentMindTurnPrompt({ context, wake, taskCapabilityPrompt }) {
  return `${context.text}

# Current wake
${currentWakeText(wake)}

${taskCapabilityPrompt}

# Response contract
Return ONLY one JSON object with this shape:
{
  "thinkingSummary": "A concise, user-visible working note explaining what you considered and why. Do not reveal hidden chain-of-thought.",
  "message": "The conversational reply. Required for a human message; optional for a self-directed wake.",
  "memoryCandidates": [{ "content": "A durable fact worth proposing", "summary": "Short label", "type": "fact", "category": "other", "tags": ["optional"] }],
  "taskRequests": [{ "description": "Concise queue label", "prompt": "Complete instructions for the agent", "priority": "MEDIUM", "appId": "configured-app-id", "providerId": "configured-provider-id", "model": "configured-model-id-or-empty-for-default", "effort": "high", "prCompletion": "review-then-merge" }],
  "selfWake": { "reason": "Why another wake would be useful", "delayMinutes": 60 }
}
Use empty arrays when there is no durable memory candidate or task request, and null when no earlier follow-up is needed. Memory candidates are proposals only; a human decides whether to promote them. Typed CoS task creation is the only action capability in this lane and is available only when the capability section says ON. This lane still cannot mutate files directly, call arbitrary tools, contact people, or perform other external actions.`;
}

const summaryEventLines = (events) => (Array.isArray(events) ? events : []).map((event) => {
  const text = event?.data?.displayText || event?.data?.summaryText || event?.kind;
  return `[${event?.sequence ?? '?'}] ${event?.kind}: ${text}`;
}).join('\n');

export function buildPersistentMindSummaryPrompt({ events, previousSummary }) {
  return `Summarize this older portion of one persistent mind's life in first person. Preserve concrete decisions, unresolved questions, user preferences, and causal links. Do not invent facts. Return plain text only, no heading.\n\n${previousSummary ? `Prior cumulative summary:\n${previousSummary}\n\n` : ''}New trajectory events:\n${summaryEventLines(events)}`;
}

async function runPinnedPrompt({ provider, model, effort, prompt, signal, responseSchema, heartbeat }) {
  if (signal?.aborted) throw new Error(String(signal.reason || 'Persistent mind turn interrupted'));
  if (typeof heartbeat === 'function') await heartbeat();
  let activeRunId = null;
  let heartbeatPending = null;
  const pulse = () => {
    if (typeof heartbeat !== 'function' || heartbeatPending) return;
    heartbeatPending = Promise.resolve()
      .then(() => heartbeat())
      .catch((error) => console.error(`❌ Persistent mind heartbeat failed: ${error.message}`))
      .finally(() => { heartbeatPending = null; });
  };
  const heartbeatTimer = typeof heartbeat === 'function'
    ? setInterval(pulse, HEARTBEAT_INTERVAL_MS)
    : null;
  heartbeatTimer?.unref?.();
  const interrupt = () => {
    if (activeRunId) void stopRun(activeRunId).catch(() => {});
  };
  signal?.addEventListener('abort', interrupt, { once: true });
  return runPromptThroughProvider({
    provider,
    model,
    effort,
    prompt,
    source: 'cos-persistent-mind',
    allowFallback: false,
    responseSchema,
    onRunCreated: (runId) => {
      activeRunId = runId;
      if (signal?.aborted) interrupt();
    },
  }).finally(async () => {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    signal?.removeEventListener('abort', interrupt);
    await heartbeatPending;
  });
}

export function createPersistentMindTurnAdapter() {
  return {
    async prepare({ profile }) {
      const [root, memories] = await Promise.all([
        loadState(),
        readPersistentMindMemories(PERSISTENT_MIND_ID),
      ]);
      const prompt = normalizePersistentMindPrompt(root.config?.persistentMindPrompt);
      return {
        ok: true,
        provider: profile.provider,
        model: profile.model,
        effort: profile.effort,
        identity: prompt.identity,
        instructions: prompt.instructions,
        memories,
      };
    },

    async summarize({ events, previousSummary, provider, model, effort, signal, heartbeat }) {
      const result = await runPinnedPrompt({
        provider,
        model,
        effort,
        signal,
        heartbeat,
        prompt: buildPersistentMindSummaryPrompt({ events, previousSummary }),
      });
      return result.text.trim();
    },

    async run({ turnId, wake, provider, model, effort, signal, context, heartbeat, recordCapabilityEvent }) {
      const root = await loadState();
      const taskAccess = normalizePersistentMindCapabilities(root.config?.persistentMindCapabilities);
      const taskCatalog = taskAccess.createTasks ? await readPersistentMindTaskCatalog() : undefined;
      const taskCapabilityPrompt = buildPersistentMindTaskCapabilityPrompt({
        enabled: taskAccess.createTasks,
        catalog: taskCatalog,
      });
      const result = await runPinnedPrompt({
        provider,
        model,
        effort,
        signal,
        heartbeat,
        prompt: buildPersistentMindTurnPrompt({ context, wake, taskCapabilityPrompt }),
        responseSchema: persistentMindResponseSchema,
      });
      const parsed = persistentMindResponseSchema.parse(parseLLMJSON(result.text));
      const message = parsed.message || (wake?.kind === 'message' ? parsed.thinkingSummary : '');
      if (!parsed.thinkingSummary && !message && parsed.memoryCandidates.length === 0 && parsed.taskRequests.length === 0) {
        throw new Error('Persistent mind returned no visible thought, reply, memory candidate, or task request');
      }
      await executePersistentMindTaskRequests({
        taskRequests: parsed.taskRequests,
        turnId,
        wake,
        signal,
        recordCapabilityEvent,
      });
      const events = [];
      if (parsed.thinkingSummary) {
        events.push({
          kind: 'mind.thought',
          id: `thought:${turnId}`,
          data: { displayText: parsed.thinkingSummary, visibility: 'user-summary' },
        });
      }
      if (message) {
        events.push({
          kind: 'mind.reply',
          id: `reply:${turnId}`,
          data: { displayText: message, replyToMessageId: wake?.message?.id || null },
        });
      }
      parsed.memoryCandidates.forEach((candidate, index) => events.push({
        kind: 'mind.memory.candidate',
        id: `memory-candidate:${turnId}:${index}`,
        data: { ...candidate, displayText: candidate.content },
      }));
      return {
        output: result.text,
        events,
        selfWake: parsed.selfWake ? {
          reason: parsed.selfWake.reason,
          notBefore: new Date(Date.now() + parsed.selfWake.delayMinutes * 60_000).toISOString(),
        } : null,
      };
    },
  };
}
