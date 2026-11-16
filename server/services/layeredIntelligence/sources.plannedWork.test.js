import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  defaultLayeredIntelligenceConfig,
  getEffectiveConfig,
} from './config.js';
import {
  gatherSources,
  extractPlannedPlanItems,
  formatPlannedWork,
  gatherPlannedWork,
  plannedWorkUnavailable,
  hasPlannedWorkListing,
} from './sources.js';
import {
  plannedWorkJql,
} from './jiraFiler.js';
import {
  PLANNED_WORK_LABEL,
  PLANNED_WORK_MAX_ITEMS,
  PLANNED_WORK_NONE,
  PLANNED_WORK_UNAVAILABLE_PREFIX,
} from './constants.js';

describe('extractPlannedPlanItems', () => {
  it('extracts unchecked items only — a done item is not pending work', () => {
    const plan = [
      '# Plan',
      '## Next Up',
      '- [ ] Add a widget',
      '- [x] Already shipped',
      '* [ ] Star bullet item',
      'not a list item'
    ].join('\n');
    expect(extractPlannedPlanItems(plan).map(i => i.title)).toEqual(['Add a widget', 'Star bullet item']);
  });

  it('collapses whitespace and yields the planned-item shape', () => {
    expect(extractPlannedPlanItems('- [ ]   Do    the   thing  ')[0]).toEqual({
      number: null, title: 'Do the thing', labels: [], priority: null
    });
  });

  it('returns [] for a non-string or an empty/checkbox-less plan', () => {
    expect(extractPlannedPlanItems(null)).toEqual([]);
    expect(extractPlannedPlanItems('# Plan\n\nJust prose.')).toEqual([]);
    // A checkbox with no text is not an item.
    expect(extractPlannedPlanItems('- [ ]   ')).toEqual([]);
  });
});

describe('formatPlannedWork', () => {
  it('renders number, title, priority and labels', () => {
    const out = formatPlannedWork([{ number: 12, title: 'Ship X', labels: ['plan', 'p1'], priority: 'p1' }]);
    expect(out).toContain('- #12 Ship X');
    expect(out).toContain('priority: p1');
    expect(out).toContain('labels: plan, p1');
  });

  it('omits the priority/labels parens when there is nothing to say', () => {
    const out = formatPlannedWork([{ number: null, title: 'Bare item', labels: [], priority: null }]);
    const itemLine = out.split('\n').find(l => l.startsWith('- '));
    expect(itemLine).toBe('- Bare item');
  });

  it('reports the FULL count when truncating so a partial list never reads as the whole backlog', () => {
    const many = Array.from({ length: 40 }, (_, n) => ({ number: n + 1, title: `Item ${n + 1}`, labels: [], priority: null }));
    const out = formatPlannedWork(many);
    expect(out).toContain('40 items');
    expect(out).toContain(`showing the top ${PLANNED_WORK_MAX_ITEMS}`);
    expect(out).toContain('- #15 Item 15');
    expect(out).not.toContain('Item 16');
  });

  it('bounds the rendered block', () => {
    const many = Array.from({ length: 15 }, (_, n) => ({ number: n, title: 'x'.repeat(2000), labels: [], priority: null }));
    expect(formatPlannedWork(many).length).toBeLessThanOrEqual(8000);
  });

  it('says "nothing planned" EXPLICITLY for a real empty result (not an omitted block)', () => {
    expect(formatPlannedWork([])).toBe(PLANNED_WORK_NONE);
    expect(formatPlannedWork(undefined)).toBe(PLANNED_WORK_NONE);
    expect(PLANNED_WORK_NONE).toContain('read successfully');
  });
});

describe('plannedWorkUnavailable', () => {
  it('tells the reasoner NOT to read a failed read as "nothing planned"', () => {
    const msg = plannedWorkUnavailable('the gh issue list failed');
    expect(msg).toContain('could NOT be read');
    expect(msg).toContain('the gh issue list failed');
    // The whole point of the sentinel: it must be distinguishable from the
    // legitimately-empty rendering.
    expect(msg).not.toBe(PLANNED_WORK_NONE);
  });
});

describe('hasPlannedWorkListing', () => {
  it('is true only for a real backlog listing', () => {
    expect(hasPlannedWorkListing('2 item(s) of actively-planned work:\n- #3 Ship X')).toBe(true);
  });

  it('is false for BOTH sentinels — neither is a backlog to go review', () => {
    // "nothing is planned" and "could not be read" both render in the prompt and
    // both mean something, but telling the reasoner "review the plannedWork source
    // — you may be overlapping committed work" under either is a contradiction.
    expect(hasPlannedWorkListing(PLANNED_WORK_NONE)).toBe(false);
    expect(hasPlannedWorkListing(plannedWorkUnavailable('the gh issue list failed'))).toBe(false);
  });

  it('is false for an absent / blank / non-string source', () => {
    expect(hasPlannedWorkListing(undefined)).toBe(false);
    expect(hasPlannedWorkListing(null)).toBe(false);
    expect(hasPlannedWorkListing('   ')).toBe(false);
    expect(hasPlannedWorkListing(['#3'])).toBe(false);
  });

  it('tracks the sentinels through their constructors (no drifting copy of the text)', () => {
    expect(plannedWorkUnavailable('x').startsWith(PLANNED_WORK_UNAVAILABLE_PREFIX)).toBe(true);
  });
});

describe('gatherPlannedWork', () => {
  it('forge: queries the plan label + open state and summarizes with derived priority', async () => {
    const listForge = vi.fn().mockResolvedValue({
      ok: true,
      issues: [
        { number: 3, title: 'Planned A', state: 'open', labels: ['plan', 'priority: high'] },
        { number: 4, title: 'Planned B', state: 'open', labels: ['plan'] }
      ]
    });
    const out = await gatherPlannedWork({ filer: 'forge', forgeCli: 'gh', cwd: '/repo', listForge });
    expect(listForge).toHaveBeenCalledWith({ cli: 'gh', cwd: '/repo', label: PLANNED_WORK_LABEL, state: 'open' });
    expect(out).toContain('- #3 Planned A');
    expect(out).toContain('priority: high');
    expect(out).toContain('- #4 Planned B');
  });

  it('forge: filters out a closed issue the tracker still returned', async () => {
    const listForge = vi.fn().mockResolvedValue({
      ok: true,
      issues: [
        { number: 3, title: 'Open one', state: 'open', labels: [] },
        { number: 5, title: 'Done one', state: 'closed', labels: [] }
      ]
    });
    const out = await gatherPlannedWork({ filer: 'forge', forgeCli: 'glab', cwd: '/repo', listForge });
    expect(out).toContain('Open one');
    expect(out).not.toContain('Done one');
    expect(out).toContain('1 item(s)');
  });

  it('forge: a FAILED read renders the unavailable sentinel, NOT "nothing planned"', async () => {
    const listForge = vi.fn().mockResolvedValue({ ok: false, issues: [] });
    const out = await gatherPlannedWork({ filer: 'forge', forgeCli: 'gh', cwd: '/repo', listForge });
    expect(out).toContain('could NOT be read');
    expect(out).not.toBe(PLANNED_WORK_NONE);
  });

  it('forge: a SUCCESSFUL empty read renders "nothing planned" (distinct from a failure)', async () => {
    const listForge = vi.fn().mockResolvedValue({ ok: true, issues: [] });
    expect(await gatherPlannedWork({ filer: 'forge', forgeCli: 'gh', cwd: '/repo', listForge })).toBe(PLANNED_WORK_NONE);
  });

  it('jira: uses the planned-work JQL, requests the priority field, and prefers it over labels', async () => {
    const listJira = vi.fn().mockResolvedValue({
      ok: true,
      issues: [{ number: 'PROJ-9', title: 'Jira item', state: 'open', labels: ['low'], priority: 'Highest' }]
    });
    const out = await gatherPlannedWork({
      filer: 'jira', jira: { instanceId: 'i1', projectKey: 'PROJ' }, listJira
    });
    const arg = listJira.mock.calls[0][0];
    expect(arg.jql).toBe(plannedWorkJql('PROJ'));
    expect(arg.searchOptions.fields).toContain('priority');
    // Jira's real priority field wins over the label-derived fallback.
    expect(out).toContain('priority: Highest');
    expect(out).toContain('- #PROJ-9 Jira item');
  });

  it('jira: falls back to a label-derived priority when the field is absent', async () => {
    const listJira = vi.fn().mockResolvedValue({
      ok: true,
      issues: [{ number: 'PROJ-9', title: 'J', state: 'open', labels: ['p2'], priority: null }]
    });
    const out = await gatherPlannedWork({ filer: 'jira', jira: { instanceId: 'i1', projectKey: 'PROJ' }, listJira });
    expect(out).toContain('priority: p2');
  });

  it('jira: a FAILED search renders the unavailable sentinel', async () => {
    const listJira = vi.fn().mockResolvedValue({ ok: false, issues: [] });
    const out = await gatherPlannedWork({ filer: 'jira', jira: { instanceId: 'i1', projectKey: 'PROJ' }, listJira });
    expect(out).toContain('could NOT be read');
  });

  it('returns null when the tracker coords are unusable (source simply does not apply)', async () => {
    expect(await gatherPlannedWork({ filer: 'forge', forgeCli: null, cwd: '/repo' })).toBeNull();
    expect(await gatherPlannedWork({ filer: 'jira', jira: null })).toBeNull();
    expect(await gatherPlannedWork({ filer: 'plan', cwd: null })).toBeNull();
    expect(await gatherPlannedWork({})).toBeNull();
  });

  describe('plan tracker', () => {
    let dir;
    beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'lil-planned-')); });
    afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

    it('summarizes PLAN.md unchecked items', async () => {
      await writeFile(join(dir, 'PLAN.md'), '# P\n- [ ] Committed thing\n- [x] Done thing\n');
      const out = await gatherPlannedWork({ filer: 'plan', cwd: dir });
      expect(out).toContain('- Committed thing');
      expect(out).not.toContain('Done thing');
    });

    it('an ABSENT PLAN.md is a real "nothing planned"', async () => {
      expect(await gatherPlannedWork({ filer: 'plan', cwd: dir })).toBe(PLANNED_WORK_NONE);
    });

    it('a PRESENT-but-unreadable PLAN.md is a FAILURE, not "nothing planned"', async () => {
      await writeFile(join(dir, 'PLAN.md'), '- [ ] x');
      // tryReadFile collapses every failure to null; the existsSync probe is what
      // keeps "unreadable" from masquerading as "no plan at all".
      const out = await gatherPlannedWork({ filer: 'plan', cwd: dir, readFileFn: async () => null });
      expect(out).toContain('could NOT be read');
      expect(out).not.toBe(PLANNED_WORK_NONE);
    });
  });
});

describe('gatherSources plannedWork wiring (#2698)', () => {
  let dir;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'lil-pw-src-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it('gathers plannedWork when the source is on and a tracker is supplied', async () => {
    await writeFile(join(dir, 'PLAN.md'), '- [ ] Committed thing\n');
    const out = await gatherSources(
      { repoPath: dir },
      { sources: { plannedWork: true } },
      { tracker: { filer: 'plan', cwd: dir } }
    );
    expect(out.plannedWork).toContain('Committed thing');
  });

  it('skips plannedWork when the source is off', async () => {
    await writeFile(join(dir, 'PLAN.md'), '- [ ] Committed thing\n');
    const out = await gatherSources(
      { repoPath: dir },
      { sources: { plannedWork: false } },
      { tracker: { filer: 'plan', cwd: dir } }
    );
    expect(out.plannedWork).toBeUndefined();
  });

  it('skips plannedWork when no tracker context was resolved', async () => {
    await writeFile(join(dir, 'PLAN.md'), '- [ ] Committed thing\n');
    const out = await gatherSources({ repoPath: dir }, { sources: { plannedWork: true } });
    expect(out.plannedWork).toBeUndefined();
  });

  it('is on by default for every app', () => {
    expect(defaultLayeredIntelligenceConfig(false).sources.plannedWork).toBe(true);
    expect(defaultLayeredIntelligenceConfig(true).sources.plannedWork).toBe(true);
  });

  it('reaches an existing install that stored sources before the key existed', () => {
    // getEffectiveConfig spreads defaults under stored sources, so no migration
    // is needed for the new key — but an explicit opt-out must still survive.
    const stored = { layeredIntelligence: { sources: { goals: false } } };
    expect(getEffectiveConfig(stored).sources.plannedWork).toBe(true);
    const optedOut = { layeredIntelligence: { sources: { plannedWork: false } } };
    expect(getEffectiveConfig(optedOut).sources.plannedWork).toBe(false);
  });
});
