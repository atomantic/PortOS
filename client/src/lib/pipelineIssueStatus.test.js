import { describe, expect, it } from 'vitest';
import { describePipelineIssueStatus } from './pipelineIssueStatus.js';

const stages = ['idea', 'prose', 'comicScript'];
const labels = { idea: 'Idea', prose: 'Prose', comicScript: 'Comic' };
const issue = (statuses, extra = {}) => ({
  stages: Object.fromEntries(Object.entries(statuses).map(([id, status]) => [id, { status, ...extra[id] }])),
});
const describe_ = (statuses, opts = {}, extra) => describePipelineIssueStatus(issue(statuses, extra), { stages, labels, ...opts });

describe('describePipelineIssueStatus', () => {
  it('names the next stage waiting on the user, and drops the action when that stage is already open', () => {
    const waiting = describe_({ idea: 'ready', prose: 'empty', comicScript: 'empty' }, { activeStage: 'idea' });
    expect(waiting).toMatchObject({ tone: 'warn', headline: 'Next up: Prose · waiting for you to start it', next: { id: 'goto', stage: 'prose', label: 'Open Prose' } });
    expect(waiting.facts[0].label).toBe('1 of 3 stages ready');
    expect(describe_({ idea: 'ready', prose: 'empty' }, { activeStage: 'prose' }).next).toBeNull();
    expect(describe_({ idea: 'ready', prose: 'needs-review' }, { activeStage: 'idea' }))
      .toMatchObject({ tone: 'warn', headline: 'Prose needs your review', next: { stage: 'prose', label: 'Review Prose' } });
  });

  it('describes a live auto-run from its latest frame and offers cancel', () => {
    const running = describe_({ idea: 'ready' }, { autoRunActive: true, latest: { type: 'stage:start', stage: 'prose' } });
    expect(running).toMatchObject({ tone: 'muted', headline: 'Auto-run in progress · Generating Prose…', next: { id: 'cancel-auto-run' } });
    expect(describe_({}, { autoRunActive: true, latest: null }).headline).toBe('Auto-run in progress');
    expect(describe_({}, { autoRunActive: true, latest: { type: 'stage:error', stage: 'prose', error: 'quota' } }))
      .toMatchObject({ tone: 'error', headline: 'Auto-run in progress · Prose error — quota' });
  });

  it('reports a failed stage with its reason ahead of anything else', () => {
    const failed = describe_({ idea: 'ready', prose: 'error', comicScript: 'needs-review' }, { activeStage: 'idea' }, { prose: { errorMessage: 'Provider timed out' } });
    expect(failed).toMatchObject({ tone: 'error', headline: 'Prose failed · Provider timed out', next: { stage: 'prose', label: 'Open Prose' } });
  });

  it('reports generation in progress and completion without an action', () => {
    expect(describe_({ idea: 'ready', prose: 'generating' })).toMatchObject({ tone: 'muted', headline: 'Generating Prose', next: null });
    expect(describe_({ idea: 'ready', prose: 'edited', comicScript: 'ready' })).toMatchObject({ tone: 'ok', headline: 'All stages ready', next: null });
  });
});
