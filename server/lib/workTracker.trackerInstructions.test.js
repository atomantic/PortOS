/**
 * {trackerInstructions} regression guard (#3273).
 *
 * `formatTrackerInstructions` was generalized out of referenceRepos.js so the
 * `ux` task type can reuse the same "inventory / record / finalize" mechanics.
 * The reference-watch prompt is at PROMPT_VERSIONS 3 and its stored copies on
 * other installs are keyed to that version, so the generalization must be a
 * pure refactor for reference-watch: these four expected strings are the blocks
 * exactly as they shipped before the extraction. If a change here is
 * intentional, it needs a reference-watch PROMPT_VERSIONS bump, not a test edit.
 */

import { describe, it, expect } from 'vitest';
import { formatTrackerInstructions, TRACKER_FILING_PRESETS } from './workTracker.js';

const REF_WATCH = { slugPrefix: 'ref-watch-', label: 'reference-watch', issueLabel: 'reference-watch' };

const EXPECTED = {
  plan: `This app records autonomous work in **PLAN.md** at the repo root ({repoPath}).

- **Inventory:** Read PLAN.md from {repoPath}. Every existing checkbox carries a \`[<slug>]\` ID — collect the \`[ref-watch-…]\` ones so you don't duplicate. If PLAN.md does not exist, create it with a single top-level heading (\`# {appName} — Development Plan\`) and a \`## Next Up\` section before appending.
- **Record** each proposal as a slug-tagged checklist item appended to the \`## Next Up\` section:
  \`\`\`markdown
  - [ ] [<slug>] **<Short title.>** From \`reference-watch\` review of <ref name> (commit(s) \`<sha>\` [+ \`<sha>\` …], <today's date>). <1–2 sentences.> Fix: <files + functions in {appName}>. <Estimated scope.>
  \`\`\`
  Place **Maybe — needs human call** items in a \`### Trigger-gated (waiting for a precondition)\` subsection if one exists; otherwise append them under \`## Next Up\`.
- **Finalize:** Commit the PLAN.md edit with message \`docs(reference-watch): propose <N> item(s) from <ref names>\`. Do NOT create branches or PRs — \`/claim\` (or the \`plan-task\` agent) picks the slugs up later.`,

  github: `This app tracks autonomous work in **GitHub Issues** (via the \`gh\` CLI), NOT PLAN.md — do NOT edit PLAN.md.

- **Inventory:** From {repoPath}, resolve the repo (\`gh repo view --json nameWithOwner -q .nameWithOwner\`) and list existing reference-watch issues so you don't duplicate: \`gh issue list --state all --search "ref-watch in:title" --limit 100 --json number,title\`. Each carries a \`[ref-watch-…]\` slug in its title — collect them. If \`gh\` is not authenticated or the remote is not GitHub, exit cleanly.
- **Record** each proposal as a new GitHub issue. Ensure the label exists first (\`gh label create reference-watch --description "Proposed from a reference-repo watch" --force\`), then:
  \`\`\`bash
  gh issue create --title "[<slug>] <Short title>" --label reference-watch --body "<body>"
  \`\`\`
  The body must contain the provenance (ref + commit SHA(s) + today's date), the 1–2 sentence rationale, the \`Fix:\` line naming the {appName} files/functions to change, and the estimated scope. For **Maybe — needs human call** items, also add \`--label needs-decision\` (create it the same way if absent) and end the body with \`**Decision needed:** <one sentence>.\`.
- **Finalize:** No source-code edits, no PLAN.md, no branches, no PRs — the issues ARE the deliverable. \`/claim --issues\` (the \`claim-issue\` flow) picks them up later.`,

  gitlab: `This app tracks autonomous work in **GitLab Issues** (via the \`glab\` CLI), NOT PLAN.md — do NOT edit PLAN.md.

- **Inventory:** From {repoPath}, confirm the forge (\`glab repo view\`) and list existing reference-watch issues so you don't duplicate: \`glab issue list --label reference-watch --per-page 100 -F json\` (also scan titles for the \`[ref-watch-…]\` slug). Collect the existing slugs. If \`glab\` is not authenticated or the remote is not GitLab, exit cleanly.
- **Record** each proposal as a new GitLab issue:
  \`\`\`bash
  glab issue create --title "[<slug>] <Short title>" --label reference-watch --description "<body>"
  \`\`\`
  (Run \`glab issue create --help\` if a flag is rejected — glab's flags evolve.) The body must contain the provenance (ref + commit SHA(s) + today's date), the 1–2 sentence rationale, the \`Fix:\` line naming the {appName} files/functions to change, and the estimated scope. For **Maybe — needs human call** items, also add \`--label needs-decision\` and end the body with \`**Decision needed:** <one sentence>.\`.
- **Finalize:** No source-code edits, no PLAN.md, no branches, no MRs — the issues ARE the deliverable. \`/claim --issues\` (the \`claim-issue-gitlab\` flow) picks them up later.`,

  jira: `This app tracks autonomous work in **JIRA**. Create one JIRA issue per proposal in the app's configured project using whatever JIRA CLI/REST this environment provides. **If no JIRA credentials are available, fall back to recording proposals in PLAN.md at {repoPath} (slug-tagged \`- [ ] [<slug>] …\` checklist items under \`## Next Up\`, committed) and say so in your final summary.**

- **Inventory:** Search existing JIRA issues (and PLAN.md, if you fall back) for the \`[ref-watch-…]\` slug so you don't duplicate; collect the existing slugs.
- **Record** each proposal as a new JIRA issue whose summary starts with the \`[<slug>]\` tag. The description must contain the provenance (ref + commit SHA(s) + today's date), the 1–2 sentence rationale, the \`Fix:\` line naming the {appName} files/functions to change, and the estimated scope. For **Maybe — needs human call** items, end the description with \`**Decision needed:** <one sentence>.\`.
- **Finalize:** No source-code edits, no branches, no PRs — the tickets (or the committed PLAN.md fallback) ARE the deliverable. The \`claim-issue-jira\` flow picks them up later.`,
};

describe('formatTrackerInstructions — reference-watch byte-identity (#3273)', () => {
  for (const tracker of ['plan', 'github', 'gitlab', 'jira']) {
    it(`renders the pre-extraction ${tracker} block byte-for-byte`, () => {
      expect(formatTrackerInstructions(tracker, REF_WATCH)).toBe(EXPECTED[tracker]);
    });

    it(`renders the same ${tracker} block with no options (referenceRepos back-compat)`, () => {
      expect(formatTrackerInstructions(tracker)).toBe(EXPECTED[tracker]);
    });

    it(`renders the same ${tracker} block from the reference-watch preset`, () => {
      expect(formatTrackerInstructions(tracker, TRACKER_FILING_PRESETS['reference-watch']))
        .toBe(EXPECTED[tracker]);
    });
  }

  it('falls back to the PLAN.md block for an unknown/missing tracker', () => {
    expect(formatTrackerInstructions('nope')).toBe(EXPECTED.plan);
    expect(formatTrackerInstructions(undefined)).toBe(EXPECTED.plan);
  });
});

describe('formatTrackerInstructions — ux preset (#3273)', () => {
  const ux = TRACKER_FILING_PRESETS.ux;

  it('carries the ux slug prefix + label into every tracker block', () => {
    for (const tracker of ['plan', 'github', 'gitlab', 'jira']) {
      const block = formatTrackerInstructions(tracker, ux);
      expect(block).toContain('[ux-…]');
      expect(block).not.toContain('ref-watch');
      expect(block).not.toContain('reference-watch');
    }
  });

  it('labels filed forge issues `ux` and searches titles by the slug stem', () => {
    const github = formatTrackerInstructions('github', ux);
    expect(github).toContain('gh label create ux --description "Proposed from a UX/design audit" --force');
    expect(github).toContain('--label ux --body');
    expect(github).toContain('--search "ux in:title"');
    expect(formatTrackerInstructions('gitlab', ux)).toContain('glab issue list --label ux');
  });

  it('keeps the read-only-on-source contract in every block', () => {
    for (const tracker of ['github', 'gitlab', 'jira']) {
      expect(formatTrackerInstructions(tracker, ux)).toContain('No source-code edits');
    }
  });

  it('leaves {appName}/{repoPath} unexpanded for the caller replace chain', () => {
    expect(formatTrackerInstructions('plan', ux)).toContain('{repoPath}');
    expect(formatTrackerInstructions('github', ux)).toContain('{appName}');
  });

  // The SHIPPED prompt (not the generator's mocked stand-in) must fully expand:
  // the tracker block is injected FIRST precisely because it carries {appName}/
  // {repoPath} of its own, and a token that survives reaches the agent literally.
  it('leaves no unexpanded {token} in the shipped ux prompt on any tracker', async () => {
    const { DEFAULT_TASK_PROMPTS } = await import('../services/taskPromptDefaults.js');
    const template = DEFAULT_TASK_PROMPTS['ux'];
    expect(template).toContain('{trackerInstructions}');

    for (const tracker of ['plan', 'github', 'gitlab', 'jira']) {
      const rendered = template
        .replace(/\{trackerInstructions\}/g, () => formatTrackerInstructions(tracker, ux))
        .replace(/\{appName\}/g, () => 'Example App')
        .replace(/\{repoPath\}/g, () => '/tmp/example-repo');
      expect(rendered.match(/\{[a-zA-Z][a-zA-Z0-9_]*\}/g)).toBeNull();
    }
  });
});
