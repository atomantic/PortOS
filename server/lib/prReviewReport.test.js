import { describe, expect, it } from 'vitest';
import {
  MAX_REVIEW_BODY_CHARS,
  PR_REVIEW_DECISION_CONTRACT,
  TEST_EVIDENCE_STATUSES,
  normalizeReviewReport,
  renderFinding,
  renderReviewBody,
  reviewReportText,
} from './prReviewReport.js';

const finding = (path, line, label) => ({ comment: { path, line }, label });

describe('renderReviewBody', () => {
  it('renders a full structured report as scannable markdown sections', () => {
    const body = renderReviewBody({
      verdict: 'request_changes',
      report: {
        summary: 'The docs are accurate, but the prescribed install command contradicts the repo install path.',
        scope: 'docs-only change to two files under docs/',
        testEvidence: [
          { command: 'npm test -w server', status: 'pass', detail: '412 passed' },
          { command: 'npx vitest', status: 'not-run', detail: 'no node_modules in the disposable worktree' },
        ],
        verified: ['update.sh always ends on main — update.sh:132-143'],
        concerns: ['The Windows entry point is not mentioned.'],
      },
      blockingFindings: [finding('docs/SELF_UPDATE.md', 108, 'Bare npm install dirties tracked lockfiles')],
      nonBlockingFindings: [finding('docs/SELF_UPDATE.md', 112, 'Ordering rationale is downstream of line 108')],
    });

    expect(body).toContain('🔴 **Changes requested**');
    expect(body).toContain('**Scope:** docs-only change to two files under docs/');
    expect(body).toContain('#### ⛔ Blocking (1)');
    expect(body).toContain('- `docs/SELF_UPDATE.md:108` — Bare npm install dirties tracked lockfiles');
    expect(body).toContain('#### 💡 Non-blocking (1)');
    expect(body).toContain('#### Test evidence');
    expect(body).toContain('- ✅ `npm test -w server` — 412 passed');
    expect(body).toContain('- ⏭️ `npx vitest` — no node_modules in the disposable worktree');
    expect(body).toContain('#### Notes');
    expect(body).toContain('<details><summary>Claims verified against the code</summary>');
  });

  // A ❌ on an approved review is a lie a human has to read past. Stage 3 hits
  // two non-zero exits that say nothing about the patch — a deliberate mutation
  // probe that must fail, and a suite the review sandbox strangles — and each
  // needs its own mark, or the model stamps `fail` and explains it away in the
  // detail (which is exactly what shipped three ❌ rows under an ✅ Approved).
  it('marks a deliberate probe and an environment-blocked run without the red fail icon', () => {
    const body = renderReviewBody({
      verdict: 'approve',
      report: {
        testEvidence: [
          { command: 'npx vitest run installState.test.js -t "Finder metadata"', status: 'expected-fail', detail: 'with the guard reverted, so the new test is not vacuous' },
          { command: 'npx vitest run', status: 'blocked', detail: 'EPERM on listen and spawn inside the review sandbox' },
        ],
      },
    });
    expect(body).toContain('- 🧪 `npx vitest run installState.test.js -t "Finder metadata"` — with the guard reverted, so the new test is not vacuous');
    expect(body).toContain('- 🚧 `npx vitest run` — EPERM on listen and spawn inside the review sandbox');
    expect(body).not.toContain('❌');
  });

  // Deriving the status list from the icon map already makes "every status has
  // an icon" true by construction. What that cannot guarantee is that the
  // statuses stay DISTINGUISHABLE, and that exactly one of them is the red
  // mark — give `blocked` a ❌ and the misleading review is back with no
  // vocabulary change to notice.
  it('renders each evidence status distinguishably, with only `fail` as the red mark', () => {
    const icons = TEST_EVIDENCE_STATUSES.map((status) => renderReviewBody({
      verdict: 'approve',
      report: { testEvidence: [{ command: 'cmd', status, detail: 'd' }] },
    }).match(/- (\S+) `cmd`/)?.[1]);

    expect(new Set(icons).size).toBe(TEST_EVIDENCE_STATUSES.length);
    expect(icons[TEST_EVIDENCE_STATUSES.indexOf('fail')]).toBe('❌');
    expect(icons.filter((icon) => icon === '❌')).toHaveLength(1);
  });

  it('still renders a legacy plain-string summary with no structured fields', () => {
    const body = renderReviewBody({ verdict: 'approve', report: { summary: 'Looks good.' } });
    expect(body).toBe('✅ **Approved**\n\nLooks good.');
  });

  it('falls back to a verdict banner and default sentence when the report is empty', () => {
    expect(renderReviewBody({ verdict: 'defer', report: {} }))
      .toContain('💬 **Review — no verdict yet**');
    expect(renderReviewBody({})).toContain('This change needs follow-up before it can merge.');
  });

  it('appends the deterministic downgrade note as its own trailing section', () => {
    const body = renderReviewBody({
      verdict: 'request_changes',
      report: { summary: 'Two problems.' },
      downgraded: true,
    });
    expect(body).toBe([
      '🔴 **Changes requested**',
      '',
      'Two problems.',
      '',
      'PortOS could not anchor one or more reported findings to this diff, so the review is blocking until they are restated against exact added lines.',
    ].join('\n'));
  });

  it('drops whole low-priority sections instead of truncating mid-sentence', () => {
    const verified = Array.from({ length: 12 }, (_, i) => `${i} ${'v'.repeat(600)}`);
    const body = renderReviewBody({
      verdict: 'approve',
      report: {
        summary: 'x'.repeat(2_000),
        testEvidence: [{ command: 'npm test', status: 'pass', detail: 'green' }],
        concerns: ['One note.'],
        // 12 x ~600 chars overruns what is left of the budget on its own.
        verified,
      },
    });
    expect(body.length).toBeLessThanOrEqual(MAX_REVIEW_BODY_CHARS);
    expect(body).toContain('_Some sections of this review were omitted');
    // Verified claims are the lowest-priority section, so that whole section
    // goes; the sections above it survive intact rather than being cut short.
    expect(body).not.toContain('Claims verified against the code');
    expect(body).toContain('x'.repeat(2_000));
    expect(body).toContain('- ✅ `npm test` — green');
    expect(body).toContain('#### Notes\n- One note.');
  });
});

describe('renderFinding', () => {
  it('labels a blocking finding and renders an applyable suggestion block', () => {
    expect(renderFinding({
      title: 'Use the repo install path',
      body: 'Bare `npm install` rewrites tracked lockfiles.',
      suggestion: 'for d in . client server autofixer; do (cd "$d" && npm install --no-save); done',
    })).toEqual({
      label: 'Use the repo install path',
      body: [
        '⛔ **Blocking** — Use the repo install path',
        '',
        'Bare `npm install` rewrites tracked lockfiles.',
        '',
        '```suggestion',
        'for d in . client server autofixer; do (cd "$d" && npm install --no-save); done',
        '```',
      ].join('\n'),
    });
  });

  it('labels a non-blocking finding, omits an absent suggestion, and falls back to the body for the index label', () => {
    expect(renderFinding({ body: 'Consider naming Windows too.' }, { blocking: false })).toEqual({
      body: '💡 **Non-blocking**\n\nConsider naming Windows too.',
      label: 'Consider naming Windows too.',
    });
  });

  it('drops a suggestion containing a fence so it cannot break out of the code block', () => {
    expect(renderFinding({ body: 'x', suggestion: '```\nrm -rf /\n```' }).body).not.toContain('```');
  });

  it('drops the suggestion when the body leaves a fence open, so it cannot render as inert text', () => {
    const rendered = renderFinding({ body: 'Replace it:\n\n```js\nconst a = 1;', suggestion: 'const a = 2;' });
    expect(rendered.body).not.toContain('```suggestion');
    expect(rendered.body).toContain('const a = 1;');
  });

  it('keeps the suggestion when the body fences are balanced', () => {
    const rendered = renderFinding({ body: 'Today:\n\n```js\nconst a = 1;\n```', suggestion: 'const a = 2;' });
    expect(rendered.body).toContain('```suggestion\nconst a = 2;\n```');
  });

  it('rejects a finding with no usable body', () => {
    expect(renderFinding({ title: 'no body' })).toBeNull();
  });
});

describe('normalizeReviewReport', () => {
  it('collapses newlines in single-line fields so a model cannot inject headings', () => {
    const report = normalizeReviewReport({ scope: 'docs\n\n## Injected heading', verified: ['a\n- b'] });
    expect(report.scope).toBe('docs ## Injected heading');
    expect(report.verified).toEqual(['a - b']);
  });

  it('defaults an unknown test status to not-run and drops empty entries', () => {
    const report = normalizeReviewReport({ testEvidence: [{ command: 'a', status: 'green' }, {}, { detail: 'b' }] });
    expect(report.testEvidence).toEqual([
      { command: 'a', status: 'not-run', detail: '' },
      { command: '', status: 'not-run', detail: 'b' },
    ]);
  });
});

describe('reviewReportText', () => {
  it('exposes every model-authored string, report and finding alike, so the abuse scan sees them all', () => {
    expect(reviewReportText({
      summary: 'a', scope: 'b',
      testEvidence: [{ command: 'c', status: 'pass', detail: 'd' }],
      verified: ['e'], concerns: ['f'],
      findings: [{ title: 'g', body: 'h', suggestion: 'i' }],
    })).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i']);
  });
});

describe('PR_REVIEW_DECISION_CONTRACT', () => {
  // Two producers ask for this envelope (the pr-reviewer stage-3 body and the
  // issue-watcher reasoning pass) and both feed normalizeReviewReport /
  // renderFinding. A field added to the normalizer but not to the contract
  // would silently never be asked for.
  it('names every field the normalizer and the finding renderer read', () => {
    for (const field of ['summary', 'scope', 'testEvidence', 'verified', 'concerns', 'findings']) {
      expect(PR_REVIEW_DECISION_CONTRACT, field).toContain(`"${field}"`);
    }
    for (const field of ['path', 'line', 'side', 'blocking', 'title', 'body', 'suggestion']) {
      expect(PR_REVIEW_DECISION_CONTRACT, field).toContain(`"${field}"`);
    }
    // Derived from the real list: a status the normalizer accepts but the
    // contract never names is one the model has no way to know it may use.
    for (const status of TEST_EVIDENCE_STATUSES) {
      expect(PR_REVIEW_DECISION_CONTRACT, status).toContain(status);
    }
  });

  it('is what the pr-reviewer stage-3 prompt actually ships', async () => {
    const { DEFAULT_TASK_PROMPTS } = await import('../services/taskPromptDefaults/prompts.js');
    expect(DEFAULT_TASK_PROMPTS['pr-reviewer-review']).toContain(PR_REVIEW_DECISION_CONTRACT);
  });
});
