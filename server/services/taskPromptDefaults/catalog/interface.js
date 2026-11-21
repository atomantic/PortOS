export const prompts = {
  'accessibility': `[Improvement: {appName}] Accessibility Audit

Audit {appName} for barriers that stop someone using it with a keyboard, a
screen reader, magnification, or reduced color perception.

Repository: {repoPath}

{modeInstructions}

If the project has no user interface, say so and exit cleanly.

## Skip what static analysis already covers

Check for a JSX/TSX a11y linter already wired into the project (e.g. Biome's
\`a11y\` rule group, \`eslint-plugin-jsx-a11y\`) before you start, and run it if
one exists. Do NOT re-derive or file findings that linter already catches
deterministically on every commit — missing \`alt\`/labels, invalid or
unsupported ARIA props/roles, an unlabeled form control, a clickable element
with no keyboard handler, a non-interactive element given an interactive ARIA
role, an interactive role that isn't focusable, or \`aria-hidden="true"\` on a
focusable element. Spend your budget on what only a live agent driving the
running interface can establish.

## Hunt for

- **Keyboard traps and unreachable controls** — a custom control the linter
  above can't see is missing (e.g. one built without a native/ARIA element at
  all), a dialog that does not trap and restore focus, or a genuinely
  unreachable path a static scan of individual elements can't catch.
- **Missing focus indication** — a focus style removed and never replaced, so
  keyboard users cannot tell where they are.
- **Images and media without text alternatives** — a meaningful image with no
  description, or a decorative one announced as content — when the linter
  above doesn't already cover this project's markup.
- **Semantics faked with generic elements** — a heading order that skips
  levels, a list that is not marked up as one, a table without headers, or a
  faked-semantics case the linter's element-vs-role rules don't cover.
- **Dynamic changes nobody is told about** — an async result, validation error,
  or toast that appears with no live region, so a screen-reader user never
  learns it happened.
- **Color as the only signal** — state conveyed by color alone, or text and
  interactive elements below the contrast floor.
- **Motion and zoom** — animation that ignores a reduced-motion preference,
  layout that breaks or clips at 200% zoom.

## The bar

Name who is blocked and how far they get: which control, using what input
method, and what happens instead of the intended outcome. Test with the keyboard
before claiming a keyboard defect, and inspect the rendered accessibility tree
rather than guessing from source when the running interface is reachable. If it
is not reachable, audit source only, and say that is what you did.

Prefer the native element over a custom control with added attributes — a
correct element needs no announcement patch. Cite \`file:LINE\` for each finding
and give the concrete fix.`,

  'console-errors': `[Improvement: {appName}] Console Error Investigation

Find the errors and warnings {appName} actually emits while running, and fix
their causes.

Repository: {repoPath}

{modeInstructions}

## Collect before diagnosing

Exercise the application and collect what it really emits: browser console
errors and warnings across the main views, server logs during startup and
ordinary use, failed network requests, and unhandled promise rejections. If the
running application is not reachable, say so and audit source only rather than
inventing findings from imagination.

## Then, for each distinct message

- Identify the source with \`file:LINE\` and the action that triggers it.
- Find the root cause rather than the line that reported it — the stack frame
  that threw is often not the mistake.
- Judge whether it is a real defect or expected noise. A warning from a
  dependency you cannot control, or a deliberate diagnostic, is not a defect;
  say so and move on rather than silencing it.
- Group duplicates: one cause emitting fifty lines is one finding, not fifty.

## Never fix an error by hiding it

Suppressing a warning, wrapping a throw in an empty catch, or removing the log
line is not a fix — it converts a visible failure into an invisible one. If the
message is genuinely expected, the fix is to stop producing the condition, or to
document why it is expected where the next person will see it.

## Not yours

A missing log, a swallowed error, or log noise as a design problem belongs to
the observability work. Component effect and lifecycle defects belong to the
UI lifecycle and state work. Fix what actually errors; name overlaps and leave them.

For each finding: the message, the trigger, the root cause with \`file:LINE\`, and
the fix. In implement mode, re-run the same exercise and confirm the message is
gone.`,

  'ui-bugs': `[Improvement: {appName}] UI Bug Analysis

Walk {appName}'s running interface and find things that are actually broken.

Repository: {repoPath}

{modeInstructions}

## Exercise the interface

Discover the running application's URL from the project's own configuration,
README, or dev-server output. Visit each main view and, for every one: read the
rendered structure, check the console for errors, watch for failed network
requests, and interact with the primary controls rather than only looking at the
page.

If the interface is not reachable, exit cleanly and say so. Do not file
speculative findings from source alone; a defect proven by reading both sides
of a call (see "Statically provable crashes" below) is not speculative.

## Hunt for

- **Controls that do nothing** — a button, link, or form whose action fails
  silently or never fires.
- **Data that never arrives** — a view stuck in loading, a panel showing an
  empty state while its request succeeded, a value rendered as undefined, null,
  NaN, or a raw identifier.
- **Failed requests** — a call returning an error the interface does not
  surface, or one firing repeatedly in a loop.
- **Broken rendering** — overlapping or clipped elements, a component that
  crashes its subtree, an image or icon that fails to load.
- **State that does not update** — a mutation that succeeds on the server but
  leaves the view stale until reload, or a list that loses its selection.
- **Navigation defects** — a route that 404s, a deep link that lands somewhere
  else, a back navigation that loses state it should keep.
- **Unhappy paths of primary actions** — the not-found, empty-input, conflict,
  and failure branch of each primary control, not only its success path. A
  handler that throws only on its error branch is invisible to a happy-path
  walk, so trigger that branch deliberately.
- **Statically provable crashes** — where no type checker runs, a call to a
  member the imported module does not define, or a named import it does not
  export, on a path a control reaches. Reading the callee's real export is the
  proof; name the control that reaches it. When one module's contract is
  broken at several call sites, file one finding for the class and propose a
  mechanical guard rather than one fix per site.

## Not yours

Viewport and layout breakage at small sizes belongs to the mobile and responsive
work; keyboard, contrast, and screen-reader barriers to the accessibility work;
design and flow judgments to the UX work; wording to the copy work; a
multi-step workflow that strands its record after a failure or reload to the
workflow-recovery work; a control that was never finished to the
incomplete-feature work. This audit owns things that are broken, not things
that could be better.

For each finding: the view, the exact steps to reproduce, what happens, what
should happen, and the \`file:LINE\` of the cause once you have traced it.`,

  'app-bugs': `[Improvement: {appName}] App and server bug hunt

Find the behavior bugs in {appName}'s server and core logic that a user would
hit before you do: wrong results, broken edge cases, and the races its real
usage can trigger.

Repository: {repoPath}

{modeInstructions}

## Work from what the app promises

Inventory the user-facing workflows the server owns: its routes and their
handlers, background and scheduled jobs, imports and syncs, and any CLI the
project documents. For each, read what it promises (the requirements, PRD,
spec or design docs, route name, tests, the UI control that calls it), then
trace the code that keeps the promise and look for where it does not.

Run the project's own tests for the slice you review. When the app is running
and a read-only request settles a question, make it; never write to the live
install's real records to prove a bug. Reproduce a write-path bug with a
focused test or a scratch data directory instead.

## Hunt for

- **Wrong results** — a calculation, filter, sort, merge, or status that is
  wrong for an ordinary input: an inverted condition, a field read from the
  wrong record, a default that overrides a real value.
- **Edge inputs real users send** — empty, missing, very long, non-ASCII, a
  duplicate name, a zero or negative number, the first and last item, a date
  across midnight or a time zone. Check the input the UI or an import actually
  produces, not every type the code could in theory receive.
- **Success that did nothing** — a handler that answers 200 while the write,
  job, or side effect it promises was skipped, partial, or failed.
- **State machines that wedge** — a status that can be entered but never left,
  a retry that repeats a completed step, a cancel that leaves work running.
- **Races the user can actually trigger** — the same action fired twice (double
  click, retry after a timeout), two tabs or devices on one record, a scheduled
  or background job running while the user edits what it touches, two jobs
  sharing one file, record, or external resource, a peer sync landing mid-edit,
  a restart in the middle of a multi-step operation.
- **Contract drift between producer and consumer** — the client, a job, or a
  peer reading a field the server renamed, stopped sending, or sends in another
  shape.

## Not yours — name the overlap and move on

Crashes and console errors seen while walking the interface belong to the
UI-bug and console-error work; code-shape defects such as missing awaits, leaks,
and unguarded nulls to the runtime-safety work; lost updates on a persisted
record to the data-integrity work; per-call failure handling to the
failure-path work; workflows stranded with no resume or cancel to the
workflow-recovery work.

## The bar: a user could hit it

Every finding states the user action or job that triggers it, the inputs or
interleaving, what happens, and what should happen. A race must name both
actors and how they come to overlap in real use. Cite \`file:LINE\` for the
defect and for the route, job, or control that reaches it. If you cannot
describe how a user or a job of this app reaches the bug, drop it.`,

  'mobile-responsive': `[Improvement: {appName}] Mobile and Responsive Audit

Check that {appName} is usable on a small screen and a touch device, not merely
that it renders.

Repository: {repoPath}

{modeInstructions}

## Exercise real viewports

Discover the running application's URL from the project's own configuration,
README, or dev-server output, then walk each main view at a small phone width, a
tablet width, and a desktop width. Compare: a defect is usually something that
works at one size and fails at another. If the interface is not reachable, exit
cleanly and say so.

This audit owns every layout defect at a viewport width ≤1024 and touch
mechanics. A narrow container inside a desktop viewport — a dashboard widget,
an embedded panel, a side panel — belongs to the UX work's reflow check, so do
not file it here.

## Hunt for

- **Horizontal overflow** — a fixed width, an unwrapped row, a wide table, or a
  long unbroken string forcing the page to scroll sideways.
- **Touch targets too small or too close** — a control under roughly 44 by 44
  points, or crowded against its neighbors so the wrong one is hit.
- **Hover-only interactions** — a menu, tooltip, or control reachable only by
  hovering, with no touch equivalent.
- **Content clipped or truncated** — text cut off where wrapping was expected,
  especially variable-length or user-supplied content.
- **Viewport-height assumptions** — a full-height layout that breaks when mobile
  browser chrome covers part of the viewport.
- **The primary action pushed off-screen** — the one thing a user came to the
  view to do, requiring a scroll to find on a phone.
- **Breakpoint gaps** — a component styled for some sizes but not the project's
  full breakpoint scale, or a one-off media query that does not match it.
- **Oversized assets** — an image shipped far larger than its rendered size, or
  without responsive sources.

## The bar

Name the viewport width, the view, and what a user cannot do there. A layout
that merely looks different at a smaller size is not a finding; one that hides,
clips, or blocks an action is. Use the project's existing responsive
conventions — its breakpoint scale and utility classes — rather than adding
one-off values.

Cite \`file:LINE\` for the rule or component responsible.`,

  'ui-lifecycle': `[Improvement: {appName}] UI lifecycle and state audit

Audit {appName}'s UI resource lifetimes and state correctness.

Repository: {repoPath}

{modeInstructions}

First identify the application's UI runtime, rendering model, and state-management
conventions from its dependencies and code. Apply checks only where those
mechanisms exist, including client navigation and hydrated interactive regions.
Use the project's own lifecycle and reactivity semantics; do not prescribe a
framework, API, or state library. If there is no applicable interactive UI,
report the check as not applicable rather than inventing findings.

Inspect UI components, shared state, subscriptions, and asynchronous work for:

- **Resource lifetime leaks** — listeners, timers, sockets, observers, or
  subscriptions surviving the view or owner that should release them.
- **Stale reads** — callbacks, cached computations, or reactive dependencies
  using outdated input and producing an incorrect visible result.
- **Async ordering and disposal** — an earlier response overwriting newer user
  intent, or work completing after its owner is disposed and causing observable
  damage. Verify the runtime's actual behavior before treating a late update as
  a defect.
- **State ownership and synchronization** — duplicated or derived state drifting
  from its source, lost edits, or shared state leaking between views or sessions.
- **Repeated or misplaced work** — rendering or reactive updates triggering
  duplicate side effects, feedback loops, or unnecessary persistent resources.
- **Navigation and hydration continuity** — applicable view transitions or
  server-to-client handoffs resetting user state, duplicating subscriptions, or
  applying state to the wrong view.
- **Failed loads rendered as empty** — a list, picker, or panel whose fetch
  failure is swallowed into an empty collection, so the user cannot tell an
  error from an empty library and has no retry. The fix is a
  loading/ready/error state with a retry, not a toast.

For each finding, trace the interaction sequence and state transitions, cite
the affected code, and show the user-visible failure or resource leak. A code
pattern alone is not a finding; verify it against the installed runtime's
semantics and existing safeguards.`,
};
