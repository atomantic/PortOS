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

{{#characterEvolution}}
## Authored character evolution (five-stage lens)

The author has recorded an OPTIONAL five-stage lens for the characters below. It
states the causal chain the story runs a character through:

**tested control belief → external pressure → the choice → the cost paid → the
final behavioral proof**

- *control strategy failing* — the belief the character controls their world
  with, and the first sign it no longer works.
- *pressure forces exploration* — the external pressure that makes the old
  strategy unusable and forces them to look for another way.
- *commitment to change* — the choice they actually make.
- *cost tested* — what that choice costs them, and whether they can bear it.
- *final proof* — the closing BEHAVIOR that proves the change (or the refusal).

The `declared outcome` is authored intent. It changes your verdict; it never
suppresses this check:

- `full-change` — the change must endure and be proven by behavior. A payoff won
  only by defeating an external obstacle, with no behavioral proof on the page,
  IS a finding.
- `tragic-refusal` — doubling down on the control belief is the INTENDED ending.
  Do not flag it as a flat or failed arc. The finding here is the opposite: a
  refusal that was never genuinely tested — no real pressure, no cost paid — so
  the character never had a change to refuse.
- `flat-testing` — the belief is tested and deliberately HOLDS; the character
  changes the world around them instead of themselves. Constancy is the point:
  do not flag it as a flat arc.
- `partial-open` — partial change, or an ending left genuinely open, is a
  legitimate literary ending. Incompleteness itself is NOT a finding; an
  UNEARNED CLAIM OF COMPLETION is — prose asserting the character is transformed
  when the stages were never paid off.
- `undeclared` — the author has not yet said how the arc lands. Treat the stages
  as provisional planning, not as intent to hold the prose to.

Evidence: a stage annotated `[stale]` points at a beat that no longer exists and
`[unverified]` could not be resolved. Neither is proof. Missing or unresolved
evidence means NOT PROVEN — never read it as passing.

Two failure modes need DIFFERENT repairs — never merge them into one finding:

- **no authored intent** — the character has no lens stage for a change the prose
  shows or plainly needs. Begin `problem` with `No authored intent:` and make
  `suggestion` name the stage to author.
- **authored intent not delivered** — a stage IS authored but the page never
  delivers it. Begin `problem` with `Authored intent not delivered:` and make
  `suggestion` name the concrete scene or plan beat that would land that stage.

This is a craft lens over the authored beats — NOT a page count, a chapter count,
or a percentage layout. Do not require five chapters, fixed positions, a stage
per issue, or a changed belief that is the literal opposite of the tested one. A
character with no lens is judged exactly as they were before.

**For this check:** a recurring secondary whose declared outcome is
`flat-testing` or `tragic-refusal` must NOT be reported as a flat arc — the
author declared that ending. Judge them instead on whether the belief was
actually put under pressure, and flag a declared refusal that was never tested.

```
{{characterEvolution}}
```
{{/characterEvolution}}

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
