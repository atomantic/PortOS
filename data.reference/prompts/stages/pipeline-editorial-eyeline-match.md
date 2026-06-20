# Pipeline — Editorial Check: Storyboard eyeline match

You are a continuity editor doing a single focused pass over a comic/film
storyboard for ONE problem: **eyeline-match breaks** within a scene.

An eyeline match is the rule that when the camera cuts between two characters in
the same exchange, their gaze directions must RECIPROCATE — if character A looks
screen-right at B, then B (filmed in the answering shot) should look screen-left
back at A. When both look the same way, the audience loses the sense of who is
looking at whom across the cut.

**Read gaze from the free-text shot DESCRIPTION, not from the bracketed `screen
direction` tag.** That tag records the side the subject *faces or moves* — which
is NOT always where they look (a character can walk screen-left while looking
back screen-right). Use the tag only as a weak corroborating hint; the
description is the authority for where a character's eyes are directed.

Flag ONLY these eyeline problems:

- **Non-reciprocating gaze across a conversation cut.** Two characters talking to
  (or looking at) each other across consecutive/continuity-linked shots whose
  described gaze directions are the SAME (both screen-left, or both screen-right)
  instead of opposite — so they appear to look past each other, not at each other.
- **Gaze clearly contradicts the screen direction.** A shot whose description
  states the character LOOKS one way while the recorded screen direction is the
  opposite AND nothing in the description explains the split (e.g. it isn't a
  deliberate "walks left, glances back right") — only then are the two signals in
  genuine conflict.
- **A reverse-angle that doesn't flip the eyeline.** A clear shot/reverse-shot
  pair (the answering angle on the second character) where the second character's
  gaze isn't mirrored, so the cut reads as both facing the same off-screen point.

## Shots to check

Each scene lists its shots in order. A shot line carries its id, its framing and
tagged screen direction in brackets, an optional "continues from" continuity
link, and the free-text description (the authority for where the eyes look):

```
{{shots}}
```

## Task

For each eyeline-match break, name the offending shot pair by id, quote the gaze
detail from each side, explain why the eyelines don't reciprocate, and suggest
the smallest fix (flip one shot's screen direction, or re-describe the gaze).

Use the scene/issue label and the two shot ids as the `location` (e.g.
`Issue 4 — INT. KITCHEN: shots shot-02 ↔ shot-03`). Set `issueNumber` to the
issue number shown in that scene's header when present (omit it otherwise).

Do NOT flag: a single character alone in frame (no one to match eyelines with),
a deliberate look-away or off-screen glance the description makes clear, a shot
with no gaze described, or framing/shot-type variety (a different check covers
that). Absence of a stated eyeline is NOT a break — only a genuine contradiction
or non-reciprocating pair is. If nothing breaks eyeline continuity, return an
empty `findings` array — do not invent issues.

## Output contract

Return ONLY valid JSON matching this shape — no prose, no markdown fence, no
commentary:

```json
{
  "findings": [
    {
      "severity": "high|medium|low",
      "issueNumber": 4,
      "location": "Issue <n> — <scene>: shots <idA> ↔ <idB>",
      "problem": "1–3 sentences naming the eyeline break, quoting the gaze detail from each shot",
      "suggestion": "1–3 sentences on the smallest fix (flip a screen direction or re-describe the gaze)",
      "anchorQuote": "short verbatim quote from one of the conflicting shot descriptions"
    }
  ]
}
```
