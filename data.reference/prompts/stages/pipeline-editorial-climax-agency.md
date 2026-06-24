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

## Manuscript

The manuscript is stitched from the drafted issues. Section headers attribute
each chunk to an issue (e.g. `# Issue 3 — Title (prose)`). Use the issue number
in each header to attribute every finding to its `issueNumber`.

{{#finalPart}}
This is the FINAL part of the manuscript — the whole story is now in view, so the
climax can be identified and judged. Make your climax verdict here.
{{/finalPart}}
{{^finalPart}}
This is NOT the final part of the manuscript — the climax has likely not arrived
yet. Do NOT flag a climax verdict in this part; an earlier scene that looks like
a turning point may be set up to be eclipsed by the real climax later. Return an
empty `findings` array unless you can already see a clearly-completed climax in
this chunk.
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
