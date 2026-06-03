/**
 * Promote an "Ask Yourself" assistant turn into a Brain note, CoS task, or
 * Goal progress entry.
 *
 * This is the single source of truth for the promote-a-turn orchestration —
 * extracted out of the `POST /api/ask/:id/turns/:turnId/promote` route so the
 * cross-domain Review Queue can promote an Ask answer in place (picking the
 * latest assistant turn for the caller) without duplicating the brain/task/goal
 * dispatch or the pin-on-promote behaviour.
 *
 * It lives in its own module (rather than `askConversations.js`) so the leaf
 * storage layer keeps its no-upstream-imports property — only this orchestrator
 * reaches across to brain/cos/identity.
 */

import { ServerError } from '../lib/errorHandler.js';
import * as convs from './askConversations.js';
import * as brainService from './brain.js';
import * as cosService from './cos.js';
import * as identityService from './identity.js';

// Cap promoted task descriptions so a long assistant answer doesn't bloat
// TASKS.md — the full text is still in the conversation. CoS tasks are
// supposed to be one-line directives, not essays.
const TASK_DESCRIPTION_MAX = 280;

/**
 * Find the latest assistant turn in a conversation that carries promotable
 * (non-empty) content. Returns null when none exists — distinct from a
 * not-found conversation, so callers can map the two to different statuses.
 */
export function latestAssistantTurn(conversation) {
  const turns = Array.isArray(conversation?.turns) ? conversation.turns : [];
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i];
    if (turn?.role === 'assistant' && (turn.content || '').trim()) return turn;
  }
  return null;
}

/**
 * Promote a single assistant turn into the chosen target.
 *
 * @param {object} args
 * @param {string} args.conversationId
 * @param {object} args.turn            the resolved assistant turn (content validated by caller)
 * @param {'brain'|'task'|'goal'} args.target
 * @param {'LOW'|'MEDIUM'|'HIGH'} [args.priority]  task target only
 * @param {string} [args.goalId]        goal target only
 * @returns {Promise<{ target, ref, conversation }>}
 *
 * Always pins the conversation (`promoted: true`) so anything the user saved
 * elsewhere survives the 30-day auto-expiry sweep.
 */
export async function promoteTurnContent({ conversationId, turn, target, priority = 'MEDIUM', goalId }) {
  const content = (turn?.content || '').trim();
  if (!content) {
    throw new ServerError('Turn has no content to promote', { status: 400, code: 'EMPTY_CONTENT' });
  }

  let ref;
  if (target === 'brain') {
    const result = await brainService.captureThought(content);
    ref = { type: 'brain', id: result?.inboxLog?.id };
  } else if (target === 'task') {
    const description = content.length <= TASK_DESCRIPTION_MAX
      ? content
      : `${content.slice(0, TASK_DESCRIPTION_MAX - 1)}…`;
    const result = await cosService.addTask({
      description,
      priority,
      context: `Promoted from Ask Yourself conversation ${conversationId}`,
    }, 'user');
    if (result?.duplicate) {
      throw new ServerError('A task with this description is already pending', { status: 409, code: 'DUPLICATE_TASK' });
    }
    ref = { type: 'task', id: result?.id };
  } else if (target === 'goal') {
    if (!goalId) throw new ServerError('goalId is required for goal target', { status: 400, code: 'VALIDATION_ERROR' });
    const today = new Date().toISOString().slice(0, 10);
    const entry = await identityService.addProgressEntry(goalId, {
      date: today,
      note: content,
      durationMinutes: null,
    });
    if (!entry) throw new ServerError('Goal not found', { status: 404, code: 'NOT_FOUND' });
    ref = { type: 'goal', id: goalId, entryId: entry.id };
  } else {
    throw new ServerError(`Unknown promote target "${target}"`, { status: 400, code: 'VALIDATION_ERROR' });
  }

  const conversation = await convs.setPromoted(conversationId, true);
  return { target, ref, conversation };
}

/**
 * Promote a turn referenced by id (used by the per-turn route). Looks up the
 * conversation + turn, asserts it's a non-empty assistant turn, then delegates.
 */
export async function promoteTurnById({ conversationId, turnId, target, priority, goalId }) {
  const conv = await convs.getConversation(conversationId);
  if (!conv) throw new ServerError('Conversation not found', { status: 404, code: 'NOT_FOUND' });

  const turn = (conv.turns || []).find((t) => t.id === turnId);
  if (!turn) throw new ServerError('Turn not found', { status: 404, code: 'NOT_FOUND' });
  // Only assistant turns carry promotable content — the user's question is
  // already implicit in the conversation and would just bloat the brain inbox
  // / task list with prompts, not insights.
  if (turn.role !== 'assistant') {
    throw new ServerError('Only assistant turns can be promoted', { status: 400, code: 'VALIDATION_ERROR' });
  }

  return promoteTurnContent({ conversationId, turn, target, priority, goalId });
}

/**
 * Promote the conversation's *latest* assistant turn — the entry point the
 * Review Queue uses, so the client doesn't need to know turn ids. Restricted
 * to brain/task targets (goal needs a goalId the queue row can't supply; the
 * user drills into /ask for that). 404s when no assistant turn exists.
 */
export async function promoteLatestAssistantTurn({ conversationId, target, priority }) {
  const conv = await convs.getConversation(conversationId);
  if (!conv) throw new ServerError('Conversation not found', { status: 404, code: 'NOT_FOUND' });

  const turn = latestAssistantTurn(conv);
  if (!turn) {
    throw new ServerError('Conversation has no assistant answer to promote', { status: 404, code: 'NO_ASSISTANT_TURN' });
  }

  return promoteTurnContent({ conversationId, turn, target, priority });
}
