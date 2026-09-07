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

{{#characterEvolution}}
## Authored character evolution (five-stage lens)

The author has recorded an OPTIONAL five-stage lens for the characters below. It
states the causal chain the story runs a character through:

**tested control belief → external pressure → the choice → the cost paid → the
final behavioral proof**

- *control strategy failing* — the belief the character controls their world
  with, and the first sign it no longer works.
- *pressure forces exploration* — the external pressure that makes the old
  strategy unusable and forces them to look for another way.
- *commitment to change* — the choice they actually make.
- *cost tested* — what that choice costs them, and whether they can bear it.
- *final proof* — the closing BEHAVIOR that proves the change (or the refusal).

The `declared outcome` is authored intent. It changes your verdict; it never
suppresses this check:

- `full-change` — the change must endure and be proven by behavior. A payoff won
  only by defeating an external obstacle, with no behavioral proof on the page,
  IS a finding.
- `tragic-refusal` — doubling down on the control belief is the INTENDED ending.
  Do not flag it as a flat or failed arc. The finding here is the opposite: a
  refusal that was never genuinely tested — no real pressure, no cost paid — so
  the character never had a change to refuse.
- `flat-testing` — the belief is tested and deliberately HOLDS; the character
  changes the world around them instead of themselves. Constancy is the point:
  do not flag it as a flat arc.
- `partial-open` — partial change, or an ending left genuinely open, is a
  legitimate literary ending. Incompleteness itself is NOT a finding; an
  UNEARNED CLAIM OF COMPLETION is — prose asserting the character is transformed
  when the stages were never paid off.
- `undeclared` — the author has not yet said how the arc lands. Treat the stages
  as provisional planning, not as intent to hold the prose to.

Evidence: a stage annotated `[stale]` points at a beat that no longer exists and
`[unverified]` could not be resolved. Neither is proof. Missing or unresolved
evidence means NOT PROVEN — never read it as passing.

Two failure modes need DIFFERENT repairs — never merge them into one finding:

- **no authored intent** — the character has no lens stage for a change the prose
  shows or plainly needs. Begin `problem` with `No authored intent:` and make
  `suggestion` name the stage to author.
- **authored intent not delivered** — a stage IS authored but the page never
  delivers it. Begin `problem` with `Authored intent not delivered:` and make
  `suggestion` name the concrete scene or plan beat that would land that stage.

This is a craft lens over the authored beats — NOT a page count, a chapter count,
or a percentage layout. Do not require five chapters, fixed positions, a stage
per issue, or a changed belief that is the literal opposite of the tested one. A
character with no lens is judged exactly as they were before.

**For this check:** a revert the lens declares as `tragic-refusal` is the
intended ending, not a regression, and a `flat-testing` character is not a
circular arc. A `partial-open` ending is not premature closure. Judge a
`full-change` arc as closed only when the `final proof` stage is delivered as
behavior on the page.

```
{{characterEvolution}}
```
{{/characterEvolution}}

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
