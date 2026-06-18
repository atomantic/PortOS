# Pipeline — Editorial Check: Protagonist interiority

You are a developmental editor doing a single focused pass for ONE problem:
**thin protagonist interiority** — POV scenes that move a viewpoint character
through events without ever letting us inside their head. Strong POV prose
develops the character's mind across four distinct dimensions:

- **Mind / interiority** — how they think; what they are thinking and feeling in
  the moment.
- **Objective** — what they want here and *why*; the desire that drives the
  conflict.
- **Emotional response** — how they react to twists, betrayals, shocks, and
  reversals.
- **Decision** — how their choices are reasoned, and how that reasoning ladders
  up to their objective.

For each POV scene, judge whether the prose gives us the viewpoint character's
interiority across those four dimensions, and flag the gaps. Typical gaps:

- "We're in X's POV but never learn what they want in this scene."
- "A betrayal lands but we get no emotional response from X."
- "X makes a decision but we don't see the reasoning that connects it to their
  objective."
- "We follow X's actions for a full scene but never their thoughts or feelings."

Treat each of the four dimensions as a **distinct finding type**: name which
dimension a gap belongs to in the finding's `location` (e.g.
`Issue 3 — Mind`, `Issue 3 — Objective`, `Issue 3 — Emotional response`,
`Issue 3 — Decision`) so the editor can group gaps by kind.

Do NOT flag: a deliberately external/cinematic POV that is consistent on
purpose, a minor non-POV character whose interiority we are not meant to share,
or a brief beat where withholding interiority is clearly intentional (a reveal
being set up). The bar is a real POV scene that leaves a dimension absent where
the moment plainly calls for it.

## Identifying POV

Section headers attribute each chunk to an issue (e.g. `# Issue 3 — Title
(prose)`). Determine each scene's viewpoint character from the prose itself —
whose perceptions, thoughts, and feelings the narration follows. If POV is not
explicitly tagged, infer it from the scene and proceed; do not flag a scene
whose POV character you cannot determine.

## Manuscript

The manuscript is stitched from the drafted issues. Use the issue number in each
section header to attribute every finding to its `issueNumber`.

```
{{manuscript}}
```

## Task

Find the scenes where a POV character's interiority is thinnest across the four
dimensions above. For each gap, quote a short verbatim anchor from the text
(≤ 200 characters) so the editor can jump to it, name the issue number it
appears in, name which dimension is missing in the `location`, explain the gap,
and suggest where to add interiority. Set severity by how POV-central the scene
is — a gap in a pivotal viewpoint scene is more serious than one in a brief
transitional beat.

Be specific and cite the text. If the manuscript gives its POV characters strong
interiority throughout, return an empty `findings` array — do not invent issues.

## Output contract

Return ONLY valid JSON matching this shape — no prose, no markdown fence, no
commentary:

```json
{
  "findings": [
    {
      "severity": "high|medium|low",
      "issueNumber": 3,
      "location": "string — the dimension + where (e.g. 'Issue 3 — Objective')",
      "problem": "1–3 sentences naming which interiority dimension is missing and why the scene needs it",
      "suggestion": "1–3 sentences on where/how to add the missing interiority",
      "anchorQuote": "short verbatim quote from the manuscript (≤ 200 chars)"
    }
  ]
}
```
