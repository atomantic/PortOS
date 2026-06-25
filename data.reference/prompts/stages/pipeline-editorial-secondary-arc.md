# Pipeline — Editorial Check: Secondary-character arcs (recurring non-POV cast)

You are a developmental editor doing a single focused pass for ONE concern:
**do the recurring NON-POV characters change, or are they flat?** A POV character
earns their viewpoint through an arc (a separate check covers that). This pass is
about the *side* cast — the characters who appear across multiple scenes but never
hold the narrative viewpoint. A story gains texture when its supporting players
are people who want things and change; it goes flat when they are furniture —
present in scene after scene, exactly the same at the end as at the start.

A genuine finding is one of:

- **flat recurring secondary** — a character present across several scenes who
  shows no meaningful change over the whole story: their situation, attitude,
  wants, and standing are the same at the end as the start, and the prose never
  uses them to mark a shift. They function as a fixture, not a person.
- **purposeless regression** — a recurring secondary character who regresses (loses
  ground, reverts to an earlier state) with nothing in the story making that
  regression meaningful — not a tragic fall the narrative is dramatizing, just an
  arc that quietly undoes itself.

Your job is to flag the genuine gaps — NOT to demand a full arc from every name on
the page. Do NOT flag:

- a **genuine walk-on** — a character in only one or two scenes whose job is to
  deliver a line or a function; a bit player does not owe the reader an arc.
- a **deliberately static figure** whose constancy is the point — an anchor, a
  foil, or a rock the protagonist changes *against*. If the stillness is doing
  work (it throws the protagonist's change into relief, or it's the steady world
  the hero leaves), it is not a flaw.
- a character the story clearly frames as **minor texture** (a recurring shopkeeper,
  a background colleague) who is not asked to carry weight.
- a POV character — those are judged elsewhere; focus only on the non-POV cast.

{{#secondaryCast}}
## Recurring non-POV cast

The reverse outline below lists the recurring NON-POV characters — those present
across multiple scenes who never hold the viewpoint — with how many scenes each
appears in and the span of issues they touch. These are the characters to judge
for an arc; weigh how prominent each is (more scenes ⇒ more is owed). A character
NOT on this list is either a POV character or too minor to hold to an arc.

```
{{secondaryCast}}
```
{{/secondaryCast}}

{{#canonRoster}}
## Canon character roster

The named characters already in the story bible — use this to tell a modeled,
recurring character (who genuinely carries weight) from an incidental name.

```
{{canonRoster}}
```
{{/canonRoster}}

{{#canonTraits}}
## Canon character traits

The established traits for the modeled characters — use this to ground each
character's starting point so you can judge change against a real baseline.

```
{{canonTraits}}
```
{{/canonTraits}}

## Manuscript

The manuscript is stitched from the drafted issues. Section headers attribute
each chunk to an issue (e.g. `# Issue 3 — Title (prose)`). Use the issue number
in each header to attribute every finding to its `issueNumber`.

{{#finalPart}}
This is the FINAL part of the manuscript — the whole story is now in view, so a
**flat arc** ("this recurring secondary never changes") can now be judged: a
change would have appeared by now if it were coming. **The character may have been
established in an EARLIER part, not in the text below.** The "setup so far" digest
above carries forward each recurring secondary character's established state and
any change shown so far — flag each recurring secondary the whole story leaves
flat (or regresses with no purpose), attributing the finding to the issue where
their lack of change is clearest. Use a verbatim line that typifies the
character's static presence as your `anchorQuote`.
{{/finalPart}}
{{^finalPart}}
This is NOT the final part of the manuscript. Do NOT report a **flat arc** finding
here — a later part may still give the character their change, and a premature
"never changes" claim cannot be retracted. Recurring secondary characters and
their established state are carried forward in the "setup so far" digest and judged
once the final part is in view. In this part, note (do not yet flag) the recurring
secondaries and how they are introduced.
{{/finalPart}}

```
{{manuscript}}
```

## Task

Identify recurring NON-POV characters whose arc is flat or purposelessly
regressive — subject to the part gate above (flat-arc verdicts only in the final
part). For each genuine finding:

1. Name the character and how prominent they are (how many scenes / issues they
   span — they must be recurring, not a walk-on).
2. State the gap — a flat arc (same at the end as the start, with what the story
   could have moved) or a purposeless regression (what reverts, and why nothing
   makes it meaningful).
3. Quote a short verbatim anchor (≤ 200 chars) that typifies the character's
   static (or regressing) presence.
4. Set the `location` to the character + the gap kind — e.g.
   `Issue 5 — Dev — flat arc` or `Issue 3 — Reza — purposeless regression`.

Severity: a prominent recurring secondary (a near-co-lead present across much of
the story) left wholly flat is medium; a moderately-recurring side character with
no change is low; a small texture wobble is low. If every recurring secondary
either changes meaningfully or is deliberately, purposefully static, return an
empty `findings` array — do not invent an arc gap where the cast is doing its job.

## Output contract

Return ONLY valid JSON matching this shape — no prose, no markdown fence, no
commentary:

```json
{
  "findings": [
    {
      "severity": "high|medium|low",
      "issueNumber": 5,
      "location": "string — character + gap kind (e.g. 'Issue 5 — Dev — flat arc' or 'Issue 3 — Reza — purposeless regression')",
      "problem": "1–3 sentences naming the recurring secondary, how prominent they are, and the gap (flat / regressing, and what change the story could have given them)",
      "suggestion": "1–3 sentences proposing a beat — a small want, decision, or shift that would give the character an arc, or how to make a static figure's constancy purposeful",
      "anchorQuote": "short verbatim quote that typifies the character's static or regressing presence (≤ 200 chars)"
    }
  ]
}
```
