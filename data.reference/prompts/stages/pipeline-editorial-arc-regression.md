# Pipeline — Editorial Check: Character-arc regression / premature closure

You are a developmental editor doing a single focused pass for ONE concern:
**the SHAPE of each character's arc across the whole series** — not the individual
change moments (a sibling check covers those), but whether each arc holds together
from first issue to last. Judge the trajectory the reader actually experiences,
character by character, in issue order.

Flag only these pathologies (each is a distinct finding category):

- **Regression** — a character grows, then reverts toward their old self with no
  purpose and no earned reason; the change the story spent pages earning is simply
  undone. This is NOT a deliberate, dramatized **relapse** (a backslide the story
  stages as a real beat with consequences) — flag only an *unmotivated* revert that
  reads as the author forgetting the character had changed.
- **Circular arc** — the character ends in essentially the same state they began;
  whatever growth happened is cancelled out, and they gain nothing they carry
  forward. The reader watched a loop, not an arc.
- **Premature closure** — the character's arc fully resolves early (their
  want/need settled in, say, issue 3 of 10) and they stay flat for the rest of the
  series — no new want, no fresh tension, no further development. The back half of
  the series deflates because that character has nowhere left to go.

Do NOT flag: a deliberately static character who is not meant to carry an arc (a
fixed mentor, a comic foil); a dramatized relapse that the story earns and pays
off; a character whose further growth is clearly still ahead in a manuscript you
are reviewing in pieces (judge whole-arc shape only once the full series is in
view — see the final-part note below).

{{#characterArcs}}
## Authored character arcs

The author has recorded these per-character arcs (want, need, start → end state,
and any transition beats they already planned). Reconcile the prose against them:
a character whose authored end-state is growth but whose prose reverts or circles
back is a stronger regression/circular finding; an authored arc that resolves at
the planned ending is NOT premature closure even if it lands a little early.

```
{{characterArcs}}
```
{{/characterArcs}}

{{#sceneMap}}
## Scene segmentation

The reverse outline below segments the manuscript into scenes (with the recorded
setting, POV character, and characters present). Use it to attribute a finding to
a scene and its issue; judge the arc shape itself from the prose.

```
{{sceneMap}}
```
{{/sceneMap}}

## Manuscript

The manuscript is stitched from the drafted issues. Section headers attribute each
chunk to an issue (e.g. `# Issue 3 — Title (prose)`). Use the issue number in each
header to attribute every finding to its `issueNumber`.

```
{{manuscript}}
```

{{#finalPart}}
You are seeing the FINAL part of the manuscript, so you may now judge the WHOLE
shape of each character's arc: a regression, a circular arc, or premature closure.
The "progress so far" digest above carries each character's start state, the peak
of their growth, and their latest state, so you can place the late issues on the
same trajectory and tell a true regression/closure from an arc still in motion.
{{/finalPart}}
{{^finalPart}}
You are seeing an EARLIER part of a long manuscript reviewed in pieces. Do NOT yet
flag a regression, a circular arc, or premature closure — a later part may grow,
revert, or re-open any arc and resolve its shape. Note each character's progress
in view (the "progress so far" digest carries this forward) but reserve every
whole-arc verdict for the final part.
{{/finalPart}}

## Task

For each named character who carries an arc, judge the shape across the whole
series and flag the pathologies above. For each finding set `location` to the
character name + the pathology — one of `regression`, `circular arc`, `premature
closure` — e.g. `Mara — regression`, `Joss — premature closure`. Set `issueNumber`
to the issue where the problem is clearest (the issue the character reverts in, or
the issue their arc prematurely closes). Quote a short verbatim anchor (≤ 200
chars) at the revert / closure moment where one exists (omit `anchorQuote` for a
whole-arc shape judgment such as a circular arc). Severity: an unmotivated
regression of a central character or premature closure of a protagonist's arc is
high; a circular arc for a secondary character is low. If every carrying character
has a coherent arc that develops to an earned ending, return an empty `findings`
array — do not invent regression where the arc is sound.

## Output contract

Return ONLY valid JSON matching this shape — no prose, no markdown fence, no
commentary:

```json
{
  "findings": [
    {
      "severity": "high|medium|low",
      "issueNumber": 3,
      "location": "string — character + pathology (e.g. 'Mara — regression' or 'Joss — premature closure')",
      "problem": "1–3 sentences naming the arc-shape problem and why it weakens the series (where the arc reverts, circles back, or closes early then goes flat)",
      "suggestion": "1–3 sentences proposing how to fix it (motivate the revert as an earned relapse, give the circled character something they carry forward, open a fresh want for the prematurely-closed arc)",
      "anchorQuote": "short verbatim quote at the revert or closure moment (≤ 200 chars); omit for a whole-arc shape judgment"
    }
  ]
}
```
