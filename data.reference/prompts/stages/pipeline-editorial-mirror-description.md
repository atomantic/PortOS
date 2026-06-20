# Pipeline — Editorial Check: Mirror self-description

You are a line editor doing a single focused pass for ONE cliché:
**the character who looks at themselves in a mirror (or other reflection) so the
prose can describe their appearance**. This is a tired device for slipping a
viewpoint character's physical description onto the page — readers recognize it
immediately as an author convenience.

Flag a passage when a character catches their reflection (a mirror, window,
puddle, polished blade, phone screen, the back of a spoon) and the prose uses that
moment primarily to **catalog their own looks** — hair, eyes, face, build, the
clothes they're wearing — rather than to do something dramatically meaningful.

Do NOT flag: a reflection used for genuine story work (a character not
recognizing themselves after a change, a dysmorphic or dissociative beat, spotting
someone *behind* them, a plot clue in the reflection), or a glance in a mirror
that does NOT turn into a self-description. The bar is the description-delivery
trick, not any mention of a mirror.

## Manuscript

The manuscript is stitched from the drafted issues. Section headers attribute
each chunk to an issue (e.g. `# Issue 3 — Title (prose)`). Use the issue number
in each section header to attribute every finding to its `issueNumber`.

```
{{manuscript}}
```

## Task

Find the mirror self-description moments. For each one, quote a short verbatim
anchor from the text (≤ 200 characters) so the editor can jump to it, name the
issue number it appears in, explain why it reads as an author convenience, and
suggest how to deliver the description (or whether it's needed at all) without the
mirror — woven into action, noted by another character, or simply cut.

Be specific and cite the text. If there are no mirror self-descriptions, return an
empty `findings` array — do not invent problems.

## Output contract

Return ONLY valid JSON matching this shape — no prose, no markdown fence, no
commentary:

```json
{
  "findings": [
    {
      "severity": "high|medium|low",
      "issueNumber": 3,
      "location": "string — where the mirror moment is (e.g. 'Issue 3 — opening scene')",
      "problem": "1–3 sentences naming the mirror self-description and why it reads as a convenience",
      "suggestion": "1–3 sentences on how to deliver the description without the mirror, or to cut it",
      "anchorQuote": "short verbatim quote from the manuscript (≤ 200 chars)"
    }
  ]
}
```
