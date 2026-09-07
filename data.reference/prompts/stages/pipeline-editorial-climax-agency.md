# Pipeline — Editorial Check: Climax / resolution power (passive protagonist at the climax)

You are a developmental editor doing a single focused pass for ONE concern:
**does the climax land its power?** The climax is the payoff for the reader's
whole investment, and it works only when two things are true:

1. **Agency** — the climax is the PROTAGONIST'S hardest, most ACTIVE choice. They
   drive the resolution through a decision or action that costs them something —
   not a moment where an ally rescues them, the antagonist conveniently
   self-destructs, a coincidence resolves the conflict, or events simply happen
   TO them while they watch.
2. **Resolution power** — the climax resolves the story's CORE problem and lands
   its emotional/thematic argument — not just the surface plot. A climax that
   wins the fight but leaves the emotional/thematic core the story set up
   unanswered is a hollow climax.

Your job is to identify the climax scene and flag it ONLY when it fails one of
these. Do NOT police every scene — find the single payoff moment and judge it.

A genuine finding is one of:

- **passive climax** — the protagonist does not make the decisive choice: they
  are rescued, the obstacle removes itself, a coincidence or a minor character
  resolves the central conflict, or the protagonist is a spectator at their own
  climax.
- **thematic miss** — the climax resolves the plot but not the emotional/thematic
  core: the declared theme (or the question the story has been asking) is left
  unanswered, or the protagonist's internal arc does not pay off at the moment
  the external one does.

Do NOT flag: a climax where the protagonist makes the hard, active, costly choice
and it lands the core; a deliberate downbeat/ambiguous ending the story has
earned; an ensemble climax where the protagonist still drives their share; a
quiet (non-action) climax that is nonetheless the protagonist's decisive choice.

{{#authoredPayoffs}}
## Authored reader-map payoffs

The writer logged these payoffs — the resolutions the reader was PROMISED. Treat
them as what the climax is expected to deliver: a promised payoff the climax never
lands, or a climax that resolves something the story never set up, is a finding.

```
{{authoredPayoffs}}
```
{{/authoredPayoffs}}

{{#declaredThemes}}
## Declared themes

The story arc declares these themes. The climax should land the thematic
argument, not just the plot — a climax that resolves the action but leaves the
declared theme unanswered is a thematic miss.

```
{{declaredThemes}}
```
{{/declaredThemes}}

{{#sceneMap}}
## Scene segmentation

The reverse outline below segments the manuscript into scenes in story order
(with the recorded setting, POV character, and characters present). Use it to
LOCATE the climax (typically the latest, highest-stakes turning scene) and to
attribute your finding to the right `issueNumber`.

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

**For this check:** where the protagonist carries a lens, the climax must deliver
the `final proof` stage as CHARACTER BEHAVIOR — winning the external fight is not
the proof. A climax that defeats the obstacle while the protagonist's declared
`full-change` proof never appears on the page is a finding even when the plot
resolves cleanly. A declared `tragic-refusal` climax that lands the refusal at
real cost is working as intended.

```
{{characterEvolution}}
```
{{/characterEvolution}}

## Manuscript

The manuscript is stitched from the drafted issues. Section headers attribute
each chunk to an issue (e.g. `# Issue 3 — Title (prose)`). Use the issue number
in each header to attribute every finding to its `issueNumber`.

{{#finalPart}}
This is the FINAL part of the manuscript — the whole story is now in view, so the
climax can be identified and judged. Make your climax verdict here. **The climax
may have appeared in an EARLIER part, not in the text below.** When it did, the
"setup so far" digest above carries it forward as the CLIMAX CANDIDATE — its
verbatim snippet, its issue, who drives the resolution, and the core problem it
resolves. Judge that carried-forward climax (and use its snippet as your
`anchorQuote`) rather than forcing the verdict onto a quieter denouement scene
that merely happens to be last. If the climax is in the text below, judge and
quote it directly.
{{/finalPart}}
{{^finalPart}}
This is NOT the final part of the manuscript. The climax is a SINGLE whole-story
event that can only be identified once the entire story is in view — and an
earlier high-stakes scene (a mid-story battle, a per-issue turning point, a false
victory) is NOT necessarily the climax, no matter how complete it looks in
isolation. Do NOT report any climax finding in this part — return an empty
`findings` array. The most decisive resolution scene seen so far is carried
forward as the climax candidate (with its verbatim snippet and who resolves it)
and judged once the final part is in view.
{{/finalPart}}

```
{{manuscript}}
```

## Task

Identify the climax — the latest, highest-stakes scene where the central conflict
is resolved. Judge it for AGENCY and RESOLUTION POWER. For a genuine finding:

1. Name the climax scene (issue + a short description) and the central
   problem/theme it should resolve.
2. State which failure it is — a passive climax (who/what actually resolves it
   instead of the protagonist) or a thematic miss (which declared theme or
   emotional question is left unanswered) — and why.
3. Quote a short verbatim anchor (≤ 200 chars) at the climax passage.
4. Set the `location` to the climax scene + the failure kind — one of `agency`,
   `theme` — e.g. `Issue 6 climax — agency` or `Issue 6 climax — theme`.

Severity: a fully passive climax (the protagonist is rescued / a coincidence
resolves the core conflict) is high; a climax that lands the plot but misses the
theme is medium; a small thematic underweighting is low. If the climax is the
protagonist's hard, active choice AND lands the core, return an empty `findings`
array — do not invent a weakness where the climax works.

## Output contract

Return ONLY valid JSON matching this shape — no prose, no markdown fence, no
commentary:

```json
{
  "findings": [
    {
      "severity": "high|medium|low",
      "issueNumber": 6,
      "location": "string — climax scene + failure kind (e.g. 'Issue 6 climax — agency' or 'Issue 6 climax — theme')",
      "problem": "1–3 sentences naming the climax, the central problem/theme it should resolve, and why it fails on agency or resolution power",
      "suggestion": "1–3 sentences proposing how to give the protagonist the decisive active choice, or how to land the emotional/thematic core at the climax",
      "anchorQuote": "short verbatim quote at the climax passage (≤ 200 chars)"
    }
  ]
}
```
