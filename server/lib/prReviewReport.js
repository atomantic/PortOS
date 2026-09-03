/**
 * Structured pr-reviewer report → GitHub markdown, plus the prompt contract
 * that asks for it.
 *
 * Stage 3 of the pr-reviewer pipeline used to hand the coordinator one
 * `summary` string, which was posted verbatim as the review body: a single
 * unbroken wall of prose mixing the verdict, the test evidence, every verified
 * claim, and the blocking problem. Reviews are read by a human on the PR page,
 * so the model now returns those as separate fields and the deterministic
 * coordinator renders the markdown. The model never composes markup, which
 * keeps rendering (and its length budget) on the trusted side of the boundary.
 *
 * The field spec lives here as `PR_REVIEW_DECISION_CONTRACT` rather than in
 * either prompt, because two producers ask for this envelope — the pr-reviewer
 * stage-3 body and the issue-watcher reasoning pass — and both feed this one
 * normalizer. Adding a field to the prompt of only one of them would silently
 * degrade the other's reviews with nothing failing.
 *
 * Every field is optional and a plain-string `summary` still renders, so an
 * older stage body — or a model that ignores the structured shape — degrades to
 * the previous single-paragraph review rather than losing its review entirely.
 *
 * Pure: no I/O, no forge calls.
 */

/** GitHub accepts far more, but a review a human can scan stays bounded. */
export const MAX_REVIEW_BODY_CHARS = 8_000;
const MAX_SUMMARY_CHARS = 2_000;
const MAX_SCOPE_CHARS = 400;
const MAX_BULLET_CHARS = 600;
const MAX_BULLETS = 12;
const MAX_FINDING_TITLE_CHARS = 160;
const MAX_FINDING_BODY_CHARS = 3_000;
const MAX_SUGGESTION_CHARS = 2_000;
const MAX_INDEX_LABEL_CHARS = 160;
/**
 * What one command says about THE CHANGE, which is not the same thing as its
 * exit code. `fail` is the only status a reader sees as a red mark, so the two
 * ways a non-zero exit means nothing about the patch need statuses of their
 * own: without them a model with an honest story has to stamp `fail` and put
 * the exculpation in `detail`, which is how an ✅ Approved review shipped three
 * ❌ rows — one deliberate mutation probe that was *supposed* to fail, and two
 * whole-suite runs whose thousands of failures were the review sandbox denying
 * sockets, out-of-tree writes, GPU access, and language toolchains.
 *
 * The icon map is the single source of truth and the accepted-status list is
 * derived from it, so a status can never exist without a mark to render it
 * with. Exported so the contract test can prove each one is documented in
 * PR_REVIEW_DECISION_CONTRACT — the half no construction can guarantee.
 */
const STATUS_ICON = {
  pass: '✅',
  fail: '❌',
  'expected-fail': '🧪',
  blocked: '🚧',
  'not-run': '⏭️',
};
export const TEST_EVIDENCE_STATUSES = Object.keys(STATUS_ICON);
const TRIM_NOTE = '_Some sections of this review were omitted to stay within the comment size limit._';
const DOWNGRADE_NOTE = 'PortOS could not anchor one or more reported findings to this diff, so the review is blocking until they are restated against exact added lines.';

const VERDICT_BANNER = {
  approve: '✅ **Approved**',
  request_changes: '🔴 **Changes requested**',
  defer: '💬 **Review — no verdict yet**',
};

const VERDICT_DEFAULT_SUMMARY = {
  approve: 'Reviewed: no material issues found.',
  request_changes: 'This change needs follow-up before it can merge.',
  defer: 'This change needs follow-up before it can merge.',
};

/**
 * The per-PR decision shape both review producers must emit. Each prompt wraps
 * this in its own envelope (stage 3 returns it directly, the reasoning pass
 * nests it under a completion sentinel) and may append its own notes.
 */
export const PR_REVIEW_DECISION_CONTRACT = `Every text field is PLAIN PROSE — deterministic code renders the markdown a human reads on the PR page, so do not write markdown into a field, and do not restate a finding inside \`summary\`. Say each thing once, in the field that carries it: a blocking problem belongs in a \`findings\` entry anchored to its line.

Each pull-request decision has this shape:

{
  "number": 123,
  "headSha": "exact supplied 40-character commit id",
  "verdict": "approve|request_changes|defer",
  "ciPolicy": "required|skippable",
  "rebaseRequired": false,
  "summary": "1-3 sentences: the verdict and why it is that verdict",
  "scope": "one line naming what the change touches",
  "testEvidence": [
    {"command": "npm test -w server", "status": "pass|fail|expected-fail|blocked|not-run", "detail": "counts, the failure, or why the run says nothing about the change"}
  ],
  "verified": ["one claim you confirmed, citing path:line"],
  "concerns": ["a non-blocking observation with no specific line to anchor"],
  "findings": [
    {
      "path": "src/file.js",
      "line": 42,
      "side": "RIGHT",
      "blocking": true,
      "title": "short label, under ~80 characters",
      "body": "the concrete problem, the wrong outcome it produces, and the fix",
      "suggestion": "optional exact replacement text for this one line, no code fence"
    }
  ]
}

Field rules:

- \`summary\` is the headline only. Keep it under about 3 sentences.
- \`scope\` is one line ("docs-only change to two files under docs/").
- \`testEvidence\` is one entry per command you actually ran, plus one
  \`not-run\` entry naming each relevant suite you could not run and why.
  Choose the status by what the run proves about THIS CHANGE, never by the
  exit code — \`fail\` is the only one a reader sees as a red mark, so it is
  reserved for "the change breaks this command". Use \`expected-fail\` for a
  deliberate probe that had to fail to prove something (reverting the fix to
  show a new test is not vacuous), \`blocked\` when the command ran but its
  failures came from the environment — a sandbox denial, a missing toolchain
  or service, a resource limit — so it proved nothing either way, and
  \`not-run\` when you never ran it. If you find yourself writing a \`detail\`
  that explains a \`fail\` away, the status was wrong.
- \`verified\` holds claims you checked against the code, one per entry, each
  citing the \`path:line\` that proves it. Leave it empty rather than padding.
- \`concerns\` is for non-blocking observations that have no line to anchor to.
  Anything that does have a line belongs in \`findings\` with
  \`"blocking": false\`.
- \`title\` and \`suggestion\` are optional. \`suggestion\` must be the literal
  replacement for the single anchored line, with no code fence and no
  surrounding prose — omit it when the fix is not a one-line edit.`;

/** Collapse whitespace runs so a model paragraph cannot inject list/heading markup mid-line. */
function line(value, max) {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim().slice(0, max);
}

/** Keep author paragraph breaks, drop trailing whitespace and runaway blank lines. */
function block(value, max) {
  if (typeof value !== 'string') return '';
  return value.replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim().slice(0, max);
}

function bullets(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => line(item, MAX_BULLET_CHARS)).filter(Boolean).slice(0, MAX_BULLETS);
}

function normalizeTestEvidence(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      const command = line(item?.command, MAX_BULLET_CHARS);
      const detail = line(item?.detail, MAX_BULLET_CHARS);
      if (!command && !detail) return null;
      const status = TEST_EVIDENCE_STATUSES.includes(item?.status) ? item.status : 'not-run';
      return { command, status, detail };
    })
    .filter(Boolean)
    .slice(0, MAX_BULLETS);
}

/**
 * Normalize the optional structured report fields of one PR decision. Unknown
 * or malformed entries drop out; the caller still owns verdict, finding
 * anchoring, and every forge-state check.
 */
export function normalizeReviewReport(raw) {
  return {
    summary: block(raw?.summary, MAX_SUMMARY_CHARS),
    scope: line(raw?.scope, MAX_SCOPE_CHARS),
    testEvidence: normalizeTestEvidence(raw?.testEvidence),
    verified: bullets(raw?.verified),
    concerns: bullets(raw?.concerns),
  };
}

/** The presentation fields of one finding (anchoring stays with the caller). */
function normalizeFindingPresentation(raw) {
  const suggestion = block(raw?.suggestion, MAX_SUGGESTION_CHARS);
  return {
    title: line(raw?.title, MAX_FINDING_TITLE_CHARS),
    body: block(raw?.body, MAX_FINDING_BODY_CHARS),
    // A fenced block inside the suggestion would close GitHub's own fence and
    // spill the rest of the comment into the diff as an applyable patch.
    suggestion: suggestion.includes('```') ? '' : suggestion,
  };
}

/**
 * Every model-authored string in one raw PR decision, for the model-abuse scan.
 * One module enumerates them so a field added above cannot ship unscanned.
 */
export function reviewReportText(raw) {
  const report = normalizeReviewReport(raw);
  const findings = Array.isArray(raw?.findings) ? raw.findings : [];
  return [
    report.summary,
    report.scope,
    ...report.testEvidence.flatMap((item) => [item.command, item.detail]),
    ...report.verified,
    ...report.concerns,
    ...findings.flatMap((finding) => {
      const { title, body, suggestion } = normalizeFindingPresentation(finding);
      return [title, body, suggestion];
    }),
  ].filter(Boolean);
}

/**
 * Render one finding as an inline review comment, plus the short label the
 * review body's finding index shows for it. Returns null when the finding
 * carries no usable body.
 */
export function renderFinding(raw, { blocking = true } = {}) {
  const { title, body, suggestion } = normalizeFindingPresentation(raw);
  if (!body) return null;
  const marker = blocking ? '⛔ **Blocking**' : '💡 **Non-blocking**';
  // An odd number of fences in the body leaves one open, which would swallow
  // the suggestion block below and render it as inert text instead of an
  // applyable change. Drop the suggestion rather than emit a dead one.
  const bodyLeavesFenceOpen = ((body.match(/```/g) || []).length % 2) === 1;
  return {
    body: [
      title ? `${marker} — ${title}` : marker,
      '',
      body,
      ...(suggestion && !bodyLeavesFenceOpen ? ['', '```suggestion', suggestion, '```'] : []),
    ].join('\n'),
    label: title || line(body, MAX_INDEX_LABEL_CHARS),
  };
}

function listSection(heading, items, renderItem, tail = null) {
  if (items.length === 0) return '';
  return [heading, ...items.map(renderItem), ...(tail ? [tail] : [])].join('\n');
}

function findingsIndex(findings, heading, icon) {
  return listSection(
    `#### ${icon} ${heading} (${findings.length})`,
    findings,
    ({ comment, label }) => `- \`${comment.path}:${comment.line}\` — ${label}`,
  );
}

/**
 * Render the review body a human reads on the PR page. Sections are emitted in
 * priority order and any that does not fit the budget is skipped whole, so a
 * long report loses its least important section instead of being cut
 * mid-sentence.
 */
export function renderReviewBody({
  report,
  verdict,
  blockingFindings = [],
  nonBlockingFindings = [],
  downgraded = false,
} = {}) {
  const normalized = normalizeReviewReport(report);
  const sections = [
    VERDICT_BANNER[verdict] || VERDICT_BANNER.defer,
    normalized.summary || VERDICT_DEFAULT_SUMMARY[verdict] || VERDICT_DEFAULT_SUMMARY.defer,
    normalized.scope && `**Scope:** ${normalized.scope}`,
    findingsIndex(blockingFindings, 'Blocking', '⛔'),
    findingsIndex(nonBlockingFindings, 'Non-blocking', '💡'),
    listSection('#### Test evidence', normalized.testEvidence, (item) => {
      const head = item.command ? `\`${item.command}\`` : item.detail;
      const tail = item.command && item.detail ? ` — ${item.detail}` : '';
      return `- ${STATUS_ICON[item.status]} ${head}${tail}`;
    }),
    listSection('#### Notes', normalized.concerns, (item) => `- ${item}`),
    // One section, closing tag included: the budget must never drop the
    // </details> and leave the body with an unclosed block.
    listSection('<details><summary>Claims verified against the code</summary>\n', normalized.verified, (item) => `- ${item}`, '</details>'),
    downgraded && DOWNGRADE_NOTE,
  ].filter(Boolean);

  const kept = [];
  // Reserve room for the trim note so adding it cannot push the body past the cap.
  const budget = MAX_REVIEW_BODY_CHARS - TRIM_NOTE.length - 2;
  let used = 0;
  for (const section of sections) {
    const cost = section.length + 2;
    if (used + cost > budget) continue;
    kept.push(section);
    used += cost;
  }
  if (kept.length < sections.length) kept.push(TRIM_NOTE);
  return kept.join('\n\n');
}
