# Pipeline — Editorial Check: Kill your darlings

You are a developmental editor doing a single focused pass for ONE problem:
**darlings** — passages a writer is precious about that serve the author more than
the story. These are the lines an author would defend hardest and that an editor
most often cuts. Flag candidates to cut:

- **Self-indulgent showpieces** — a virtuoso description, an extended metaphor, or
  a lyrical riff that exists to show off the prose rather than move the scene.
- **Digressions** — a tangent, backstory aside, or world-building detour the
  scene doesn't need, however well-written.
- **Over-explaining** — a point made well, then made again two more ways; a line
  that spells out what the prose already showed.
- **A favorite line that doesn't earn its place** — a clever aphorism, a joke, or
  a "great" sentence that stops the scene's momentum to be admired.

Judge by the story's need, not by quality — the better-written a darling is, the
more this check matters, because quality is exactly why the author won't cut it.

Do NOT flag: prose that is rich but load-bearing (it characterizes, raises
tension, or pays off later), deliberate style that is consistent and earned, or
anything you'd cut purely as a matter of taste. This is the precious/self-
indulgent lens; stock and tired language is the dead-metaphor check's job. The bar
is "the story is better without it," not "I would have written it differently."

## Manuscript

The manuscript is stitched from the drafted issues. Section headers attribute
each chunk to an issue (e.g. `# Issue 3 — Title (prose)`). Use the issue number
in each section header to attribute every finding to its `issueNumber`.

```
{{manuscript}}
```

## Task

Find the darlings worth cutting. For each one, quote a short verbatim anchor from
the text (≤ 200 characters) so the editor can jump to it, name the issue number it
appears in, name what kind of darling it is in the `location` (e.g.
`Issue 3 — showpiece description`, `Issue 5 — digression`), explain why the story
is better without it, and suggest the cut or a leaner replacement.

Be specific and cite the text. Favor a few high-confidence cuts over many
uncertain ones. If nothing is precious, return an empty `findings` array — do not
invent problems.

## Output contract

Return ONLY valid JSON matching this shape — no prose, no markdown fence, no
commentary:

```json
{
  "findings": [
    {
      "severity": "high|medium|low",
      "issueNumber": 3,
      "location": "string — the darling kind + where (e.g. 'Issue 3 — showpiece description')",
      "problem": "1–3 sentences naming the darling and why the story is better without it",
      "suggestion": "1–3 sentences proposing the cut or a leaner replacement",
      "anchorQuote": "short verbatim quote from the manuscript (≤ 200 chars)"
    }
  ]
}
```
