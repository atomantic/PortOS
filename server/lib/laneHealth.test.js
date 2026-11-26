import { describe, expect, it } from 'vitest';
import {
  auditLanes,
  computeLaneHealth,
  describeLaneFlag,
  extractAuditKeys,
  extractFileReferences,
  extractProblemFileReferences,
  laneHealthFor,
} from './laneHealth.js';
import { AUDIT_DEFINITIONS } from './auditCatalog.js';

const NOW = Date.parse('2026-10-17T12:00:00.000Z');
const daysAgo = (days) => new Date(NOW - days * 86_400_000).toISOString();

const issue = (number, overrides = {}) => ({
  number,
  title: `Finding ${number}`,
  labels: ['plan', 'code-quality', 'complexity'],
  createdAt: daysAgo(10),
  closedAt: daysAgo(8),
  state: 'closed',
  stateReason: 'COMPLETED',
  body: `Problem at server/lib/example.js:42. Fix: server/lib/example.js`,
  url: `https://example.com/issues/${number}`,
  linkedPullRequests: [],
  ...overrides,
});

describe('laneHealth', () => {
  it('derives one lane per audit definition and attributes an issue to its most specific lane', () => {
    const lanes = auditLanes();
    expect(lanes.map(({ id }) => id)).toEqual(Object.keys(AUDIT_DEFINITIONS));
    expect(lanes.find(({ id }) => id === 'code-simplification')).toMatchObject({ metricLabel: 'code-simplification', issueLabel: 'code-quality' });
    // The shared category label yields to the lane label beside it.
    const report = computeLaneHealth({ now: NOW, issues: [
      issue(1, { labels: [{ name: 'code-quality' }, { name: 'Simplify' }] }),
      issue(2, { labels: ['code-quality'] }),
      issue(3, { labels: ['ux', 'copy'] }),
      issue(4, { labels: ['bug', 'model:heavy'] }),
    ] });
    const filed = Object.fromEntries(report.lanes.filter(({ filed }) => filed).map(({ id, filed }) => [id, filed]));
    expect(filed).toEqual({ 'architecture-maintainability': 1, 'code-simplification': 1, 'documentation-content': 1 });
  });

  it('matches re-filed findings on file:line citations and ignores URLs and bare words', () => {
    const closed = (number, body, title) => issue(number, { createdAt: daysAgo(20), closedAt: daysAgo(15), body, ...(title && { title }) });
    const report = computeLaneHealth({ now: NOW, issues: [
      closed(1, 'Problem in `server/lib/foo.js:12`', 'Cache invalidation race'),
      closed(2, 'see (client/src/App.jsx:3:4)'),
      closed(3, 'see ./scripts/run.sh.'),
      closed(4, 'Not https://example.com/x/y.js'),
      closed(5, 'nor README.md or 1.2.3'),
      issue(10, { createdAt: daysAgo(5), title: 'Cache invalidation race again', body: 'Again server/lib/foo.js, client/src/App.jsx:9 and scripts/run.sh:1' }),
      issue(11, { createdAt: daysAgo(5), body: 'https://example.com/x/y.js README.md 1.2.3 x/y.js' }),
    ] });
    const lane = laneHealthFor(report, 'better-complexity');
    expect(lane.refiled).toBe(1);
    expect(lane.flagged).toEqual([expect.objectContaining({ number: 10, reasons: [{ kind: 're-filed', of: 1, path: 'server/lib/foo.js' }] })]);
  });

  it('rejects traversal paths and flags only a key match, a rejected path, or a same-topic completed repeat', () => {
    const base = { createdAt: daysAgo(20), closedAt: daysAgo(15) };
    const report = computeLaneHealth({ now: NOW, issues: [
      issue(1, { ...base, title: 'Auth gate bypass', body: 'Problem in server/lib/a.js.\n## Fix\nEdit server/lib/hub.js <!-- portos-audit:security:k1 -->' }),
      issue(2, { ...base, title: 'Rejected idea', stateReason: 'NOT_PLANNED', body: 'Problem in server/lib/b.js' }),
      issue(3, { ...base, title: 'Completed topic widget cache', body: 'Problem in server/lib/c.js' }),
      // Hub file only in Fix/Context of both completed fixes, unrelated titles: not a repeat.
      issue(10, { createdAt: daysAgo(5), title: 'Unrelated thing', body: 'Problem in server/lib/z.js\n## Fix\nEdit server/lib/hub.js' }),
      // Exact audit key repeats.
      issue(11, { createdAt: daysAgo(5), title: 'Different words', body: 'x <!-- portos-audit:security:k1 -->' }),
      // Path of a not-planned close.
      issue(12, { createdAt: daysAgo(5), title: 'Other words', body: 'Problem in server/lib/b.js' }),
      // Completed same file, only one shared title token: not flagged.
      issue(13, { createdAt: daysAgo(5), title: 'Widget leak', body: 'Problem in server/lib/c.js' }),
      // Completed same file, two shared tokens: flagged.
      issue(14, { createdAt: daysAgo(5), title: 'Widget cache stale', body: 'Problem in server/lib/c.js' }),
      // Traversal path never matches the earlier ../ form.
      issue(15, { createdAt: daysAgo(5), title: 'Rejected idea', body: 'see ./../lib/b.js and ../lib/b.js' }),
    ].map((i) => ({ ...i, labels: ['plan', 'security'] })) });
    const flagged = laneHealthFor(report, 'security').flagged.filter((f) => f.reasons.some((r) => r.kind === 're-filed'));
    expect(flagged.map(({ number }) => number).sort((a, b) => a - b)).toEqual([11, 12, 14]);
    expect(extractFileReferences('see ./../lib/a.js ../lib/b.js ./server/lib/c.js x/../y/z.js')).toEqual(['server/lib/c.js']);
    expect(extractAuditKeys('<!-- portos-audit:security:k1 --> <!--portos-audit:a:b-->')).toEqual(['a:b', 'security:k1']);
    expect(extractProblemFileReferences('T in a/b.js', 'p c/d.js\n## Proposed Fix\ne/f.js')).toEqual(['a/b.js', 'c/d.js']);
    expect(extractProblemFileReferences('', 'no heading g/h.js')).toEqual(['g/h.js']);
  });

  it('matches a revert by PR number, merge SHA prefix, or one of the PR\'s own commits', () => {
    const pr = { number: 120, mergeCommit: 'abcdef1234567890abcdef1234567890abcdef12', commitShas: ['0123456789abcdef0123456789abcdef01234567'] };
    const reverted = (commit, pullRequest = pr) => laneHealthFor(computeLaneHealth({
      now: NOW, issues: [issue(1, { linkedPullRequests: [pullRequest.number] })], pullRequests: [pullRequest], commits: [{ sha: 'f00', ...commit }],
    }), 'better-complexity').reverted === 1;
    expect(reverted({ subject: 'Revert "feat: thing (#120)"', body: '' })).toBe(true);
    expect(reverted({ subject: 'Revert "feat: thing"', body: 'This reverts commit abcdef1234567890abcdef1234567890abcdef12.' })).toBe(true);
    expect(reverted({ subject: 'revert: feat thing', body: 'This reverts commit 0123456789abcdef.' })).toBe(true);
    // Not a revert, a different PR, a different SHA, or a prefix too short to trust.
    expect(reverted({ subject: 'feat: re-land #120', body: 'This reverts commit abcdef1234567890' })).toBe(false);
    expect(reverted({ subject: 'Revert "feat: other (#1200)"', body: '' })).toBe(false);
    expect(reverted({ subject: 'Revert "feat: other"', body: 'This reverts commit ffffff1234567.' })).toBe(false);
    expect(reverted({ subject: 'Revert "feat: other"', body: 'This reverts commit abcdef.' })).toBe(false);
    // An issue whose PR record is missing still matches by number alone.
    expect(laneHealthFor(computeLaneHealth({ now: NOW, issues: [issue(1, { linkedPullRequests: [77] })], commits: [{ sha: 'f00', subject: 'Revert "fix (#77)"', body: '' }] }), 'better-complexity').reverted).toBe(1);
  });

  it('counts filed, completed, not-planned, open, reverted and re-filed per lane over the window', () => {
    const issues = [
      issue(1),
      issue(2, { stateReason: 'NOT_PLANNED', body: 'Nothing to cite' }),
      issue(3, { stateReason: 'DUPLICATE', body: 'Nothing to cite' }),
      issue(4, { state: 'open', closedAt: null, stateReason: null, createdAt: daysAgo(2), body: 'Still open' }),
      // Fixed by PR 120, which a later commit reverted.
      issue(5, { linkedPullRequests: [120], body: 'server/services/jobs.js:10' }),
      // Closed 20 days ago; #6 re-files its path 5 days later.
      issue(8, { createdAt: daysAgo(25), closedAt: daysAgo(20), title: 'Router hotspot', body: 'Hotspot in server/routes/api.js:5' }),
      issue(6, { title: 'Router hotspot again', createdAt: daysAgo(15), closedAt: daysAgo(14), body: 'Again server/routes/api.js:9' }),
      // Cites a path last closed 70 days ago: outside the re-file window, so not a repeat.
      issue(7, { createdAt: daysAgo(1), state: 'open', closedAt: null, body: 'server/lib/old.js:3 once more', labels: ['code-quality', 'complexity'] }),
      // Outside the window: still an earlier closed reference, never a filed count.
      issue(9, { createdAt: daysAgo(80), closedAt: daysAgo(70), body: 'server/lib/old.js:1' }),
      // Another lane; the shared category label does not pull it into complexity.
      issue(10, { labels: ['code-quality', 'simplify'], stateReason: 'NOT_PLANNED' }),
    ];
    const pullRequests = [{ number: 120, mergeCommit: 'abcdef1234567890abcdef1234567890abcdef12', commitShas: [] }];
    const commits = [
      { sha: '1111111111111111111111111111111111111111', subject: 'feat: unrelated', body: '' },
      { sha: '2222222222222222222222222222222222222222', subject: 'Revert "fix: jobs (#120)"', body: 'This reverts commit abcdef1234567890abcdef1234567890abcdef12.' },
    ];
    const report = computeLaneHealth({ issues, pullRequests, commits, now: NOW });
    expect(report).toMatchObject({ windowDays: 60, refileDays: 30, from: daysAgo(60), to: new Date(NOW).toISOString() });
    expect(report.lanes.map(({ id }) => id)).toEqual(Object.keys(AUDIT_DEFINITIONS));

    const complexity = laneHealthFor(report, 'better-complexity');
    expect(complexity).toMatchObject({ metricLabel: 'code-simplification', filed: 9, completed: 4, notPlanned: 3, open: 2, reverted: 1, refiled: 1, flaggedTotal: 5 });
    expect(complexity.flagged.map(({ number }) => number)).toEqual([10, 5, 3, 2, 6]);
    expect(complexity.flagged.find(({ number }) => number === 5).reasons).toEqual([{ kind: 'reverted', pullRequest: 120, commit: '2222222222222222222222222222222222222222' }]);
    expect(complexity.flagged.find(({ number }) => number === 6).reasons).toEqual([{ kind: 're-filed', of: 8, path: 'server/routes/api.js' }]);
    expect(complexity.flagged.find(({ number }) => number === 3).reasons).toEqual([{ kind: 'not-planned', stateReason: 'duplicate' }]);
    expect(complexity.flagged[4]).toMatchObject({ number: 6, title: 'Router hotspot again', url: 'https://example.com/issues/6' });

    const simplify = laneHealthFor(report, 'simplify');
    expect(simplify).toBe(complexity);
    expect(laneHealthFor(report, 'code-quality')).toMatchObject({ filed: 0, flagged: [] });
    expect(laneHealthFor(report, 'missing-lane')).toBeNull();
  });

  it('honors an explicit window start, the flagged cap, and reads GitLab-shaped issues without a state reason as completed', () => {
    const issues = Array.from({ length: 12 }, (_, index) => issue(index + 1, {
      createdAt: daysAgo(index + 1), closedAt: daysAgo(index + 0.5), stateReason: 'NOT_PLANNED', body: 'none',
    }));
    const report = computeLaneHealth({ issues, now: NOW, from: NOW - 5 * 86_400_000, flaggedLimit: 3 });
    const lane = laneHealthFor(report, 'better-complexity');
    expect(report.from).toBe(daysAgo(5));
    expect(lane).toMatchObject({ filed: 5, notPlanned: 5, flaggedTotal: 5 });
    expect(lane.flagged.map(({ number }) => number)).toEqual([1, 2, 3]);

    const gitlab = computeLaneHealth({ issues: [issue(1, { state: 'closed', stateReason: undefined }), issue(2, { state: 'opened', closedAt: null, stateReason: undefined })], now: NOW });
    expect(laneHealthFor(gitlab, 'better-complexity')).toMatchObject({ filed: 2, completed: 1, open: 1, notPlanned: 0 });
  });

  it('describes each flag the same way for the prompt block and the UI', () => {
    expect(describeLaneFlag({ kind: 'not-planned' })).toBe('closed as not planned');
    expect(describeLaneFlag({ kind: 'not-planned', stateReason: 'duplicate' })).toBe('closed as duplicate');
    expect(describeLaneFlag({ kind: 'reverted', pullRequest: 9 })).toBe('fix reverted (PR #9)');
    expect(describeLaneFlag({ kind: 're-filed', of: 4, path: 'a/b.js' })).toBe('re-filed after #4 on a/b.js');
  });
});
