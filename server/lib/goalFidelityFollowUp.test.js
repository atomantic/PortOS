import { describe, it, expect } from 'vitest';
import {
  DEFAULT_GOAL_FIDELITY_FOLLOW_UP_TRIGGER,
  GOAL_FIDELITY_FOLLOW_UP_TRIGGERS,
  buildGoalFidelityFollowUpTask,
  buildGoalFidelityIssue,
  formatGoalFidelityFollowUpSummary,
  goalFidelityFingerprint,
  goalFidelityFollowUpApplies,
  goalFidelityIssueMarker,
  issueMatchesGoalFidelityMarker,
  resolveGoalFidelityFollowUp,
} from './goalFidelityFollowUp.js';

const review = (over = {}) => ({
  verdict: 'rethink',
  missing: ['the retry cap the task named'],
  unrequested: [],
  evidence: 'The diff rewrites the scheduler instead.',
  backend: 'ollama',
  model: 'qwen3',
  ...over,
});

describe('resolveGoalFidelityFollowUp', () => {
  it('is null when neither action is configured, so a disabled install pays nothing', () => {
    expect(resolveGoalFidelityFollowUp(null)).toBeNull();
    expect(resolveGoalFidelityFollowUp({})).toBeNull();
    expect(resolveGoalFidelityFollowUp({ goalFidelity: {} })).toBeNull();
    expect(resolveGoalFidelityFollowUp({ goalFidelity: { fileIssue: false, queueTask: false } })).toBeNull();
  });

  it('resolves each action independently', () => {
    expect(resolveGoalFidelityFollowUp({ goalFidelity: { fileIssue: true } }))
      .toEqual({ fileIssue: true, queueTask: false, trigger: 'rethink' });
    expect(resolveGoalFidelityFollowUp({ goalFidelity: { queueTask: true } }))
      .toEqual({ fileIssue: false, queueTask: true, trigger: 'rethink' });
  });

  // The gate produces no verdict when it is off, so a stored `fileIssue: true`
  // under `enabled: false` describes an action nothing can trigger. Resolving
  // it anyway would make the UI and the runtime disagree about what is armed.
  it('the gate being off takes every follow-up with it', () => {
    expect(resolveGoalFidelityFollowUp({
      goalFidelity: { enabled: false, fileIssue: true, queueTask: true },
    })).toBeNull();
  });

  it('falls back to the default trigger for an absent or unknown value', () => {
    expect(resolveGoalFidelityFollowUp({ goalFidelity: { fileIssue: true, followUpOn: 'everything' } }).trigger)
      .toBe(DEFAULT_GOAL_FIDELITY_FOLLOW_UP_TRIGGER);
    expect(resolveGoalFidelityFollowUp({ goalFidelity: { fileIssue: true, followUpOn: 'any-finding' } }).trigger)
      .toBe('any-finding');
  });
});

describe('goalFidelityFollowUpApplies', () => {
  it('`rethink` fires only on the verdict that already holds a run', () => {
    expect(goalFidelityFollowUpApplies({ verdict: 'rethink' }, 'rethink')).toBe(true);
    expect(goalFidelityFollowUpApplies({ verdict: 'fix-first' }, 'rethink')).toBe(false);
    expect(goalFidelityFollowUpApplies({ verdict: 'ship' }, 'rethink')).toBe(false);
  });

  it('`any-finding` adds the advisory verdict but never a clean one', () => {
    expect(goalFidelityFollowUpApplies({ verdict: 'fix-first' }, 'any-finding')).toBe(true);
    expect(goalFidelityFollowUpApplies({ verdict: 'rethink' }, 'any-finding')).toBe(true);
    expect(goalFidelityFollowUpApplies({ verdict: 'ship' }, 'any-finding')).toBe(false);
  });

  // An unreadable verdict is `null` by contract (`normalizeGoalFidelityVerdict`),
  // and nothing judged the run — it must not file an issue.
  it('never fires on an absent verdict, under either trigger', () => {
    for (const trigger of GOAL_FIDELITY_FOLLOW_UP_TRIGGERS) {
      expect(goalFidelityFollowUpApplies(null, trigger)).toBe(false);
      expect(goalFidelityFollowUpApplies({}, trigger)).toBe(false);
    }
  });

  it('an unknown trigger degrades to the default rather than firing on everything', () => {
    expect(goalFidelityFollowUpApplies({ verdict: 'fix-first' }, 'bogus')).toBe(false);
    expect(goalFidelityFollowUpApplies({ verdict: 'rethink' }, 'bogus')).toBe(true);
  });
});

describe('goalFidelityFingerprint', () => {
  // The whole point of the key: a perpetual/scheduled task is regenerated with a
  // FRESH id every cadence, so a key derived from the id would re-file forever.
  it('is stable across a regenerated task with a new id', () => {
    const first = goalFidelityFingerprint({ id: 'task-1', taskType: 'user', description: 'Add retry caps\nmore', metadata: { app: 'comics' } });
    const second = goalFidelityFingerprint({ id: 'task-999', taskType: 'user', description: 'Add retry caps\ndifferent tail', metadata: { app: 'comics' } });
    expect(first).toBe(second);
  });

  it('separates different apps, task types, and objectives', () => {
    const base = { id: 'a', taskType: 'user', description: 'Add retry caps', metadata: { app: 'comics' } };
    const key = goalFidelityFingerprint(base);
    expect(goalFidelityFingerprint({ ...base, metadata: { app: 'bookloom' } })).not.toBe(key);
    expect(goalFidelityFingerprint({ ...base, taskType: 'internal' })).not.toBe(key);
    expect(goalFidelityFingerprint({ ...base, description: 'Rewrite the scheduler' })).not.toBe(key);
  });

  // A verdict that softens from `rethink` to `fix-first` between runs is the same
  // unfinished work; keying on it would file a second issue for one finding.
  it('does not vary with the verdict', () => {
    const task = { taskType: 'user', description: 'Add retry caps', metadata: { app: 'comics' } };
    expect(goalFidelityFingerprint(task)).toBe(goalFidelityFingerprint(task));
  });

  it('keeps the three-segment shape even with nothing to key on', () => {
    expect(goalFidelityFingerprint(undefined).split(':')).toHaveLength(3);
  });

  // The key is inlined rather than imported (the module is dependency-free so
  // `cosValidation.js` can take the settings enum without dragging the
  // investigation-task graph onto most of the server suite). This is what stops
  // the two formats drifting: the CoS task side dedupes with the real one.
  it('is byte-identical to the shared investigation fingerprint format', async () => {
    const { investigationFingerprint } = await import('./investigationTasks.js');
    const cases = [
      { taskType: 'user', description: 'Add retry caps', metadata: { app: 'comics' } },
      { taskType: 'internal', description: 'Rewrite the scheduler' },
      undefined,
    ];
    for (const task of cases) {
      const app = String(task?.metadata?.app ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
      const subject = String(task?.description ?? '').split('\n')[0].trim()
        .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
      expect(goalFidelityFingerprint(task)).toBe(investigationFingerprint({
        category: 'goal-fidelity',
        kind: task?.taskType,
        scope: app ? `${app}/${subject}` : subject,
      }));
    }
  });
});

describe('goalFidelityIssueMarker', () => {
  // Every forge parses `:` as a search-qualifier separator, and GitHub fails the
  // whole search on an unknown qualifier — a marker carrying one would make the
  // dedup read as "nothing filed" on every run.
  it('is a single token with no forge search metacharacters', () => {
    const marker = goalFidelityIssueMarker('goal-fidelity:user:comics/add-retry-caps');
    expect(marker).toMatch(/^portosgf-[a-f0-9]{40}$/);
    expect(marker).not.toContain('comics');
  });

  it('distinct fingerprints keep distinct markers', () => {
    expect(goalFidelityIssueMarker('goal-fidelity:user:a')).not.toBe(goalFidelityIssueMarker('goal-fidelity:user:b'));
  });
});

describe('issueMatchesGoalFidelityMarker', () => {
  const fingerprint = 'goal-fidelity:user:comics/add-retry-caps';
  const marker = goalFidelityIssueMarker(fingerprint);

  // The filer normalizes every tracker's rows to `{ title, body }` before the
  // matcher sees them, so this reads exactly that shape. Accepting JIRA's raw
  // `description` here too would let a mapper quietly stop normalizing without
  // anything failing.
  it('reads the normalized title and body, and only those', () => {
    expect(issueMatchesGoalFidelityMarker({ body: `text ${marker}` }, fingerprint)).toBe(true);
    expect(issueMatchesGoalFidelityMarker({ title: `text ${marker}`, body: '' }, fingerprint)).toBe(true);
    expect(issueMatchesGoalFidelityMarker({ description: `text ${marker}` }, fingerprint)).toBe(false);
  });

  it('does not match a different fingerprint or an unmarked issue', () => {
    expect(issueMatchesGoalFidelityMarker({ body: marker }, 'goal-fidelity:user:other')).toBe(false);
    expect(issueMatchesGoalFidelityMarker({ body: 'a goal-fidelity finding' }, fingerprint)).toBe(false);
    expect(issueMatchesGoalFidelityMarker(null, fingerprint)).toBe(false);
  });

  it('round-trips against the body the filer actually writes', () => {
    const { body } = buildGoalFidelityIssue({
      context: CONTEXT,
      task: { description: 'Add retry caps' }, review: review(), fingerprint,
    });
    expect(issueMatchesGoalFidelityMarker({ body }, fingerprint)).toBe(true);
  });
});

const CONTEXT = { base: 'a'.repeat(40), head: 'b'.repeat(40) };

describe('buildGoalFidelityIssue', () => {
  const fingerprint = 'goal-fidelity:user:comics/add-retry-caps';

  it('names the verdict, the objective, and both item lists', () => {
    const { title, body } = buildGoalFidelityIssue({
      context: CONTEXT,
      task: { description: 'Add retry caps to the queue\nplus detail', metadata: { prompt: 'Verify persisted retries.' } },
      review: review({ unrequested: ['a new settings page'] }),
      fingerprint,
    });
    expect(title).toBe('Goal-fidelity rethink: Add retry caps to the queue');
    expect(body).toContain('the retry cap the task named');
    expect(body).toContain('a new settings page');
    expect(body).toContain('The diff rewrites the scheduler instead.');
    expect(body).toContain('`ollama`');
    expect(body).toContain('plus detail');
    expect(body).toContain('Verify persisted retries.');
  });

  // A marker parked at the bottom drops out of exactly the long issues most
  // likely to be re-filed: the forge lister caps bodies at 8k before the dedup
  // rescan ever sees them.
  it('puts the dedup marker in the first 500 characters', () => {
    const { body } = buildGoalFidelityIssue({
      context: CONTEXT,
      task: { description: 'Add retry caps' },
      review: review({ missing: Array.from({ length: 10 }, (_, i) => 'x'.repeat(400) + i) }),
      fingerprint,
    });
    expect(body.slice(0, 500)).toContain(goalFidelityIssueMarker(fingerprint));
  });

  it('says so explicitly when the review judged a truncated diff', () => {
    const { body } = buildGoalFidelityIssue({
      context: CONTEXT,
      task: { description: 'Add retry caps' }, review: review({ diffTruncated: true }), fingerprint,
    });
    expect(body).toContain('TRUNCATED diff');
  });

  it('bounds the title and the body', () => {
    const { title, body } = buildGoalFidelityIssue({
      context: CONTEXT,
      task: { description: 'x'.repeat(5_000) },
      review: review({ missing: Array.from({ length: 40 }, () => 'y'.repeat(400)) }),
      fingerprint,
    });
    expect(title.length).toBeLessThanOrEqual(160);
    expect(body.length).toBeLessThanOrEqual(12_000);
  });

  it('reads as a finding even when the review named nothing specific', () => {
    const { body } = buildGoalFidelityIssue({
      context: CONTEXT,
      task: { description: 'Add retry caps' },
      review: review({ missing: [], unrequested: [], evidence: '' }),
      fingerprint,
    });
    expect(body).toContain('named nothing specific as missing');
    expect(body).toContain('recorded no evidence note');
  });
});

describe('buildGoalFidelityFollowUpTask', () => {
  const fingerprint = 'goal-fidelity:user:comics/add-retry-caps';
  const task = { id: 'task-7', description: 'Add retry caps' };

  // With an issue the investigator uses the project's normal PR flow, where
  // the tracker's own conventions live; without one it must work the finding
  // from this body, which is why the finding is restated in both shapes.
  it('points the agent at the filed issue when there is one', () => {
    const body = buildGoalFidelityFollowUpTask({
      task, review: review(), fingerprint, issue: { number: 42, url: 'https://example.com/issues/42' },
    });
    expect(body).toContain('#42');
    expect(body).toContain('https://example.com/issues/42');
    expect(body).toContain('normal PR flow');
  });

  it('restates the finding when no issue was filed', () => {
    const body = buildGoalFidelityFollowUpTask({ task, review: review(), fingerprint });
    expect(body).not.toContain('claim flow');
    expect(body).toContain('the retry cap the task named');
    expect(body).toContain('task-7');
  });

  it('carries the full bounded task objective into the investigator prompt', () => {
    const body = buildGoalFidelityFollowUpTask({
      task: {
        ...task,
        description: 'Complete the requested change',
        metadata: { prompt: 'Also verify the shipped outcome and preserve the existing contract.' },
      },
      review: review(),
      fingerprint,
    });
    expect(body).toContain('## What was asked\nComplete the requested change\n\nAlso verify the shipped outcome and preserve the existing contract.');
    expect(body).toContain('This is a diagnostic follow-up, not a re-run of the original agent task.');
  });

  it('makes independent verification the first action and calibrates false positives', () => {
    const body = buildGoalFidelityFollowUpTask({ task, review: review(), fingerprint });
    expect(body).toContain('Independently verify the finding against the original acceptance criteria');
    expect(body).toContain('Do not manufacture a code change or re-run the original task.');
    expect(body.indexOf('## Investigation mandate')).toBeLessThan(body.indexOf('## If the finding is right'));
  });

  // The fingerprint rides in the headline for the same reason the investigation
  // producer's does: `addTask`'s first-line dedup is what catches a repeat whose
  // metadata scan has not landed yet.
  it('carries the fingerprint in the first line', () => {
    const body = buildGoalFidelityFollowUpTask({ task, review: review(), fingerprint });
    expect(body.split('\n')[0]).toContain(fingerprint);
  });

  // The finding may be wrong — it is one local model's reading of a diff it saw
  // without the repository. An agent told only to reconcile will reconcile,
  // inventing a change to satisfy a finding with nothing behind it, so the
  // check-first instructions have to reach it BEFORE the reconcile instructions.
  it('puts the check-the-finding block ahead of the reconcile instructions', () => {
    const body = buildGoalFidelityFollowUpTask({
      task, review: review(), fingerprint, falsePositiveBlock: '## First: is the finding actually right?\nCheck it.',
    });
    expect(body.indexOf('## First: is the finding actually right?'))
      .toBeLessThan(body.indexOf('## If the finding is right'));
  });

  it('still produces a valid task when no report block was supplied', () => {
    // The block needs an API base the pure builder cannot resolve; a caller
    // without one must still get a task, not a body with a hole in it.
    const body = buildGoalFidelityFollowUpTask({ task, review: review(), fingerprint });
    expect(body).toContain('## If the finding is right');
    expect(body).not.toContain('\n\n\n');
  });
});

describe('formatGoalFidelityFollowUpSummary', () => {
  it('distinguishes a fresh file from a duplicate and from a failure', () => {
    expect(formatGoalFidelityFollowUpSummary({ issue: { number: 42 } })).toContain('filed #42');
    expect(formatGoalFidelityFollowUpSummary({ issue: { number: 42, duplicate: true } })).toContain('already tracks it');
    expect(formatGoalFidelityFollowUpSummary({ issueError: 'gh unreachable' })).toContain('gh unreachable');
  });

  it('reports both arms, since one can succeed while the other fails', () => {
    const summary = formatGoalFidelityFollowUpSummary({
      issueError: 'gh unreachable', task: { id: 'task-9' },
    });
    expect(summary).toContain('gh unreachable');
    expect(summary).toContain('task-9');
  });

  it('says nothing happened rather than nothing at all', () => {
    expect(formatGoalFidelityFollowUpSummary({})).toContain('nothing to do');
  });
});

// The settings schema is a `z.enum` over the server list, so a value the picker
// offers but the enum omits 400s the whole settings save — silently, from the
// user's point of view, since the rest of the form saved fine last time.
describe('client mirror of the follow-up trigger vocabulary', () => {
  it('matches the client leaf the picker reads', async () => {
    const client = await import('../../client/src/lib/reviewerPins.js');
    expect([...client.GOAL_FIDELITY_FOLLOW_UP_TRIGGERS]).toEqual([...GOAL_FIDELITY_FOLLOW_UP_TRIGGERS]);
    expect(client.DEFAULT_GOAL_FIDELITY_FOLLOW_UP_TRIGGER).toBe(DEFAULT_GOAL_FIDELITY_FOLLOW_UP_TRIGGER);
  });
});
