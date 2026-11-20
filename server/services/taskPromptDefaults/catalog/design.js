import { LIGHT_FINDINGS_BATCH_EXCEPTION } from '../../../lib/dispatchLabels.js';

export const prompts = {
  'documentation': `[Improvement: {appName}] Documentation Review

Find where {appName}'s documentation is wrong, missing, or has drifted from the
code — and fix the gaps that actually mislead someone.

Repository: {repoPath}

{modeInstructions}

## Prioritize by who gets hurt

Rank gaps by the cost of the mistake they cause: a broken install or setup
instruction, a documented command or flag that no longer exists, a stated
contract the code does not honor, an undocumented breaking change, then merely
absent detail. Documentation that is *wrong* outranks documentation that is
*missing* — a reader who follows a false instruction loses more than a reader
who finds nothing.

## Hunt for

- **Instructions that no longer work** — a setup step, command, path, port, or
  environment variable that has changed or gone away. Verify against the code
  rather than trusting the prose.
- **Documented behavior the code contradicts** — a described default, response
  shape, option, or guarantee that no longer matches.
- **Undocumented contracts a reader must know** — a required environment value,
  a destructive side effect, an ordering requirement, an upgrade step.
- **Stale references** — links to moved or deleted files, examples using retired
  APIs, screenshots of interfaces that no longer exist.
- **Instruction and prompt files that name things that do not exist** — a file,
  function, flag, tool, or command named in AGENTS.md, nested instruction
  files, skills, or the shipped task prompts that is absent from the tree.
  Verify each by search; one finding per file with the list.
- **Missing "why" on non-obvious decisions** — a constraint, workaround, or
  deliberate trade-off that reads as arbitrary and invites someone to "fix" it.
- **Comments that lie** — an inline comment describing behavior the function no
  longer has.

## Respect the project's own conventions

Follow the documentation structure, index, and changelog convention the
repository's instruction files already document rather than introducing a
different one.

The changelog is where this goes wrong most often, so check before you write:
some repos collect a per-branch fragment per change precisely so parallel agents
do not conflict on one shared file, and others derive their notes from commit
history at release time and want no per-change file at all. Appending to a
shared unreleased section is the fallback for a repo that documents no
convention — never the default instruction. If the project states that a file is
retired, honor that.

## Do not pad

Do not add documentation for its own sake: a comment restating the code, a
docstring on an obvious helper, or a README section nobody asked for is
maintenance debt with no reader. Write for someone trying to do something
specific.

For each finding, cite the documentation location and the code that contradicts
it with \`file:LINE\`.`,

  'design': `[Improvement: {appName}] Rendered Design Audit

Repository: {repoPath}

{modeInstructions}

Review {appName}'s actual rendered UI for composition, balance and authored
visual character. This audit defaults to actionable tracker findings. Discover
the app's UI URL and design standards from its own config, README and docs;
managed apps need neither PortOS runtime conventions nor theme support.

## Ownership and deduplication

Design owns rendered composition, visual balance, purposeful media framing,
controls obscuring thumbnails, coherent icon treatment, polished loading/error/
empty states, responsive composition and intentional theme character. UX owns
findability, task flows, interactions, accessibility-aware usability, hierarchy,
clarity, spacing and consistency. Accessibility owns ARIA, contrast and keyboard
failures; ui-bugs owns broken elements/requests; mobile-responsive owns overflow,
clipping, breakpoint, viewport-height and touch defects at viewport width ≤1024.
Responsive composition here means balance and framing, not those layout failures.
Search sibling audits and existing tracker items by root cause, not category or
title. One finding, one owner: reuse the owning issue and add only new evidence;
never split one shared-component cause across routes, themes or audit categories.

## Bounded rendered evidence

1. Inventory routes/components and consult the preloaded Recent audit slices.
   Rotate into unreviewed areas. Choose at most three representative routes:
   a list/media view, a detail/editor mid-workflow, and an overlay or error/empty
   state where relevant. Use synthetic fixtures, never real personal records.
2. Open the running app with available browser automation and actually capture
   AND inspect screenshots. Source, DOM and token checks support attribution,
   but source-only review cannot establish visual quality. If rendering or
   screenshot inspection is unavailable, report coverage unavailable, sliceScore
   null and visual coverage blocked/untested with the exact blocker. Never
   claim visual passing or broad coverage from an unrendered screen.
3. Inspect desktop and one narrow viewport on the representative sample. Bound
   the total to six route/state/viewport/theme captures per run; allocate them
   to the strongest candidates rather than a Cartesian product. Record every
   inspected screenshot's route, state, viewport dimensions, theme (or none),
   responsible component and private/local evidence reference. Unvisited states,
   routes, viewports and themes remain explicitly untested. Reuse the existing
   audit evidence/assessment and AUDIT_SLICE mechanisms; do not build a second
   evidence store. Keep screenshots private/local; public tracker items carry
   redacted observations and synthetic reproductions, not large screenshot dumps.
4. Where themes exist, compare matching representative screens in a small
   sample (at most two themes within the same capture budget). Evaluate intended
   differences in typography, palette, surfaces/material, shape, depth and motion
   where appropriate. For PortOS only, consult docs/themes/README.md and
   client/src/themes/portosThemes.js: Kestrel Neon and Kestrel Dawn are favored
   references, not templates every theme must resemble. Preserve authored
   identity; similar palettes alone are not defects. Apps without themes skip
   the comparison and record themes as not applicable.

## Findings and completion

{trackerInstructions}

Each accepted objective defect needs severity, observed user impact, route/state/
viewport/theme, screenshot inspection evidence plus component file:line, a chosen
bounded fix and precise before/after acceptance criteria. Check framing/cropping,
thumbnail overlays, visual balance, icon coherence and polished states against the
app's authored standards. Aesthetic suggestions belong only in the final report as separate proposals,
not accepted defects or automatically actionable tracker items: do not score
them as defects or file them as defects. Explain
concrete rationale, tradeoffs and a bounded before/after proposal, and mark the
user-owned decision explicitly. They do not authorize automatic cosmetic edits,
theme homogenization or redesigning every theme, even in implement mode. Do not
change production settings/themes or restart services to obtain evidence; use a
safe local preview. Do not invoke heavy models or purchase new assets.

Finish with inspected evidence references, findings and owning issue links,
objective defects versus aesthetic proposals, remaining coverage and why the
sample stopped. Emit the existing quality report and recent-slice markers with
truthful partial/unavailable coverage; a bounded sample is not app-wide visual
certification.`,

  'ux': `[Improvement: {appName}] UX Audit

You are reviewing {appName}'s running UI as a UX reviewer, not as an engineer
fixing bugs. The question you are answering for every screen is **"can a user
actually get their job done here, and does the design help or fight them?"**

Repository: {repoPath}

{modeInstructions}

UX judgment is normally proposed rather than merged: this audit defaults to
filing one tracker item per finding so a human — or a later claim-style task
runner — decides what actually gets built. The mode banner above is what
decides; when it puts you in implement mode, the sections below that describe
recording a finding instead describe the change you make, and you still walk the
interface the same way and hold to the same checklist.

## Where to record findings

{trackerInstructions}

## Out of scope — sibling task types own these

Duplicate findings are noise. Do NOT file:

- **Rendered composition, balance, media framing, thumbnail overlays, icon treatment, polished states and theme character** — \`design\` owns these. UX retains hierarchy, clarity, spacing and consistency when they affect usability.
- **Raw console errors / broken elements / failed requests** — \`ui-bugs\` owns these.
- **Phone and tablet viewports (1024 wide or narrower) and touch mechanics** — \`mobile-responsive\` owns overflow, clipping, breakpoint gaps, viewport-height assumptions, hover-only controls, and tap targets at those viewport widths. This audit's reflow check (item 8) is a narrow CONTAINER on a desktop viewport — a dashboard widget, an embedded panel, a side panel — never a narrow viewport.
- **ARIA labels, contrast ratios, keyboard traps** — \`accessibility\` owns these.
- **The wording of a single string** (jargon, an ambiguous verb, broken plurals) — \`copy\` owns it. How MUCH text a screen spends explaining itself, and whether it repeats what the controls already say, is this audit's (checklist item 9).
- **A workflow that cannot be resumed or cancelled after a failure or reload** — \`workflow-recovery\` owns it. Whether the page tells the user where a record stands is this audit's (checklist item 12).
- **A control that is permanently disabled or "coming soon"** — \`feature-completeness\` owns it.

Mention an overlap only when it is the *cause* of a UX failure you are filing
(e.g. "the empty state is unreachable because the only trigger is a
keyboard-inaccessible icon") — and file it as the UX finding, not as the a11y one.

## What to do

1. **Inventory existing findings so you don't duplicate.** Follow the
   "Inventory" step under "Where to record findings" above for this app's
   tracker. De-duplicate across sibling audits by root cause (one finding, one owner), then by the route/screen and problem described in existing
   items; the tracker block defines their IDs. Older forge issues may have a
   legacy title tag, but new issue titles do not need one.

2. **Discover the running app's UI URL** the same way the \`ui-bugs\` and
   \`mobile-responsive\` audits do — from the app's own config/README/dev-server
   output. If the UI is not reachable, exit cleanly and say so in your summary;
   do NOT file speculative findings from source alone.

3. **Choose routes, then walk them.** Main navigation routes alone are not
   enough: most work happens on record pages. Also open the detail or editor
   route (the \`/:id\` view) of each domain that has records, choosing a record
   partway through its workflow — in progress, awaiting review, failed — over a
   fresh or finished one. Rotate coverage: prefer routes and domains the
   preloaded Recent audit slices block does not list and with no finding from
   this audit in the tracker in the last 30 days, and list the routes you chose
   and why. Describe records by their state, never by their
   names or contents. Walk each chosen route with the browser automation
   available to this run (a CDP tab, Playwright, or the host's browser tool);
   if none is reachable, exit cleanly as step 2 says. For every route:
   - Navigate to it and read the rendered structure (an accessibility snapshot
     or the DOM), not only a screenshot.
   - Start with a desktop viewport (1280 wide or more). Sample one narrow
     viewport only when it answers a distinct task-flow or findability question;
     do not repeat mobile-responsive's phone/tablet layout sweep. Record the
     sampled viewport and leave unsampled widths explicitly untested.

   - Test with the navigation sidebar expanded and collapsed, and at 200% zoom.
   - Resize dashboard widgets and embedded panels to 240px, 320px, and 480px wide on a desktop viewport. Viewport breakpoints do not prove a narrow container fits.
   - Inspect empty, populated, loading, and error states with synthetic long names, URLs, and action labels. Check bounding rectangles and scrollWidth/clientWidth on the page AND cards: overflow-hidden can conceal unreachable controls even when the document has no horizontal scrollbar. Exempt only intentional local scroll regions such as tables/timelines; verify their keyboard access.
   - Record route/widget, viewport AND container width, state, sidebar mode, blocked action, and responsible component. Report unvisited routes/states as untested, never as passing.
   - Read the screen as a user, not only its geometry. From the snapshot, list every visible action with what it does, and every block of instructional or explanatory text longer than one sentence. Then reach the states where a user needs particular information (a failed run, a blocked step, a pending decision, a record just created) and note what is visible there without an extra click. These inventories are the evidence for checklist items 9–11.
   - On a record page, write down in one sentence where the record stands and what the user should do next, using only what is visible above the fold. If you cannot, that is the evidence for checklist item 12.
   - Compare the page's frame with a sibling page of the same family: where the header sits, the outer padding, the maximum width, and which element scrolls. Evidence for checklist item 13.

4. **Evaluate each route against this named checklist.** Cite the checklist
   number in the finding so results are reproducible rather than vibes:

   1. **Primary action visible above the fold** at the sampled desktop viewport
      and any narrow task-flow sample.
      What is the one thing a user comes to this screen to do, and can they see
      it without scrolling?
   2. **Empty / loading / error states name a next action.** A blank panel, a
      bare spinner, or "Something went wrong" with no retry/create/back is a
      finding.
   3. **Affordances are consistent with sibling screens** — button hierarchy
      (one primary per view), drawer vs modal for the same class of task,
      destructive actions confirmed the same way everywhere.
   4. **Copy states an outcome, not a mechanism.** "Sync now" beats "Execute
      job"; "3 items couldn't be saved" beats "PATCH failed".
   5. **No dead ends.** Every state has a way forward or back — a completed
      wizard, a filtered-to-zero list, a detail view reached by deep link.
   6. **Visual consistency** — spacing, typography, and color follow the app's
      own design tokens rather than one-off values drifting per screen.
   7. **Information hierarchy matches the user's task** — what they came for is
      the most prominent thing, not the densest table or the newest feature.

   8. **Narrow-container reflow (desktop viewport, narrow container)** — a dashboard widget, embedded panel, or side panel resized to 240–480px wide inside a desktop viewport shows no overlapping cards, clipped controls, off-screen actions, or page-level horizontal scroll. Toolbars wrap, flexible children shrink, long strings wrap or have an accessible full-value path, and side panels stack before squeezing the primary work. The same defects at a phone or tablet viewport width belong to \`mobile-responsive\`. Consult the app's design standard; for PortOS use docs/UX_DESIGN_GUIDE.md.
   9. **Text earns its space.** A label, then at most one useful sentence, then
      optional detail behind a named disclosure. A finding is a paragraph that
      narrates what the visible controls already make obvious ("Click Repair to
      repair the dependencies"), restates the heading, repeats the same
      explanation above several groups, walks through steps the UI already
      sequences, or pushes the primary action or the result below the fold.
      Quote the text, count its sentences, and propose the one sentence (or
      none) that should remain.
   10. **One control per action.** Two visible controls on the same screen that
      do the same thing — a header button and a card button, a toolbar action
      and a row action, a button beside a link to the same destination, a
      Save in two places — are a finding unless they act on different scope.
      Name both controls and which one should stay.
   11. **What the user needs now is visible now.** Information the user must
      read to decide or act in the current state — the error behind a failure,
      the reason a step is blocked, the output they just generated, the
      prerequisite they must fix — must not sit behind a collapsed section,
      an inactive tab, a hover tooltip, a modal, or a truncated line. A
      disclosure that holds a blocking error must open on its own. The reverse
      is also a finding: a status the user cannot act on that stays expanded
      and dominates the screen. Name the state, where the information is
      hidden, and the click count to reach it.
   12. **A record page says where it stands.** A record that moves through
      stages (a project, a pipeline, a run, an import) shows, above the fold
      and without a click, its current stage, whether it is waiting on the
      user, and the one next action — and gives a way to see, play, or open
      its primary output (the render, the document, the result) from wherever
      the user is on that page. A finding is a status readable only as a raw
      enum or id, a stage strip with no "you are here", a next step the user
      must infer from a row of cards, or output reachable only from one tab.
   13. **Same kind of page, same frame.** Pages of one family share the app's
      page shell: header placement, outer padding, maximum width, and a single
      scroll container. A page whose header is inset, whose padding is
      doubled, or whose content scrolls inside a second scroller, compared
      with its siblings, is a finding. This item may be proven statically as
      well as from the snapshot: compare the route's shell or layout
      configuration and the page's root container with its siblings', and
      check that a detail route (\`/:id\`) gets the same shell as its index.

5. **File ONE item per finding** (except that ${LIGHT_FINDINGS_BATCH_EXCEPTION}) using the "Record" mechanics under "Where to
   record findings" above. Each finding must carry:

   - **A short, human-readable title** naming the screen and the problem. Do
     not invent an issue ID or add a slug/category/severity tag to a forge
     title; follow the selected tracker's ID convention from its instructions.
   - **The screen/route** you audited and which checklist item (1–13) it failed.
   - **What the user is trying to do** on that screen.
   - **Why the current design impedes it** — 1–2 sentences, concrete and
     observable, referencing what you saw in the snapshot.
   - **A concrete proposed change** naming the component file(s) in {appName}
     that would carry it. Describe the BEHAVIOR/layout to change, not a diff.
   - **\`Scope: small | medium | large\`.**

   A finding that needs a product decision before it can be built (a real
   problem, but the right answer is a judgment call the user owns) is a
   **Maybe — needs human call** item: file it the same way and end with the
   \`**Decision needed:** <one sentence>\` line described in the tracker
   instructions.

   Be selective — file the findings that would measurably change whether a user
   succeeds, not every aesthetic preference. A handful of well-argued items
   beats twenty nitpicks. Items 9–13 are not aesthetic preferences: a wall of
   instructions, a duplicated button, a hidden error, a record whose state the
   user cannot read, or a page framed unlike its siblings each costs the user
   reading time, a wrong guess, or a dead end, so file them when you see them.
   When one component causes the same item on several screens, file one
   finding that lists the screens.

6. **Finalize** per the "Finalize" step under "Where to record findings" above,
   and per the mode banner — which is what decides whether this run ends in
   tracker items or in a change.

7. Your final assistant message must be a 2–3 sentence summary of: how many
   routes you audited, how many findings you filed (and their issue numbers or
   tracker IDs), and which checklist items came up most often.`,

  'copy': `[Improvement: {appName}] Copy and text-clarity audit

Audit {appName}'s user-facing copy — labels, tooltips, dialogs, empty states,
and error messages — for clarity, accuracy, and consistency.

Repository: {repoPath}

{modeInstructions}

Hunt specifically for:

- **Internal jargon** — a variable name, database key, or protocol detail
  surfacing in a label where a domain term belongs.
- **Ambiguous action labels** — a generic "OK"/"Submit" on a destructive action
  instead of the actual verb ("Delete", "Discard"), or a "Cancel" that is
  ambiguous about which thing it cancels.
- **Dead-end error text** — "Failed" or "Invalid request" with no statement of
  what was wrong or what the user can do about it.
- **Broken pluralization** — "1 items", "found 1 results", "0 files deleted".
- **Inconsistent terminology** — the same entity or action named one way in the
  nav, another in a dialog, a third in a toast.
- **Clipped labels** — text in a fixed-width container that truncates the word
  carrying the meaning.

Quote the exact current string with \`file.jsx:LINE\`, and give the proposed
replacement plus a one-line rationale. A finding with no proposed wording is
not actionable.`,
};
