import { describe, it, expect } from 'vitest';
import {
  HUMAN_ACTION_CATCH_UP_MS,
  humanActionPlanSchema,
  humanActionReminderDecision,
  humanActionThreadFields,
} from './humanActions.js';

const NOW = Date.parse('2026-10-06T18:00:00.000Z');
const plan = humanActionPlanSchema.parse({
  planKey: 'promo-example',
  title: 'Promote "Example Song"',
  steps: [{
    title: 'Post the opening clip on X',
    dueAt: '2026-10-07T10:00:00-07:00',
    instructions: ['Open X and start a new post.', 'Attach clip 0:12–0:35.'],
    content: [{ label: 'Post text', text: 'Code in a caption: ```js\nx()\n```' }],
    links: [{ label: 'Full video', url: 'https://example.com/watch' }],
    priority: 'high',
  }],
});

describe('humanActionPlanSchema', () => {
  it('rejects a step whose rendered notes exceed the thread notes cap instead of truncating', () => {
    const big = { ...plan, steps: [{ ...plan.steps[0], content: Array.from({ length: 5 }, (_, i) => ({ label: `L${i}`, text: 'x'.repeat(5000) })) }] };
    const result = humanActionPlanSchema.safeParse(big);
    expect(result.success).toBe(false);
    expect(result.error.issues[0].path).toEqual(['steps', 0]);
  });

  it('refuses a due time without an offset, so a local time is never read as UTC', () => {
    const bad = { ...plan, steps: [{ ...plan.steps[0], dueAt: '2026-10-07T10:00:00' }] };
    expect(humanActionPlanSchema.safeParse(bad).success).toBe(false);
  });

  it('refuses a non-http link', () => {
    const bad = { ...plan, steps: [{ ...plan.steps[0], links: [{ url: 'javascript:alert(1)' }] }] };
    expect(humanActionPlanSchema.safeParse(bad).success).toBe(false);
  });
});

describe('humanActionThreadFields', () => {
  it('stores the step as a tagged thread whose notes keep pasted fences intact', () => {
    const fields = humanActionThreadFields(plan.steps[0], plan);
    expect(fields).toMatchObject({
      title: 'Post the opening clip on X',
      status: 'open',
      priority: 'high',
      nextAction: 'Open X and start a new post.',
      dueAt: '2026-10-07T17:00:00.000Z',
      tags: ['human-action', 'plan:promo-example'],
      refs: [{ kind: 'url', id: 'https://example.com/watch', label: 'Full video' }],
    });
    expect(fields.notes).toContain('1. Open X and start a new post.\n2. Attach clip 0:12–0:35.');
    // The pasted text holds a ``` run, so its block is fenced with four.
    expect(fields.notes).toContain('**Post text**\n````text\nCode in a caption: ```js\nx()\n```\n````');
  });
});

describe('humanActionReminderDecision', () => {
  const thread = (overrides = {}) => ({ status: 'open', tags: ['human-action'], dueAt: '2026-10-06T19:00:00.000Z', ...overrides });

  it('arms a timer for a future step and fires one that is due', () => {
    expect(humanActionReminderDecision(thread(), NOW)).toEqual({ delayMs: 60 * 60 * 1000 });
    expect(humanActionReminderDecision(thread({ dueAt: '2026-10-06T17:59:00.000Z' }), NOW)).toEqual({ fire: true });
  });

  it('counts a timer that fires a hair before the due time as due', () => {
    expect(humanActionReminderDecision(thread({ dueAt: new Date(NOW + 1).toISOString() }), NOW)).toEqual({ fire: true });
  });

  it('never repeats a reminder for the same due time, but re-arms a moved one', () => {
    expect(humanActionReminderDecision(thread({ remindedFor: '2026-10-06T19:00:00.000Z' }), NOW)).toBeNull();
    expect(humanActionReminderDecision(thread({ remindedFor: '2026-10-06T12:00:00.000Z' }), NOW)).toEqual({ delayMs: 60 * 60 * 1000 });
  });

  it('skips finished, parked, untagged and long-overdue threads', () => {
    expect(humanActionReminderDecision(thread({ status: 'done' }), NOW)).toBeNull();
    expect(humanActionReminderDecision(thread({ status: 'someday' }), NOW)).toBeNull();
    expect(humanActionReminderDecision(thread({ tags: ['ops'] }), NOW)).toBeNull();
    const stale = new Date(NOW - HUMAN_ACTION_CATCH_UP_MS - 1).toISOString();
    expect(humanActionReminderDecision(thread({ dueAt: stale }), NOW)).toBeNull();
  });
});
