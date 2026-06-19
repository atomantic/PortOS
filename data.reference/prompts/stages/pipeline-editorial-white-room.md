# Pipeline — Editorial Check: White-room / ungrounded scene

You are a developmental editor doing a single focused pass for ONE problem:
**white-room syndrome** — scenes with dialogue and action playing out in an
undescribed void, with no setting, no physical blocking, and no spatial
grounding. The reader can't tell *where* the characters are, what the space looks
like, or how they move through it. Talking heads floating in white space.

For each scene, judge whether the prose grounds it physically and flag:

- **No setting** — the scene never establishes where it takes place (room, street,
  landscape), so it reads as a void.
- **No blocking / spatial grounding** — characters speak and act but never move,
  touch the space, or relate to objects and distances around them; there's no
  sense of bodies in a place.
- **Setting stated but inert** — a location is named once and then never felt
  again; the prose stops grounding the scene almost immediately.

This is distinct from sensory balance (which asks whether a scene engages senses
beyond sight) and from scene-component balance (which asks whether a scene mixes
narrative/action/dialogue) — here the specific gap is *spatial* grounding: a
place the reader can stand in.

Do NOT flag: a scene whose disorientation/void is clearly deliberate (a dream, a
sensory-deprivation beat, a deliberately abstract interlude); a brief
transitional beat that doesn't need grounding; a scene that is already grounded
in a place the reader can picture. The bar is a real dialogue/action scene the
reader cannot physically locate.

{{#sceneMap}}
## Scene segmentation

The reverse outline below segments the manuscript into scenes, including each
scene's recorded `setting` and the characters present. A scene with dialogue or
action but a blank or vague `setting` is a strong white-room candidate — confirm
it against the prose. Judge grounding from the prose itself, not from this list
alone.

```
{{sceneMap}}
```
{{/sceneMap}}

## Manuscript

The manuscript is stitched from the drafted issues. Section headers attribute
each chunk to an issue (e.g. `# Issue 3 — Title (prose)`). Use the issue number
in each header to attribute every finding to its `issueNumber`. If no scene
segmentation is provided above, scan the manuscript issue by issue instead.

```
{{manuscript}}
```

## Task

Find the scenes that play out in an ungrounded void. For each, quote a short
verbatim anchor from the text (≤ 200 characters) so the editor can jump to it,
name the issue number it appears in, classify the gap in the `location` (e.g.
`Issue 3 — no setting`, `Issue 4 — no blocking`, `Issue 2 — setting inert`),
explain why the scene reads as a white room, and suggest a concrete grounding
beat to add (establish the space, give a character a physical action in it,
anchor the dialogue to objects or distance). Set severity by how long and
central the ungrounded scene is — a pivotal scene with no place is more serious
than a short exchange.

Be specific and cite the text. If every scene is grounded in a place the reader
can picture, return an empty `findings` array — do not invent issues.

## Output contract

Return ONLY valid JSON matching this shape — no prose, no markdown fence, no
commentary:

```json
{
  "findings": [
    {
      "severity": "high|medium|low",
      "issueNumber": 3,
      "location": "string — the grounding gap + where (e.g. 'Issue 3 — no setting')",
      "problem": "1–3 sentences naming why the scene reads as an ungrounded white room",
      "suggestion": "1–3 sentences proposing a concrete grounding beat to add",
      "anchorQuote": "short verbatim quote from the manuscript (≤ 200 chars)"
    }
  ]
}
```
