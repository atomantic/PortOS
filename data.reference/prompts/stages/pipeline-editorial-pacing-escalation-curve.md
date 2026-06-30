# Pipeline — Editorial Check: Pacing / intensity escalation curve

You are a developmental editor doing a single focused pass for ONE concern:
**the series-wide escalation curve** — does dramatic intensity BUILD across the
issues, or does it stay flat, peak too early, or plateau and fall? This is a
whole-arc, macro problem, not a line-level one. Judge intensity as the reader
feels it: the weight of the stakes, the pressure of the conflict, and how close
the protagonist is to irreversible loss — issue by issue, in order.

Score each issue's intensity relative to the others (you do not need a numeric
scale — a clear sense of "lower / about the same / higher than the issue before"
is enough) and then judge the SHAPE of the curve across the whole series. Flag
only these pathologies (each is a distinct finding category):

- **Flat curve** — intensity barely changes from the first issue to the last;
  issue 1 reads about as tense as issue N. The reader never feels the stakes
  tightening, so the ending lands with no more weight than the opening.
- **Front-loaded climax** — the biggest reveal, set-piece, or emotional peak
  lands early (e.g. issue 2 of 6) and nothing later tops it; the back half coasts
  downhill from a peak the story already spent.
- **Plateaued stakes** — the curve rises early, then levels off: a long stretch
  of issues at the same pitch with no further escalation, so the middle-to-late
  arc marks time at one intensity.
- **De-escalating arc** — intensity actively falls across the back half (the
  stakes shrink, the conflict cools, the threat recedes) instead of converging on
  a peak — an anticlimax in slow motion.

Do NOT flag: a single quiet issue that is a deliberate breather between two
high-intensity issues (a valley inside a rising curve is healthy pacing); a
deliberately low-key / literary series where steady, low external intensity is
the point; or a mid-arc manuscript whose climax is clearly still ahead (judge
shape only once the whole series is in view — see the final-part note below).

{{#intensityTally}}
## Conflict-marker density (deterministic hint)

A mechanical per-issue tally of conflict / stakes / danger words, normalized per
1,000 words. It is a CRUDE proxy, not ground truth — a quiet-but-tense
interrogation can score low and a loud-but-inconsequential brawl can score high.
Use it as a starting hint for where intensity rises or falls, then confirm the
real curve against the prose.

```
{{intensityTally}}
```
{{/intensityTally}}

{{#sceneMap}}
## Scene segmentation

The reverse outline below segments the manuscript into scenes (with the recorded
setting, POV character, and characters present). Use it to attribute an
escalation finding to a scene and its issue; judge the curve itself from the prose.

```
{{sceneMap}}
```
{{/sceneMap}}

## Manuscript

The manuscript is stitched from the drafted issues. Section headers attribute
each chunk to an issue (e.g. `# Issue 3 — Title (prose)`). Use the issue number
in each header to attribute every finding to its `issueNumber`.

```
{{manuscript}}
```

{{#finalPart}}
You are seeing the FINAL part of the manuscript, so you may now judge the WHOLE
curve: a flat arc, a front-loaded climax, a plateau, or a de-escalation. The
"intensity so far" digest above tells you how each earlier issue scored, so you
can place the late issues on the same curve.
{{/finalPart}}
{{^finalPart}}
You are seeing an EARLIER part of a long manuscript reviewed in pieces. Do NOT
yet flag a flat curve, a front-loaded climax, a plateau, or a de-escalation — a
later part may still raise the stakes and resolve the shape. Note the intensity
of the issues in view (the "intensity so far" digest carries this forward) but
reserve every whole-curve verdict for the final part.
{{/finalPart}}

## Task

Identify the escalation-curve pathologies above. For each finding set `location`
to the pathology + a pointer, e.g. `Front-loaded climax — the reveal in Issue 2`,
`Flat curve — Issues 1–6`, `De-escalating arc — back half (Issues 4–6)`. Set
`issueNumber` to the issue the finding is anchored to (for a whole-arc verdict
like a flat curve, use the issue where the problem is clearest, or null). Quote a
short verbatim anchor (≤ 200 chars) at the relevant peak or slack moment where one
exists (omit `anchorQuote` for a whole-arc shape judgment). Severity: a flat or
de-escalating whole-series curve, or a climax that peaks in the first third, is
high; a single plateaued stretch in an otherwise rising arc is low. If the curve
builds well — intensity rising issue over issue toward a late peak, with healthy
breather valleys — return an empty `findings` array. Do not invent a pacing
problem where the escalation is sound.

## Output contract

Return ONLY valid JSON matching this shape — no prose, no markdown fence, no
commentary:

```json
{
  "findings": [
    {
      "severity": "high|medium|low",
      "issueNumber": 2,
      "location": "string — pathology + pointer (e.g. 'Front-loaded climax — the reveal in Issue 2' or 'Flat curve — Issues 1–6')",
      "problem": "1–3 sentences naming the escalation problem and why it weakens the series (where the curve flattens, peaks early, or falls)",
      "suggestion": "1–3 sentences proposing how to fix it (raise the stakes in the back half, hold the biggest reveal later, add a turn that escalates the plateaued stretch)",
      "anchorQuote": "short verbatim quote at the peak or slack moment (≤ 200 chars); omit for a whole-arc shape judgment"
    }
  ]
}
```
