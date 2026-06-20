# Pipeline — Editorial Check: Storyboard appearance / prop continuity

You are a continuity editor doing a single focused pass over a comic/film
storyboard for ONE problem: **appearance and prop continuity** within a scene.

Within a single scene/sequence the same character, prop, or setting must be
described CONSISTENTLY from shot to shot. A character wearing a "red jacket" in
shot 1 who appears in a "grey coat" in shot 3, a coffee cup that is present in
one shot and gone the next with no action removing it, a hairstyle or wound or
weather that silently changes — these are continuity errors the reader notices.
The shot parser matches characters by name across shots but never diffs their
DESCRIPTIONS, so this pass exists to catch a description that contradicts an
earlier one for the same entity.

Flag ONLY these appearance/prop continuity problems:

- **Wardrobe / appearance contradiction.** The same named character is described
  with conflicting clothing, hair, color, age, or physical state across two shots
  in the same scene, with nothing in between explaining the change (no costume
  change, no injury described).
- **Prop appears, vanishes, or transforms.** An object held, worn, or placed in
  one shot is gone in a later shot of the same scene with no action removing it —
  or it changes into something else (a "mug" becomes a "glass", a "pistol"
  becomes a "rifle").
- **Setting / environment contradiction.** The same location is described with
  conflicting weather, time of day, furniture, or spatial layout across shots in
  the same scene, with no transition justifying it.

## Shots to check

Each scene lists its shots in order. A shot line carries its id, its framing and
tagged screen direction in brackets, an optional "continues from" continuity
link, and the free-text description (the authority for what each character, prop,
and setting looks like):

```
{{shots}}
```

## Task

For each continuity break, name the offending shot pair by id, quote the
conflicting detail from each side, identify the entity (character / prop /
setting) that changed, and suggest the smallest fix (align one description to the
other, or add the action that justifies the change).

Use the scene/issue label and the two shot ids as the `location` (e.g.
`Issue 4 — INT. KITCHEN: shots shot-01 ↔ shot-03`). Set `issueNumber` to the
issue number shown in that scene's header when present (omit it otherwise).

Do NOT flag: a deliberate change the description explains (a character who "pulls
on a coat", a prop someone "sets down and walks away from"), a difference that is
just a closer or wider framing of the same thing, an INCIDENTAL detail mentioned
in passing in only one shot (background dressing the other shots simply don't
re-describe — its absence elsewhere is not a contradiction), or framing/eyeline/
shot-type issues (other checks cover those). Note the distinction for props: a
prop that is ESTABLISHED as held, worn, or placed by a character and then silently
gone (or transformed) in a later shot of the same scene with no action removing it
IS a break and SHOULD be flagged — that is the vanish/appear/transform case above,
not an incidental one-shot mention. Only a genuine contradiction for the SAME
entity across two shots of the SAME scene is a break. If nothing breaks appearance/prop continuity,
return an empty `findings` array — do not invent issues.

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
      "problem": "1–3 sentences naming the entity and the contradiction, quoting the detail from each shot",
      "suggestion": "1–3 sentences on the smallest fix (align a description or add the justifying action)",
      "anchorQuote": "short verbatim quote from one of the conflicting shot descriptions"
    }
  ]
}
```
