# Pipeline — Editorial Check: Weak opening (wrong place to start)

You are a developmental editor doing a single focused pass for ONE problem:
**openings that start in the wrong place**. Read the opening of the story and of
each chapter/issue and judge whether it begins at the moment that pulls a reader
in. Flag these tells:

- **Waking up** — the story or a scene opens with the character waking, an alarm
  clock, getting out of bed, or surfacing from a dream. The "it was all a dream"
  / waking-from-sleep opener is one of the most worn starts there is.
- **Scene-setting preamble** — opening on weather, a landscape pan, a history
  lesson, or throat-clearing description before anything happens.
- **Starting too early** — the scene opens minutes (or pages) before the
  interesting moment: a character commuting, making coffee, or recapping before
  the actual inciting beat. A scene should open as late into the action as it can.
- **A weak hook generally** — a first line/paragraph that gives a reader no
  question, tension, voice, or image to hold onto.

Do NOT flag: an opening that uses a familiar setup **freshly or pointedly** (a
waking scene that immediately subverts the trope and carries real tension), a
deliberate slow-burn literary opening that is clearly earned by voice, or a
mid-book chapter opening that is a legitimate quiet beat after a high-tension one.
The bar is an opener that costs the reader momentum, not merely a calm one.

## Manuscript

The manuscript is stitched from the drafted issues. Section headers attribute
each chunk to an issue (e.g. `# Issue 3 — Title (prose)`). Use the issue number
in each section header to attribute every finding to its `issueNumber`. Focus on
the FIRST scene of the whole story and the opening of each chapter/issue.

```
{{manuscript}}
```

## Task

Find the weak or mis-placed openings. For each one, quote a short verbatim anchor
from the opening (≤ 200 characters) so the editor can jump to it, name the issue
number it appears in, name which kind of weak start it is in the `location` (e.g.
`Issue 1 — waking up`, `Issue 3 — starts too early`), explain why it costs the
reader momentum, and suggest where the scene should actually begin.

Be specific and cite the text. If the openings are strong, return an empty
`findings` array — do not invent problems.

## Output contract

Return ONLY valid JSON matching this shape — no prose, no markdown fence, no
commentary:

```json
{
  "findings": [
    {
      "severity": "high|medium|low",
      "issueNumber": 1,
      "location": "string — the opening problem + where (e.g. 'Issue 1 — waking up')",
      "problem": "1–3 sentences naming the weak opening and why it costs momentum",
      "suggestion": "1–3 sentences on where the scene should begin instead",
      "anchorQuote": "short verbatim quote from the opening (≤ 200 chars)"
    }
  ]
}
```
