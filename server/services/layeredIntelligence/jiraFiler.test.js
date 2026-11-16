import { describe, it, expect, vi } from 'vitest';
import {
  slugMarker,
  extractSlugFromBody,
} from './dedup.js';
import {
  fileProposalToForge,
} from './forgeFiler.js';
import {
  normalizeJiraState,
  listJiraIssues,
  listJiraBlockingIssues,
  fileProposalToJira,
  resolveJiraBlockKey,
  applyJiraBlockingLabel,
  plannedWorkJql,
} from './jiraFiler.js';
import {
  LI_LABEL,
  LI_JIRA_BLOCKING_LABEL,
  PLANNED_WORK_LABEL,
} from './constants.js';

describe('Jira filer', () => {
  it('normalizeJiraState maps only the Done category to closed', () => {
    expect(normalizeJiraState('Done')).toBe('closed');
    expect(normalizeJiraState('done')).toBe('closed');
    expect(normalizeJiraState('In Progress')).toBe('open');
    expect(normalizeJiraState('To Do')).toBe('open');
    expect(normalizeJiraState('')).toBe('open');
    expect(normalizeJiraState(null)).toBe('open');
  });

  it('LI_JIRA_BLOCKING_LABEL is space-and-colon-free (Jira-safe)', () => {
    expect(LI_JIRA_BLOCKING_LABEL).toBe('layered-intelligence-blocking');
    expect(LI_JIRA_BLOCKING_LABEL).not.toMatch(/[\s:]/);
    // The base label is reused verbatim and is already Jira-safe.
    expect(LI_LABEL).not.toMatch(/[\s:]/);
  });

  it('listJiraIssues maps rows and reports ok:true on a successful search', async () => {
    const search = vi.fn().mockResolvedValue([
      { key: 'PROJ-1', summary: 'Do a thing', description: `body ${slugMarker('do-a-thing')}`, statusCategory: 'To Do', resolutiondate: null },
      { key: 'PROJ-2', summary: 'Done thing', description: 'no marker', statusCategory: 'Done', resolutiondate: '2026-07-01T00:00:00.000+0000' }
    ]);
    const res = await listJiraIssues({ instanceId: 'i', projectKey: 'PROJ', search });
    expect(res.ok).toBe(true);
    expect(res.issues[0]).toMatchObject({ number: 'PROJ-1', state: 'open', slug: 'do-a-thing' });
    expect(res.issues[1]).toMatchObject({ number: 'PROJ-2', state: 'closed', closedAt: '2026-07-01T00:00:00.000+0000' });
    // JQL scopes to the project and base LI label.
    expect(search.mock.calls[0][1]).toContain('project = "PROJ"');
    expect(search.mock.calls[0][1]).toContain(`labels = "${LI_LABEL}"`);
  });

  it('listJiraIssues reports ok:false on a thrown search (failed != empty)', async () => {
    const search = vi.fn().mockRejectedValue(new Error('boom'));
    const res = await listJiraIssues({ instanceId: 'i', projectKey: 'PROJ', search });
    expect(res.ok).toBe(false);
    expect(res.issues).toEqual([]);
  });

  it('listJiraIssues reports ok:false when instance/project missing', async () => {
    expect((await listJiraIssues({ instanceId: '', projectKey: 'PROJ' })).ok).toBe(false);
    expect((await listJiraIssues({ instanceId: 'i', projectKey: '' })).ok).toBe(false);
  });

  it('listJiraBlockingIssues filters to the blocking label and non-Done', async () => {
    const search = vi.fn().mockResolvedValue([{ key: 'PROJ-9', summary: 'blocker', statusCategory: 'In Progress' }]);
    const res = await listJiraBlockingIssues({ instanceId: 'i', projectKey: 'PROJ', search });
    expect(res.ok).toBe(true);
    expect(res.issues[0]).toMatchObject({ number: 'PROJ-9', state: 'open' });
    expect(search.mock.calls[0][1]).toContain(`labels = "${LI_JIRA_BLOCKING_LABEL}"`);
    expect(search.mock.calls[0][1]).toContain('statusCategory != Done');
  });

  it('fileProposalToJira embeds the slug marker + LI label and returns the key/url', async () => {
    const create = vi.fn().mockResolvedValue({ success: true, ticketId: 'PROJ-10', url: 'https://j/browse/PROJ-10' });
    const res = await fileProposalToJira({ instanceId: 'i', projectKey: 'PROJ', title: 'T', body: 'B', slug: 'add-x', create });
    expect(res).toEqual({ success: true, key: 'PROJ-10', url: 'https://j/browse/PROJ-10' });
    const payload = create.mock.calls[0][1];
    expect(payload).toMatchObject({ projectKey: 'PROJ', summary: 'T', issueType: 'Task', labels: [LI_LABEL] });
    expect(payload.description).toContain(slugMarker('add-x'));
    expect(payload.description).toContain('B');
  });

  // #8460 — the Jira filer shares the forge scrubber, and both filers append
  // the slug marker after it: a date-bearing slug would otherwise collapse to
  // `<phone>` and lose the dedup identity the next run reads back.
  it('fileProposalToJira redacts PII but keeps a date-bearing slug marker intact', async () => {
    const create = vi.fn().mockResolvedValue({ success: true, ticketId: 'PROJ-12', url: 'https://j/browse/PROJ-12' });
    await fileProposalToJira({
      instanceId: 'i', projectKey: 'PROJ', slug: 'release-2026-09-25', create,
      title: 'Mail alice@example.com', body: 'Peer 192.0.2.10 on host-1.example.ts.net, call +1 555 010 0000.',
    });
    const { summary, description } = create.mock.calls[0][1];
    for (const leak of ['alice@example.com', '192.0.2.10', 'host-1.example.ts.net', '+1 555 010 0000']) {
      expect(`${summary}\n${description}`).not.toContain(leak);
    }
    expect(extractSlugFromBody(description)).toBe('release-2026-09-25');
  });

  it('fileProposalToForge keeps a date-bearing slug marker intact through the scrubber', async () => {
    const exec = vi.fn().mockResolvedValue({ code: 0, stdout: 'https://github.com/o/r/issues/5\n' });
    await fileProposalToForge({ cli: 'gh', cwd: '/x', title: 'T', body: 'B', slug: 'release-2026-09-25', model: 'light', effort: 'low', exec });
    const createCall = exec.mock.calls.find(c => c[1][0] === 'issue')[1];
    expect(extractSlugFromBody(createCall[createCall.indexOf('--body') + 1])).toBe('release-2026-09-25');
  });

  it('fileProposalToJira forwards hyphenated dispatch + contributor labels without deriving them', async () => {
    const create = vi.fn().mockResolvedValue({ success: true, ticketId: 'PROJ-11', url: 'https://j/browse/PROJ-11' });
    await fileProposalToJira({
      instanceId: 'i', projectKey: 'PROJ', title: 'T', body: 'B', slug: 'add-x',
      model: 'heavy', effort: 'low', goodFirstIssue: true, helpWanted: true, hardwareRequirements: ['macos', 'apple-silicon'], create
    });
    expect(create.mock.calls[0][1].labels).toEqual([
      LI_LABEL, 'model-heavy', 'effort-low', 'good-first-issue', 'help-wanted', 'macos', 'apple-silicon'
    ]);
  });

  it('fileProposalToJira surfaces a create failure rather than throwing', async () => {
    const create = vi.fn().mockRejectedValue(new Error('403'));
    const res = await fileProposalToJira({ instanceId: 'i', projectKey: 'PROJ', title: 'T', body: 'B', slug: 's', create });
    expect(res.success).toBe(false);
    expect(res.error).toContain('403');
  });

  it('fileProposalToJira refuses when instance/project missing', async () => {
    const res = await fileProposalToJira({ instanceId: '', projectKey: 'PROJ', title: 'T', body: 'B', slug: 's' });
    expect(res.success).toBe(false);
  });

  it('resolveJiraBlockKey resolves "this" to the filed key and an integer to <project>-<n>', () => {
    expect(resolveJiraBlockKey({ blockOnIssue: 'this' }, 'PROJ-10', 'PROJ')).toBe('PROJ-10');
    expect(resolveJiraBlockKey({ blockOnIssue: 42 }, null, 'PROJ')).toBe('PROJ-42');
    // "this" with nothing filed → null; integer with no project → null; no pause → null.
    expect(resolveJiraBlockKey({ blockOnIssue: 'this' }, null, 'PROJ')).toBe(null);
    expect(resolveJiraBlockKey({ blockOnIssue: 42 }, null, '')).toBe(null);
    expect(resolveJiraBlockKey(null, 'PROJ-1', 'PROJ')).toBe(null);
  });

  it('applyJiraBlockingLabel adds the Jira blocking label to the key', async () => {
    const addLabel = vi.fn().mockResolvedValue({ success: true });
    const res = await applyJiraBlockingLabel({ instanceId: 'i', key: 'PROJ-10', addLabel });
    expect(res.success).toBe(true);
    expect(addLabel).toHaveBeenCalledWith('i', 'PROJ-10', [LI_JIRA_BLOCKING_LABEL]);
  });

  it('applyJiraBlockingLabel refuses without a key and surfaces a thrown error', async () => {
    expect((await applyJiraBlockingLabel({ instanceId: 'i', key: null })).success).toBe(false);
    const addLabel = vi.fn().mockRejectedValue(new Error('nope'));
    const res = await applyJiraBlockingLabel({ instanceId: 'i', key: 'PROJ-1', addLabel });
    expect(res.success).toBe(false);
    expect(res.error).toContain('nope');
  });
});

describe('plannedWorkJql', () => {
  it('filters to not-Done plan-labeled tickets and orders by priority', () => {
    const jql = plannedWorkJql('PROJ');
    expect(jql).toContain('project = "PROJ"');
    expect(jql).toContain('statusCategory != Done');
    expect(jql).toContain('ORDER BY priority DESC');
  });

  it('filters on the plan label — parity with the forge, not "every open ticket"', () => {
    // Without this the source would return the whole untriaged backlog under a
    // header claiming the user committed to it, and tell the reasoner to suppress
    // against essentially the entire tracker.
    expect(plannedWorkJql('PROJ')).toContain(`labels = "${PLANNED_WORK_LABEL}"`);
  });

  it('does NOT reference openSprints or filter on priority NAMES (both hard-400 on some projects)', () => {
    const jql = plannedWorkJql('PROJ');
    expect(jql).not.toContain('openSprints');
    expect(jql).not.toContain('priority in');
  });

  it('escapes the project key', () => {
    expect(plannedWorkJql('A"B')).toContain('A\\"B');
  });
});

describe('listJiraIssues jql override (#2698)', () => {
  it('defaults to the LI-label JQL and passes no search options', async () => {
    const search = vi.fn().mockResolvedValue([]);
    await listJiraIssues({ instanceId: 'i1', projectKey: 'PROJ', search });
    expect(search).toHaveBeenCalledWith('i1', expect.stringContaining(`labels = "${LI_LABEL}"`));
  });

  it('uses an explicit jql + search options when given', async () => {
    const search = vi.fn().mockResolvedValue([]);
    await listJiraIssues({
      instanceId: 'i1', projectKey: 'PROJ', jql: 'CUSTOM JQL', searchOptions: { fields: 'summary,priority' }, search
    });
    expect(search).toHaveBeenCalledWith('i1', 'CUSTOM JQL', { fields: 'summary,priority' });
  });

  it('maps priority + labels, and keeps an absent priority null', async () => {
    const search = vi.fn().mockResolvedValue([
      { key: 'PROJ-1', summary: 'A', statusCategory: 'To Do', priority: 'High', labels: ['plan'] },
      { key: 'PROJ-2', summary: 'B', statusCategory: 'To Do' }
    ]);
    const { issues } = await listJiraIssues({ instanceId: 'i1', projectKey: 'PROJ', search });
    expect(issues[0].priority).toBe('High');
    expect(issues[0].labels).toEqual(['plan']);
    expect(issues[1].priority).toBeNull();
    expect(issues[1].labels).toEqual([]);
  });
});
