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





};
