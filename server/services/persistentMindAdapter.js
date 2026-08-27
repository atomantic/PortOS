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
import { COS_TOOL_CALL_LIMITS, persistentMindToolCallSchema } from '../lib/cosToolContracts.js';
import { parseLLMJSON } from '../lib/llmText.js';
import { canonicalStringify } from '../lib/objects.js';
import { sha256Text } from '../lib/fileUtils.js';
import { loadState } from './cosState.js';
import {
  createPersistentMindMemoryFromCandidate,
  readPersistentMindMemories,
} from './persistentMindContext.js';
import { normalizePersistentMindPrompt } from '../lib/persistentMindPrompt.js';
import { runPromptThroughProvider } from './promptRunner.js';
import { stopRun } from './runner.js';
import {
  buildPersistentMindTaskCapabilityPrompt,
  executePersistentMindTaskRequests,
  readPersistentMindTaskCatalog,
} from './persistentMindTaskCapability.js';
import {
  buildPersistentMindVisibilityPrompt,
  readPersistentMindVisibility,
} from './persistentMindVisibility.js';
import {
  buildPersistentMindToolPrompt,
  executeCosToolCall,
  isCosTaskToolName,
} from './cosToolRegistry.js';

const HEARTBEAT_INTERVAL_MS = 60_000;
const MAX_TOOL_PROVIDER_ROUNDS = 4;
const MAX_TOOL_RESULT_CHARS = 4_000;

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
  toolCalls: z.array(persistentMindToolCallSchema)
    .max(COS_TOOL_CALL_LIMITS.maxCallsPerTurn)
    .optional()
    .default([]),
  selfWake: z.object({
    reason: z.string().trim().min(1).max(500),
    delayMinutes: z.number().int().min(1).max(10_080),
  }).strict().nullable().optional().default(null),
}).strict();

const boundedToolResult = (result) => {
  const serialized = JSON.stringify(result);
  return serialized.length <= MAX_TOOL_RESULT_CHARS
    ? result
    : { truncated: true, preview: serialized.slice(0, MAX_TOOL_RESULT_CHARS) };
};

const toolRequestId = (turnId, call) => `mind-tool-${sha256Text(canonicalStringify(call.requestId
  ? { turnId, providerRequestId: call.requestId }
  : { turnId, name: call.name, arguments: call.arguments })).slice(0, 32)}`;

const failedToolResult = (message) => ({
  state: 'failed',
  error: String(message || 'Tool execution failed').slice(0, 500),
});

const executeMindToolCalls = async ({ calls, turnId, wake, signal, capabilities, recordCapabilityEvent, taskBudget }) => {
  const results = [];
  for (const candidate of calls) {
    if (signal?.aborted) throw new Error(String(signal.reason || 'Persistent mind turn interrupted'));
    const requestId = toolRequestId(turnId, candidate);
    await recordCapabilityEvent?.({
      kind: 'request',
      id: `tool-request:${requestId}`,
      data: { displayText: `Requested PortOS tool ${candidate.name}`, tool: candidate.name },
    });
    const isTaskCall = isCosTaskToolName(candidate.name);
    const taskLimitReached = isTaskCall && taskBudget.used >= PERSISTENT_MIND_TASK_LIMITS.maxPerTurn;
    if (isTaskCall && !taskLimitReached) taskBudget.used += 1;
    const result = taskLimitReached
      ? failedToolResult(`Persistent Mind task request limit of ${PERSISTENT_MIND_TASK_LIMITS.maxPerTurn} was reached for this turn`)
      : await executeCosToolCall({
        call: { ...candidate, requestId },
        authority: { scope: 'mind', capabilities },
        context: { turnId, wake, signal, recordCapabilityEvent },
      }).catch((error) => failedToolResult(error?.message));
    await recordCapabilityEvent?.({
      kind: 'result',
      id: `tool-result:${requestId}`,
      data: {
        displayText: `${candidate.name} ${result.state}`,
        tool: candidate.name,
        success: result.state === 'completed',
      },
    });
    results.push({
      requestId: candidate.requestId || requestId,
      name: candidate.name,
      state: result.state,
      ...(result.result !== undefined ? { result: boundedToolResult(result.result) } : {}),
      ...(result.error ? { error: result.error } : {}),
    });
  }
  return results;
};

const recordRejectedAction = async ({ requestId, resultRequestId = requestId, name, message, recordCapabilityEvent }) => {
  await recordCapabilityEvent?.({
    kind: 'request',
    id: `tool-request:${requestId}`,
    data: { displayText: `Requested PortOS tool ${name}`, tool: name },
  });
  await recordCapabilityEvent?.({
    kind: 'result',
    id: `tool-result:${requestId}`,
    data: { displayText: `${name} failed`, tool: name, success: false },
  });
  return { requestId: resultRequestId, name, state: 'failed', error: message };
};

const rejectMindToolCalls = async ({ calls, turnId, message, recordCapabilityEvent }) => {
  const results = [];
  for (const call of calls) {
    const internalRequestId = toolRequestId(turnId, call);
    results.push(await recordRejectedAction({
      requestId: internalRequestId,
      resultRequestId: call.requestId || internalRequestId,
      name: call.name,
      message,
      recordCapabilityEvent,
    }));
  }
  return results;
};

const rejectTaskRequests = async ({ taskRequests, turnId, message, recordCapabilityEvent }) => {
  const results = [];
  for (const request of taskRequests) {
    results.push(await recordRejectedAction({
      requestId: toolRequestId(turnId, { name: 'cos.create-task', arguments: request }),
      name: 'cos.create-task',
      message,
      recordCapabilityEvent,
    }));
  }
  return results;
};

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

export function buildPersistentMindTurnPrompt({ context, wake, taskCapabilityPrompt, toolCapabilityPrompt = '# PortOS semantic tools\nSemantic tool access is OFF.', visibilityPrompt = '# Persistent Mind environment visibility\nWorkspace and runtime visibility is unknown.' }) {
  return `${context.text}

${visibilityPrompt}

# Current wake
${currentWakeText(wake)}

${taskCapabilityPrompt}

${toolCapabilityPrompt}

# Response contract
Return ONLY one JSON object with this shape:
{
  "thinkingSummary": "A concise, user-visible working note explaining what you considered and why. Do not reveal hidden chain-of-thought.",
  "message": "The conversational reply. Required for a human message; optional for a self-directed wake.",
  "memoryCandidates": [{ "content": "A durable fact worth remembering", "summary": "Short label", "type": "fact", "category": "other", "tags": ["optional"] }],
  "taskRequests": [{ "description": "Concise queue label", "prompt": "Complete instructions for the agent", "priority": "MEDIUM", "appId": "configured-app-id", "providerId": "configured-provider-id", "model": "configured-model-id-or-empty-for-default", "effort": "high", "planOnly": false, "prCompletion": "review-then-merge", "requiredValidation": ["dependencies"] }],
  "toolCalls": [{ "requestId": "optional-stable-id", "name": "catalog-name", "arguments": {} }],
  "selfWake": { "reason": "Why another wake would be useful", "delayMinutes": 60 }
}
Use empty arrays when there is no durable memory candidate, task request, or tool call, and null when no earlier follow-up is needed. Memory candidates are durable memories to save automatically; only include information that is worth retaining. Never put the same CoS task in both taskRequests and toolCalls. This lane cannot mutate files directly, call arbitrary routes, contact people, or exceed the semantic tool catalog.`;
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
      const prompt = normalizePersistentMindPrompt(root.config?.persistentMindPrompt);
      const visibility = await readPersistentMindVisibility({
        root,
        profile: { providerId: provider?.id || null, model: model || null, effort: effort || null },
        prompt,
        provider,
      });
      const taskCatalog = taskAccess.createTasks ? await readPersistentMindTaskCatalog() : undefined;
      const taskCapabilityPrompt = buildPersistentMindTaskCapabilityPrompt({
        enabled: taskAccess.createTasks,
        catalog: taskCatalog,
      });
      const visibilityPrompt = buildPersistentMindVisibilityPrompt(visibility);
      const toolCapabilityPrompt = buildPersistentMindToolPrompt(taskAccess);
      const basePrompt = buildPersistentMindTurnPrompt({
        context,
        wake,
        taskCapabilityPrompt,
        toolCapabilityPrompt,
        visibilityPrompt,
      });
      let providerPrompt = basePrompt;
      let result;
      let parsed;
      let toolCallCount = 0;
      const taskBudget = { used: 0 };
      const completedToolResults = [];
      const actionNotices = new Set();
      for (let round = 0; round < MAX_TOOL_PROVIDER_ROUNDS; round += 1) {
        result = await runPinnedPrompt({
          provider,
          model,
          effort,
          signal,
          heartbeat,
          prompt: providerPrompt,
          responseSchema: persistentMindResponseSchema,
        });
        parsed = persistentMindResponseSchema.parse(parseLLMJSON(result.text));
        const finalProviderRound = round === MAX_TOOL_PROVIDER_ROUNDS - 1;
        if (finalProviderRound && parsed.toolCalls.length > 0) {
          const limitMessage = 'The bounded PortOS tool-call round limit was reached; additional requested actions were not executed.';
          completedToolResults.push(...await rejectMindToolCalls({
            calls: parsed.toolCalls,
            turnId,
            message: limitMessage,
            recordCapabilityEvent,
          }));
          actionNotices.add(limitMessage);
          if (parsed.taskRequests.length > 0) {
            const taskMessage = 'Task requests from the final non-terminal tool round were not queued.';
            completedToolResults.push(...await rejectTaskRequests({
              taskRequests: parsed.taskRequests,
              turnId,
              message: taskMessage,
              recordCapabilityEvent,
            }));
            actionNotices.add(taskMessage);
          }
          parsed = { ...parsed, taskRequests: [], toolCalls: [] };
          break;
        }

        if (parsed.toolCalls.length === 0) {
          const remainingTaskRequests = Math.max(0, PERSISTENT_MIND_TASK_LIMITS.maxPerTurn - taskBudget.used);
          const taskRequests = parsed.taskRequests.slice(0, remainingTaskRequests);
          const rejectedTaskRequests = parsed.taskRequests.slice(remainingTaskRequests);
          taskBudget.used += taskRequests.length;
          await executePersistentMindTaskRequests({
            taskRequests,
            turnId,
            wake,
            signal,
            recordCapabilityEvent,
          });
          if (rejectedTaskRequests.length > 0) {
            const limitMessage = `The Persistent Mind task request limit of ${PERSISTENT_MIND_TASK_LIMITS.maxPerTurn} was reached; additional tasks were not queued.`;
            completedToolResults.push(...await rejectTaskRequests({
              taskRequests: rejectedTaskRequests,
              turnId,
              message: limitMessage,
              recordCapabilityEvent,
            }));
            actionNotices.add(limitMessage);
          }
          break;
        }

        const remaining = Math.max(0, COS_TOOL_CALL_LIMITS.maxCallsPerTurn - toolCallCount);
        const calls = parsed.toolCalls.slice(0, remaining);
        const rejectedCalls = parsed.toolCalls.slice(remaining);
        if (rejectedCalls.length > 0) {
          const limitMessage = `The PortOS tool-call limit of ${COS_TOOL_CALL_LIMITS.maxCallsPerTurn} was reached; additional calls were not executed.`;
          completedToolResults.push(...await rejectMindToolCalls({
            calls: rejectedCalls,
            turnId,
            message: limitMessage,
            recordCapabilityEvent,
          }));
          actionNotices.add(limitMessage);
        }
        if (parsed.taskRequests.length > 0) {
          actionNotices.add('Task requests from intermediate tool rounds were deferred; only terminal task requests are queued.');
        }
        if (calls.length === 0) {
          parsed = { ...parsed, taskRequests: [], toolCalls: [] };
          break;
        }
        const toolResults = await executeMindToolCalls({
          calls,
          turnId,
          wake,
          signal,
          capabilities: taskAccess,
          recordCapabilityEvent,
          taskBudget,
        });
        completedToolResults.push(...toolResults);
        toolCallCount += calls.length;
        const budgetExhausted = toolCallCount >= COS_TOOL_CALL_LIMITS.maxCallsPerTurn || round === MAX_TOOL_PROVIDER_ROUNDS - 2;
        providerPrompt = `${basePrompt}\n\n# Completed tool results\n${JSON.stringify(completedToolResults)}\n\n${parsed.taskRequests.length > 0 ? 'Task requests from this intermediate round were not queued. Include only the final desired taskRequests in a terminal response with toolCalls: [].\n' : ''}${budgetExhausted ? 'The tool-call budget is exhausted. Return a final response with toolCalls: [] and do not repeat completed actions.' : 'Use these results to continue. Do not repeat a completed requestId.'}`;
      }
      if (actionNotices.size > 0) {
        const notice = [...actionNotices].join(' ');
        parsed = wake?.kind === 'message'
          ? { ...parsed, message: [parsed.message, notice].filter(Boolean).join('\n\n') }
          : { ...parsed, thinkingSummary: [parsed.thinkingSummary, notice].filter(Boolean).join(' ') };
        result = { ...result, text: JSON.stringify(parsed) };
      }
      const message = parsed.message || (wake?.kind === 'message' ? parsed.thinkingSummary : '');
      if (!parsed.thinkingSummary && !message && parsed.memoryCandidates.length === 0 && parsed.taskRequests.length === 0 && toolCallCount === 0) {
        throw new Error('Persistent mind returned no visible thought, reply, memory candidate, task request, or tool call');
      }
      const memoryWrites = await Promise.allSettled(parsed.memoryCandidates.map((candidate, index) => (
        createPersistentMindMemoryFromCandidate({
          ...candidate,
          candidateId: `${turnId}:${index}`,
          turnId,
        })
      )));
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
      memoryWrites.forEach((result, index) => {
        const candidate = parsed.memoryCandidates[index];
        if (result.status === 'fulfilled') {
          events.push({
            kind: 'mind.memory.created',
            id: `memory-created:${turnId}:${index}`,
            data: {
              ...candidate,
              memoryId: result.value.memory.id,
              duplicate: result.value.duplicate,
              displayText: candidate.content,
            },
          });
        } else {
          console.error(`❌ Persistent mind memory write failed for turn ${turnId}: ${result.reason?.message || 'unknown error'}`);
          events.push({
            kind: 'mind.memory.failed',
            id: `memory-failed:${turnId}:${index}`,
            data: { displayText: 'The persistent mind could not save this memory automatically.' },
          });
        }
      });
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
