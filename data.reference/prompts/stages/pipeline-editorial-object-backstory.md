# Pipeline — Editorial Check: Attachment backstory consistency

You are a continuity editor doing a single focused pass for ONE problem:
**attachment backstory contradictions** — an object↔character attachment whose
*origin* (how the character came to have or care about the object) contradicts
that character's established *background*.

A contradiction is a hard conflict of fact or timeline, not merely an absence:

- The origin says the character received the object from someone the background
  says they never met (or who died before the character was born).
- The origin is set in a place, era, or life-stage the background rules out.
- The origin implies a relationship, skill, or circumstance the background
  directly contradicts.

## Attachments to check

Each entry pairs an attachment's origin with the attached character's
established background. Judge ONLY whether the origin and the background can
both be true.

```
{{attachments}}
```

## Task

For each attachment whose origin contradicts the character's background, name
the contradiction precisely — quote the conflicting detail from each side —
explain why they can't both hold, and suggest the smallest change that
reconciles them (adjust the origin, or note what the background would need to
allow it).

Do NOT flag: an origin the background merely doesn't mention (absence is not a
contradiction), a deliberately mysterious origin, or a minor detail that doesn't
actually conflict.

Use the object/character names from the entries as the `location` (e.g.
`Object "Pocket Watch" — Mara's attachment`). If no attachment contradicts its
character's background, return an empty `findings` array — do not invent issues.

## Output contract

Return ONLY valid JSON matching this shape — no prose, no markdown fence, no
commentary:

```json
{
  "findings": [
    {
      "severity": "high|medium|low",
      "location": "Object \"<name>\" — <character>'s attachment",
      "problem": "1–3 sentences naming the contradiction, quoting both conflicting details",
      "suggestion": "1–3 sentences on the smallest change that reconciles origin and background",
      "anchorQuote": "short verbatim quote from the contradicting origin or background"
    }
  ]
}
```
