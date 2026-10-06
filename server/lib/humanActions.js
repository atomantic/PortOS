/**
 * Human action plans — the pure half.
 *
 * A *human action* is a step only the person can take (press Post, reply to
 * people, upload a file), scheduled for a time and carried as a Brain thread so
 * it shows up in Review Hub › Actions and the Open Threads widget like any other
 * commitment. This module owns the request shape, how a step becomes a thread's
 * next action + markdown notes, and when a step's reminder should fire. The
 * service (`services/humanActions.js`) writes the threads; the reminder clock
 * (`services/humanActionReminders.js`) fires one notification per due step.
 */

import { z } from 'zod';
import { THREAD_PRIORITIES, isTerminalThreadStatus } from './brainThreads.js';

export const HUMAN_ACTION_TAG = 'human-action';
export const HUMAN_ACTION_SOURCE = 'human-action';
export const HUMAN_ACTION_PLAN_TAG_PREFIX = 'plan:';

// A step that came due while the server was down still gets its reminder when
// it boots, but not one from last month: past this, the row in Actions is the
// reminder.
export const HUMAN_ACTION_CATCH_UP_MS = 24 * 60 * 60 * 1000;

const planKey = z.string().trim().min(1).max(40)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'planKey must be a lowercase dash slug');

export const humanActionStepSchema = z.object({
  title: z.string().trim().min(1).max(200),
  // When the person should do it. An offset is required so "18:00" is never
  // silently read as UTC.
  dueAt: z.string().datetime({ offset: true }),
  // Explicit, ordered instructions. The first is the thread's next action.
  instructions: z.array(z.string().trim().min(1).max(500)).min(1).max(20),
  // Ready-to-paste text (a caption, a reply), each with a label saying where it goes.
  content: z.array(z.object({
    label: z.string().trim().min(1).max(100),
    text: z.string().trim().min(1).max(5000),
  }).strict()).max(10).optional().default([]),
  links: z.array(z.object({
    label: z.string().trim().max(200).optional().default(''),
    url: z.string().trim().url().max(2000).regex(/^https?:\/\//i, 'links must be http(s)'),
  }).strict()).max(10).optional().default([]),
  priority: z.enum(THREAD_PRIORITIES).optional().default('normal'),
}).strict();

export const humanActionPlanSchema = z.object({
  // Stable id for the plan, so planning again replaces its open steps instead
  // of stacking a second copy of every reminder.
  planKey,
  title: z.string().trim().min(1).max(120),
  steps: z.array(humanActionStepSchema).min(1).max(30),
}).strict();

export const humanActionPlanTag = (key) => `${HUMAN_ACTION_PLAN_TAG_PREFIX}${key}`;

/** A fence longer than any backtick run in `text`, so pasted code can't close it early. */
function fenceFor(text) {
  const longest = Math.max(0, ...(String(text).match(/`+/g) || []).map((run) => run.length));
  return '`'.repeat(Math.max(3, longest + 1));
}

/**
 * The thread notes for one step: numbered instructions, then each piece of
 * ready-to-paste content in its own fenced block (the Threads drawer offers a
 * Copy button per block), then links.
 */
export function buildHumanActionNotes(step, { planTitle = '' } = {}) {
  const parts = [];
  if (planTitle) parts.push(`Part of **${planTitle}**.`);
  parts.push(step.instructions.map((line, i) => `${i + 1}. ${line}`).join('\n'));
  if (step.content?.length) {
    parts.push('## Ready to paste');
    for (const { label, text } of step.content) {
      const fence = fenceFor(text);
      parts.push(`**${label}**\n${fence}text\n${text}\n${fence}`);
    }
  }
  if (step.links?.length) {
    parts.push('## Links');
    parts.push(step.links.map(({ label, url }) => `- [${label || url}](${url})`).join('\n'));
  }
  return parts.join('\n\n');
}

/** The Brain thread a step becomes (the writable fields; the service adds `source`). */
export function humanActionThreadFields(step, plan) {
  return {
    title: step.title,
    status: 'open',
    priority: step.priority || 'normal',
    nextAction: step.instructions[0].slice(0, 500),
    notes: buildHumanActionNotes(step, { planTitle: plan.title }).slice(0, 20000),
    dueAt: new Date(step.dueAt).toISOString(),
    tags: [HUMAN_ACTION_TAG, humanActionPlanTag(plan.planKey)],
    pinned: false,
    waitingOn: '',
    refs: (step.links || []).map(({ label, url }) => ({ kind: 'url', id: url, label: (label || url).slice(0, 300) })),
  };
}

export const isHumanActionThread = (thread) => Array.isArray(thread?.tags) && thread.tags.includes(HUMAN_ACTION_TAG);

/**
 * What the reminder clock should do with one thread right now:
 * - `null`  — nothing (not a human action, finished, undated, already reminded
 *             for this due time, or due too long ago to be worth a ping)
 * - `{ fire: true }` — due now (or came due recently while PortOS was down)
 * - `{ delayMs }`   — arm a timer for the due time
 *
 * `remindedFor` holds the `dueAt` a reminder was sent for, so moving the due
 * time re-arms it while a restart never repeats it.
 */
export function humanActionReminderDecision(thread, now = Date.now()) {
  if (!isHumanActionThread(thread) || isTerminalThreadStatus(thread.status) || thread.status === 'someday') return null;
  const due = Date.parse(thread.dueAt);
  if (!Number.isFinite(due)) return null;
  if (thread.remindedFor === thread.dueAt) return null;
  if (due > now) return { delayMs: due - now };
  return now - due <= HUMAN_ACTION_CATCH_UP_MS ? { fire: true } : null;
}
