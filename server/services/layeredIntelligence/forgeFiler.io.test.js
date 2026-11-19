import { describe, it, expect, vi } from 'vitest';
import { homedir } from 'os';
import {
  LI_LABEL,
  LI_BLOCKING_LABEL,
} from './constants.js';
import {
  slugMarker,
} from './dedup.js';
import {
  normalizeIssueState,
  listForgeIssues,
  extractClosingComment,
  extractImplementingPr,
  repoSlugFromUrl,
  readImplementingPrState,
  listBlockingIssues,
  fileProposalToForge,
  ensureForgeLabels,
  applyBlockingLabel,
  normalizeIssueLabels,
  extractIssuePriority,
} from './forgeFiler.js';

describe('normalizeIssueState', () => {
  it('maps GitLab "opened" and GitHub "open" to open', () => {
    expect(normalizeIssueState('opened')).toBe('open');
    expect(normalizeIssueState('OPEN')).toBe('open');
  });
  it('maps closed/locked to closed', () => {
    expect(normalizeIssueState('closed')).toBe('closed');
    expect(normalizeIssueState('locked')).toBe('closed');
  });
  it('treats unknown/empty as open (fail-open so dedup does not miss)', () => {
    expect(normalizeIssueState('')).toBe('open');
    expect(normalizeIssueState(undefined)).toBe('open');
  });
});

describe('forge I/O (injected exec)', () => {
  it('listForgeIssues parses gh JSON and extracts slugs', async () => {
    const exec = vi.fn().mockResolvedValue({
      code: 0,
      stdout: JSON.stringify([
        { number: 1, title: 'A', body: `x ${slugMarker('slug-a')}`, state: 'OPEN', closedAt: null },
        { number: 2, title: 'B', body: 'no slug', state: 'CLOSED', closedAt: '2026-07-01T00:00:00Z' }
      ])
    });
    const { ok, issues } = await listForgeIssues({ cli: 'gh', cwd: '/x', exec });
    expect(ok).toBe(true);
    expect(issues[0].slug).toBe('slug-a');
    expect(issues[0].state).toBe('open');
    expect(issues[1].closedAt).toBe('2026-07-01T00:00:00Z');
  });

  it('listForgeIssues requests comments and threads the closing comment on gh rows (#2748)', async () => {
    const exec = vi.fn().mockResolvedValue({
      code: 0,
      stdout: JSON.stringify([
        {
          number: 3,
          title: 'C',
          body: `x ${slugMarker('slug-c')}`,
          state: 'CLOSED',
          closedAt: '2026-07-02T00:00:00Z',
          comments: [
            { body: 'Interesting idea.' },
            { body: 'Closing — this is out of scope for the app.' }
          ]
        }
      ])
    });
    const { ok, issues } = await listForgeIssues({ cli: 'gh', cwd: '/x', exec });
    expect(ok).toBe(true);
    // The batched list call must ask gh for `comments` (closing-comment signal) and
    // `closedByPullRequestsReferences` (implementing-PR ref, #2748 deliverable 2) so
    // no extra fetch is needed for either.
    expect(exec.mock.calls[0][1]).toContain('number,title,body,state,stateReason,closedAt,url,labels,comments,closedByPullRequestsReferences');
    // The LAST comment (closest to the close) becomes the classifier's signal.
    expect(issues[0].closingComment).toBe('Closing — this is out of scope for the app.');
  });

  it('listForgeIssues leaves closingComment null when gh returns no comments', async () => {
    const exec = vi.fn().mockResolvedValue({
      code: 0,
      stdout: JSON.stringify([{ number: 4, title: 'D', body: `x ${slugMarker('slug-d')}`, state: 'CLOSED', comments: [] }])
    });
    const { issues } = await listForgeIssues({ cli: 'gh', cwd: '/x', exec });
    expect(issues[0].closingComment).toBeNull();
  });

  it('extractClosingComment returns the last non-empty comment body, else null', () => {
    expect(extractClosingComment([{ body: 'first' }, { body: '  ' }, { body: 'last real' }])).toBe('last real');
    expect(extractClosingComment([{ body: 'only' }])).toBe('only');
    expect(extractClosingComment([])).toBeNull();
    expect(extractClosingComment(null)).toBeNull();
    expect(extractClosingComment([{ body: '   ' }, { body: null }])).toBeNull();
  });

  it('listForgeIssues threads the implementing-PR number from closedByPullRequestsReferences (#2748)', async () => {
    const exec = vi.fn().mockResolvedValue({
      code: 0,
      stdout: JSON.stringify([
        {
          number: 5,
          title: 'E',
          body: `x ${slugMarker('slug-e')}`,
          state: 'CLOSED',
          closedByPullRequestsReferences: [{ number: 900 }, { number: 901 }]
        },
        { number: 6, title: 'F', body: `x ${slugMarker('slug-f')}`, state: 'CLOSED' }
      ])
    });
    const { issues } = await listForgeIssues({ cli: 'gh', cwd: '/x', exec });
    // The batched call must ALSO ask gh for the closing-PR refs — no extra round-trip.
    expect(exec.mock.calls[0][1]).toContain('number,title,body,state,stateReason,closedAt,url,labels,comments,closedByPullRequestsReferences');
    // The LAST ref (most recent linked PR) is the implementing handle.
    expect(issues[0].implementingPr).toBe(901);
    // No refs ⇒ null (glab rows, or a hand-closed issue) — falls through cleanly.
    expect(issues[1].implementingPr).toBeNull();
  });

  it('extractImplementingPr returns the last positive-integer ref, else null', () => {
    expect(extractImplementingPr([{ number: 10 }, { number: 11 }])).toBe(11);
    expect(extractImplementingPr([{ number: 12 }, { number: null }])).toBe(12);
    expect(extractImplementingPr([])).toBeNull();
    expect(extractImplementingPr(null)).toBeNull();
    expect(extractImplementingPr([{ number: 0 }, { number: -3 }])).toBeNull();
  });

  it('extractImplementingPr skips a cross-repo reference when the issue repo is known (codex P2)', () => {
    const refs = [
      { number: 55, repository: { owner: { login: 'someone' }, name: 'other-repo' } },
      { number: 56, repository: { owner: { login: 'atomantic' }, name: 'PortOS' } }
    ];
    // Same-repo ref wins even though the cross-repo one is later in the list.
    expect(extractImplementingPr(refs, 'atomantic/PortOS')).toBe(56);
    // A ref from another repo alone is rejected — `gh pr view 55` in cwd would read the
    // wrong PR. Falls through to null rather than mis-diagnosing.
    expect(extractImplementingPr([refs[0]], 'atomantic/PortOS')).toBeNull();
    // Repo match is case-insensitive (GitHub slugs are).
    expect(extractImplementingPr([{ number: 57, url: 'https://github.com/Atomantic/portos/pull/57' }], 'atomantic/PortOS')).toBe(57);
    // Unknown self-repo, or a ref with no repo info, degrades to accepting (same-repo
    // is the common case) — preserves prior behavior.
    expect(extractImplementingPr(refs, null)).toBe(56);
    expect(extractImplementingPr([{ number: 58 }], 'atomantic/PortOS')).toBe(58);
  });

  it('repoSlugFromUrl parses owner/repo from an issue or PR URL, host-agnostic', () => {
    expect(repoSlugFromUrl('https://github.com/atomantic/PortOS/issues/2748')).toBe('atomantic/portos');
    expect(repoSlugFromUrl('https://github.com/owner/repo/pull/5')).toBe('owner/repo');
    expect(repoSlugFromUrl('https://github.example.com/org/proj/issues/9')).toBe('org/proj');
    expect(repoSlugFromUrl('https://github.com/owner/repo')).toBeNull();
    expect(repoSlugFromUrl(null)).toBeNull();
  });

  it('readImplementingPrState parses gh pr view, and is gh-only (#2748)', async () => {
    const exec = vi.fn().mockResolvedValue({
      code: 0,
      stdout: JSON.stringify({ state: 'CLOSED', mergeStateStatus: 'DIRTY', statusCheckRollup: [{ conclusion: 'FAILURE' }] })
    });
    const view = await readImplementingPrState({ cli: 'gh', cwd: '/x', number: 42, exec });
    expect(exec).toHaveBeenCalledWith('gh', ['pr', 'view', '42', '--json', 'state,mergeStateStatus,statusCheckRollup'], { cwd: '/x', env: undefined });
    expect(view).toEqual({ state: 'CLOSED', mergeStateStatus: 'DIRTY', statusCheckRollup: [{ conclusion: 'FAILURE' }] });

    // glab carries no PR handle → no fetch, null.
    const glabExec = vi.fn();
    expect(await readImplementingPrState({ cli: 'glab', number: 42, exec: glabExec })).toBeNull();
    expect(glabExec).not.toHaveBeenCalled();
    // A non-integer number is a caller bug → null without fetching.
    expect(await readImplementingPrState({ cli: 'gh', number: null, exec: glabExec })).toBeNull();
  });

  it('readImplementingPrState returns null on a CLI error or unparseable output (#2748)', async () => {
    expect(await readImplementingPrState({ cli: 'gh', number: 1, exec: vi.fn().mockResolvedValue({ code: 1, stdout: '' }) })).toBeNull();
    expect(await readImplementingPrState({ cli: 'gh', number: 1, exec: vi.fn().mockResolvedValue({ code: 0, stdout: 'not json' }) })).toBeNull();
    expect(await readImplementingPrState({ cli: 'gh', number: 1, exec: vi.fn().mockResolvedValue({ code: 0, stdout: '   ' }) })).toBeNull();
  });

  it('listForgeIssues normalizes GitLab "opened" state to open', async () => {
    const exec = vi.fn().mockResolvedValue({
      code: 0,
      stdout: JSON.stringify([{ iid: 7, title: 'G', description: `d ${slugMarker('g-slug')}`, state: 'opened' }])
    });
    const { ok, issues } = await listForgeIssues({ cli: 'glab', cwd: '/x', exec });
    expect(ok).toBe(true);
    expect(issues[0].number).toBe(7);
    expect(issues[0].state).toBe('open'); // 'opened' → 'open'
    expect(issues[0].slug).toBe('g-slug');
  });

  it('listForgeIssues signals ok:false on CLI failure (tracker unavailable ≠ empty)', async () => {
    const exec = vi.fn().mockResolvedValue({ code: 1, stdout: '' });
    expect(await listForgeIssues({ cli: 'gh', cwd: '/x', exec })).toEqual({ ok: false, issues: [] });
  });

  it('listForgeIssues signals ok:true, [] on a successful empty read', async () => {
    const exec = vi.fn().mockResolvedValue({ code: 0, stdout: '' });
    expect(await listForgeIssues({ cli: 'gh', cwd: '/x', exec })).toEqual({ ok: true, issues: [] });
  });

  it('listForgeIssues signals ok:false on unparseable output', async () => {
    const exec = vi.fn().mockResolvedValue({ code: 0, stdout: 'not json' });
    expect(await listForgeIssues({ cli: 'gh', cwd: '/x', exec })).toEqual({ ok: false, issues: [] });
  });

  it('listBlockingIssues uses the blocking label and normalizes state', async () => {
    const exec = vi.fn().mockResolvedValue({ code: 0, stdout: JSON.stringify([{ number: 5, state: 'open' }]) });
    const res = await listBlockingIssues({ cli: 'gh', cwd: '/x', exec });
    expect(res).toEqual({ ok: true, issues: [{ number: 5, title: '', state: 'open' }] });
    expect(exec.mock.calls[0][1]).toContain(LI_BLOCKING_LABEL);
  });

  it('ensureForgeLabels creates both labels for gh', async () => {
    const exec = vi.fn().mockResolvedValue({ code: 0, stdout: '' });
    await ensureForgeLabels({ cli: 'gh', cwd: '/x', exec });
    const created = exec.mock.calls.map(c => c[1][2]); // gh: ['label','create',<name>,...]
    expect(created).toContain(LI_LABEL);
    expect(created).toContain(LI_BLOCKING_LABEL);
    expect(exec.mock.calls[0][1]).not.toContain('--force');
  });

  it('ensureForgeLabels accepts an existing label without overwriting it', async () => {
    const exec = vi.fn().mockResolvedValue({
      code: 1,
      stdout: '',
      stderr: 'label with this name already exists'
    });
    await expect(ensureForgeLabels({ cli: 'gh', cwd: '/x', exec })).resolves.toBeUndefined();
    expect(exec).toHaveBeenCalledTimes(2);
    expect(exec.mock.calls[0][1]).not.toContain('--force');
  });

  it('ensureForgeLabels surfaces label-create failures other than duplicates', async () => {
    const exec = vi.fn().mockResolvedValue({ code: 1, stdout: '', stderr: 'HTTP 403: Resource not accessible' });
    await expect(ensureForgeLabels({ cli: 'gh', cwd: '/x', exec })).rejects.toThrow('HTTP 403');
  });

  it('fileProposalToForge embeds slug marker and returns issue number from URL', async () => {
    const exec = vi.fn()
      .mockResolvedValue({ code: 0, stdout: 'https://github.com/o/r/issues/123\n' });
    const res = await fileProposalToForge({ cli: 'gh', cwd: '/x', title: 'T', body: 'B', slug: 'my-slug', model: 'light', effort: 'low', exec });
    expect(res.success).toBe(true);
    expect(res.number).toBe(123);
    // The create call body carries the slug marker.
    const createCall = exec.mock.calls.find(c => c[1][0] === 'issue')[1];
    const bodyIdx = createCall.indexOf('--body') + 1;
    expect(createCall[bodyIdx]).toContain(slugMarker('my-slug'));
    expect(createCall.filter((a) => a === '--label')).toHaveLength(3);
    expect(createCall).toContain(LI_LABEL);
  });

  // #7687 — the Layered Intelligence loop's own proposal text (LLM-authored,
  // derived from an untrusted diff) never scrubbed before this filer moved
  // onto the shared `fileForgeIssue` wrapper, which scrubs by construction.
  it('strips a home-directory prefix and a credential-shaped token from the filed title and body', async () => {
    const home = homedir();
    const exec = vi.fn().mockResolvedValue({ code: 0, stdout: 'https://github.com/o/r/issues/9\n' });
    const res = await fileProposalToForge({
      cli: 'gh', cwd: '/x',
      title: `Sync fails under ${home}/work/demo`,
      body: `Retried with ghp_${'A'.repeat(36)} and gave up.`,
      slug: 's', model: 'light', effort: 'low', exec,
    });
    expect(res.success).toBe(true);
    const createCall = exec.mock.calls.find((c) => c[1][0] === 'issue')[1];
    const title = createCall[createCall.indexOf('--title') + 1];
    const body = createCall[createCall.indexOf('--body') + 1];
    expect(title).not.toContain(home);
    expect(title).toContain('~/work/demo');
    expect(body).not.toContain(home);
    expect(body).not.toContain('ghp_');
    expect(body).toContain('[REDACTED]');
    // The slug marker survives the scrub — it carries no path or credential
    // shape, and rewriting it would break the dedup it exists to serve.
    expect(body).toContain(slugMarker('s'));
  });

  it('fileProposalToForge creates and applies independent dispatch + contributor labels', async () => {
    const exec = vi.fn().mockResolvedValue({ code: 0, stdout: 'https://github.com/o/r/issues/9\n' });
    const res = await fileProposalToForge({
      cli: 'gh', cwd: '/x', title: 'T', body: 'B', slug: 's',
      model: 'light', effort: 'max', goodFirstIssue: true, helpWanted: true, hardwareRequirements: ['windows', 'cuda'], exec
    });
    expect(res.success).toBe(true);
    const created = exec.mock.calls.filter((c) => c[1][0] === 'label').map((c) => c[1][2]);
    expect(created).toContain(LI_LABEL);
    expect(created).toContain('model:light');
    expect(created).toContain('effort:max');
    expect(created).toContain('good first issue');
    expect(created).toEqual(expect.arrayContaining(['help wanted', 'windows', 'cuda']));
    const createCall = exec.mock.calls.find((c) => c[1][0] === 'issue')[1];
    expect(createCall).toEqual(expect.arrayContaining([
      '--label', LI_LABEL, '--label', 'model:light', '--label', 'effort:max', '--label', 'good first issue', '--label', 'help wanted', '--label', 'windows', '--label', 'cuda'
    ]));
  });

  it('fileProposalToForge does not invent dispatch labels from a missing hint', async () => {
    const exec = vi.fn().mockResolvedValue({ code: 0, stdout: 'https://github.com/o/r/issues/9\n' });
    const result = await fileProposalToForge({ cli: 'gh', cwd: '/x', title: 'T', body: 'B', slug: 's', exec });
    expect(result.success).toBe(false);
    expect(exec).not.toHaveBeenCalled();
    const created = exec.mock.calls.filter((c) => c[1][0] === 'label').map((c) => c[1][2]);
    expect(created).not.toContain('model:medium');
    expect(created).not.toContain('good first issue');
  });

  it('fileProposalToForge reports failure on nonzero exit', async () => {
    const exec = vi.fn(async (_cli, args) => args[0] === 'label'
      ? { code: 0, stdout: '' }
      : { code: 1, stdout: '', stderr: 'boom' });
    const res = await fileProposalToForge({ cli: 'gh', cwd: '/x', title: 'T', body: 'B', slug: 's', model: 'heavy', effort: 'high', exec });
    expect(res.success).toBe(false);
    expect(res.error).toContain('boom');
  });

  // The label must be CREATED before it is applied: both forges 422 the whole
  // `--add-label` call on a repo that has never defined it, and this is the only
  // path that applies the blocking label — so on an install where the loop has
  // not yet filed an issue, the first pause would fail without the lazy create.
  it('applyBlockingLabel creates the blocking label before adding it', async () => {
    const exec = vi.fn().mockResolvedValue({ code: 0, stdout: '' });
    const res = await applyBlockingLabel({ cli: 'gh', cwd: '/x', number: 42, exec });
    expect(res.success).toBe(true);
    const args = exec.mock.calls.map(([, a]) => a);
    const createdAt = args.findIndex((a) => a[0] === 'label' && a[1] === 'create' && a[2] === LI_BLOCKING_LABEL);
    const editedAt = args.findIndex((a) => a[0] === 'issue' && a[1] === 'edit' && a[2] === '42');
    expect(createdAt).toBeGreaterThanOrEqual(0);
    expect(editedAt).toBeGreaterThan(createdAt);
    expect(args[editedAt]).toEqual(expect.arrayContaining(['edit', '42', '--add-label', LI_BLOCKING_LABEL]));
  });

  it('applyBlockingLabel rejects a non-integer number', async () => {
    const exec = vi.fn();
    const res = await applyBlockingLabel({ cli: 'gh', cwd: '/x', number: null, exec });
    expect(res.success).toBe(false);
    expect(exec).not.toHaveBeenCalled();
  });

});

describe('listForgeIssues url surfacing (issue #2293)', () => {
  it('surfaces gh `url` on each issue', async () => {
    const exec = vi.fn().mockResolvedValue({
      code: 0,
      stdout: JSON.stringify([{ number: 12, title: 'A', body: 'x', state: 'OPEN', url: 'https://github.com/o/r/issues/12' }])
    });
    const { issues } = await listForgeIssues({ cli: 'gh', cwd: '/x', exec });
    expect(issues[0].url).toBe('https://github.com/o/r/issues/12');
  });

  it('maps GitLab `web_url` to url', async () => {
    const exec = vi.fn().mockResolvedValue({
      code: 0,
      stdout: JSON.stringify([{ iid: 9, title: 'G', description: 'd', state: 'opened', web_url: 'https://gitlab.com/o/r/-/issues/9' }])
    });
    const { issues } = await listForgeIssues({ cli: 'glab', cwd: '/x', exec });
    expect(issues[0].url).toBe('https://gitlab.com/o/r/-/issues/9');
  });

  it('defaults url to null when neither field is present', async () => {
    const exec = vi.fn().mockResolvedValue({ code: 0, stdout: JSON.stringify([{ number: 1, title: 'A', body: 'x', state: 'OPEN' }]) });
    const { issues } = await listForgeIssues({ cli: 'gh', cwd: '/x', exec });
    expect(issues[0].url).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// plannedWork source (#2698) — the committed backlog fed to the reasoner so it
// can suppress a proposal that overlaps work already in scope.
// ---------------------------------------------------------------------------

describe('normalizeIssueLabels', () => {
  it('reads gh label objects and glab label strings alike', () => {
    expect(normalizeIssueLabels([{ name: 'plan' }, { name: 'p1' }])).toEqual(['plan', 'p1']);
    expect(normalizeIssueLabels(['plan', 'p1'])).toEqual(['plan', 'p1']);
  });

  it('drops junk rather than rendering [object Object] into the prompt', () => {
    expect(normalizeIssueLabels([{ color: 'red' }, null, '', '  ', 42, { name: ' ok ' }])).toEqual(['ok']);
  });

  it('returns [] for a non-array (never throws)', () => {
    expect(normalizeIssueLabels(undefined)).toEqual([]);
    expect(normalizeIssueLabels('plan')).toEqual([]);
  });
});

describe('extractIssuePriority', () => {
  it('reads the common priority label conventions', () => {
    expect(extractIssuePriority(['bug', 'priority: high'])).toBe('high');
    expect(extractIssuePriority(['priority/critical'])).toBe('critical');
    expect(extractIssuePriority(['P0'])).toBe('p0');
    expect(extractIssuePriority(['high-priority'])).toBe('high');
    expect(extractIssuePriority([{ name: 'low' }])).toBe('low');
  });

  it('returns null when no label looks like a priority (absent ≠ p0)', () => {
    expect(extractIssuePriority(['plan', 'enhancement'])).toBeNull();
    expect(extractIssuePriority([])).toBeNull();
    expect(extractIssuePriority(undefined)).toBeNull();
    // A near-miss must not be coerced into a priority.
    expect(extractIssuePriority(['p9', 'priority'])).toBeNull();
  });
});

describe('listForgeIssues label/state parameterization (#2698)', () => {
  it('defaults to the LI label across all states', async () => {
    const exec = vi.fn().mockResolvedValue({ code: 0, stdout: '[]' });
    await listForgeIssues({ cli: 'gh', cwd: '/x', exec });
    const args = exec.mock.calls[0][1];
    expect(args).toContain(LI_LABEL);
    expect(args).toContain('--state');
    expect(args[args.indexOf('--state') + 1]).toBe('all');
  });

  it('queries the requested label + state (gh)', async () => {
    const exec = vi.fn().mockResolvedValue({ code: 0, stdout: '[]' });
    await listForgeIssues({ cli: 'gh', cwd: '/x', label: 'plan', state: 'open', exec });
    const args = exec.mock.calls[0][1];
    expect(args).toContain('plan');
    expect(args).not.toContain(LI_LABEL);
    expect(args[args.indexOf('--state') + 1]).toBe('open');
    expect(args[args.indexOf('--json') + 1]).toContain('labels');
  });

  it('drops --all for an open-only glab query (glab lists open by default)', async () => {
    const exec = vi.fn().mockResolvedValue({ code: 0, stdout: '[]' });
    await listForgeIssues({ cli: 'glab', cwd: '/x', label: 'plan', state: 'open', exec });
    expect(exec.mock.calls[0][1]).not.toContain('--all');
    await listForgeIssues({ cli: 'glab', cwd: '/x', exec });
    expect(exec.mock.calls[1][1]).toContain('--all');
  });

  it('normalizes labels from both forges', async () => {
    const exec = vi.fn().mockResolvedValue({
      code: 0,
      stdout: JSON.stringify([{ number: 1, title: 'A', state: 'open', labels: [{ name: 'plan' }] }])
    });
    const { issues } = await listForgeIssues({ cli: 'gh', cwd: '/x', exec });
    expect(issues[0].labels).toEqual(['plan']);
  });

  it('reports [] labels when the forge omits the field (never undefined)', async () => {
    const exec = vi.fn().mockResolvedValue({ code: 0, stdout: JSON.stringify([{ number: 1, title: 'A', state: 'open' }]) });
    const { issues } = await listForgeIssues({ cli: 'gh', cwd: '/x', exec });
    expect(issues[0].labels).toEqual([]);
  });
});
