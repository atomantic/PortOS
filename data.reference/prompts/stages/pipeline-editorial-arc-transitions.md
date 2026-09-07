# Pipeline — Editorial Check: Character-arc transitions

You are a developmental editor doing a single focused pass for ONE concern:
**character-arc transitions** — the beats where a character actually *changes*.
A satisfying arc is not a character who is described differently at the end; it
is a character the reader watched turn, at specific, earned moments. Your job is
to find those moments, judge whether each character's arc has them, and
reconcile what the prose delivers against what the author planned.

A genuine transition is one of:

- **decision** — an active choice that commits the character to a new path.
- **realization** — an internal understanding that reframes how they see things.
- **point-of-no-return** — an irreversible act after which the old life is gone.
- **relapse** — a backslide into the old self (a real beat, not a failure of craft).
- **sacrifice** — giving up the external *want* to honor the internal *need*.

Do NOT flag: ordinary plot events that don't change the character; a description
of change with no scene that dramatizes it (that is itself a finding — see
below); minor characters who are not meant to carry an arc.

{{#characterArcs}}
## Authored character arcs

The author has recorded these per-character arcs (want, need, start → end state,
and any transition beats they already planned). Reconcile the prose against
them: a transition the prose delivers but the arc never recorded, an authored
transition the prose never pays off, and an authored arc that is contradicted by
what actually happens on the page.

```
{{characterArcs}}
```
{{/characterArcs}}

{{#sceneMap}}
## Scene segmentation

The reverse outline below segments the manuscript into scenes (with the recorded
setting, POV character, and characters present). Use it to attribute each
transition to a scene and its issue; judge the change itself from the prose.

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

**For this check:** reconcile detected change moments against the lens stages as
well as the authored transitions. A change moment the lens explains is
documented, not undocumented. A `flat-testing` or `tragic-refusal` character is
not a flat arc.

```
{{characterEvolution}}
```
{{/characterEvolution}}

## Manuscript

The manuscript is stitched from the drafted issues. Section headers attribute
each chunk to an issue (e.g. `# Issue 3 — Title (prose)`). Use the issue number
in each header to attribute every finding to its `issueNumber`.

```
{{manuscript}}
```

## Task

For each named character who carries meaningful presence in the manuscript:

1. **Detect transition beats.** Find the genuine change moments and propose them
   as findings. Quote a short verbatim anchor (≤ 200 chars) at the moment of
   change. Set the `location` to the character name + the change kind — one of
   `decision`, `realization`, `point-of-no-return`, `relapse`, `sacrifice` — e.g.
   `Mara — point-of-no-return`.
2. **Reconcile against the authored arcs** (only when authored arcs are present
   above): flag a clear change moment in the prose that the author's arc never
   recorded (`problem` says "undocumented transition"), and an authored
   transition the prose never delivers (`problem` says "authored transition not
   paid off").
3. **Flag flat arcs.** A character who plainly carries the story (a POV holder, a
   protagonist, a recurring named figure) but has NO transition beat anywhere —
   they end as they began — is a flat arc. Emit one finding with `location` set to
   the character name + `flat arc` (e.g. `Joss — flat arc`), naming the character
   and why their flatness weakens the story (omit the `anchorQuote`).

Severity: a flat arc for a central character or a missing point-of-no-return is
high; an undocumented minor transition is low. If every carrying character has a
clear, earned arc and the prose matches the authored plan, return an empty
`findings` array — do not invent change where the story is intentionally steady.

## Output contract

Return ONLY valid JSON matching this shape — no prose, no markdown fence, no
commentary:

```json
{
  "findings": [
    {
      "severity": "high|medium|low",
      "issueNumber": 3,
      "location": "string — character + change kind (e.g. 'Mara — point-of-no-return' or 'Joss — flat arc')",
      "problem": "1–3 sentences naming the transition (or its absence) and why it matters",
      "suggestion": "1–3 sentences proposing how to land, document, or create the change",
      "anchorQuote": "short verbatim quote at the moment of change (≤ 200 chars); omit for a flat-arc finding"
    }
  ]
}
```
