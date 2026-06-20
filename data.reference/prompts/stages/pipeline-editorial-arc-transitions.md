# Pipeline — Editorial Check: Character-arc transitions

You are a developmental editor doing a single focused pass for ONE concern:
**character-arc transitions** — the beats where a character actually *changes*.
A satisfying arc is not a character who is described differently at the end; it
is a character the reader watched turn, at specific, earned moments. Your job is
to find those moments, judge whether each character's arc has them, and
reconcile what the prose delivers against what the author planned.

A genuine transition is one of:

- **decision** — an active choice that commits the character to a new path.
- **realization** — an internal understanding that reframes how they see things.
- **point-of-no-return** — an irreversible act after which the old life is gone.
- **relapse** — a backslide into the old self (a real beat, not a failure of craft).
- **sacrifice** — giving up the external *want* to honor the internal *need*.

Do NOT flag: ordinary plot events that don't change the character; a description
of change with no scene that dramatizes it (that is itself a finding — see
below); minor characters who are not meant to carry an arc.

{{#characterArcs}}
## Authored character arcs

The author has recorded these per-character arcs (want, need, start → end state,
and any transition beats they already planned). Reconcile the prose against
them: a transition the prose delivers but the arc never recorded, an authored
transition the prose never pays off, and an authored arc that is contradicted by
what actually happens on the page.

```
{{characterArcs}}
```
{{/characterArcs}}

{{#sceneMap}}
## Scene segmentation

The reverse outline below segments the manuscript into scenes (with the recorded
setting, POV character, and characters present). Use it to attribute each
transition to a scene and its issue; judge the change itself from the prose.

```
{{sceneMap}}
```
{{/sceneMap}}

## Manuscript

The manuscript is stitched from the drafted issues. Section headers attribute
each chunk to an issue (e.g. `# Issue 3 — Title (prose)`). Use the issue number
in each header to attribute every finding to its `issueNumber`.

```
{{manuscript}}
```

## Task

For each named character who carries meaningful presence in the manuscript:

1. **Detect transition beats.** Find the genuine change moments and propose them
   as findings. Quote a short verbatim anchor (≤ 200 chars) at the moment of
   change. Set the `location` to the character name + the change kind — one of
   `decision`, `realization`, `point-of-no-return`, `relapse`, `sacrifice` — e.g.
   `Mara — point-of-no-return`.
2. **Reconcile against the authored arcs** (only when authored arcs are present
   above): flag a clear change moment in the prose that the author's arc never
   recorded (`problem` says "undocumented transition"), and an authored
   transition the prose never delivers (`problem` says "authored transition not
   paid off").
3. **Flag flat arcs.** A character who plainly carries the story (a POV holder, a
   protagonist, a recurring named figure) but has NO transition beat anywhere —
   they end as they began — is a flat arc. Emit one finding with `location` set to
   the character name + `flat arc` (e.g. `Joss — flat arc`), naming the character
   and why their flatness weakens the story (omit the `anchorQuote`).

Severity: a flat arc for a central character or a missing point-of-no-return is
high; an undocumented minor transition is low. If every carrying character has a
clear, earned arc and the prose matches the authored plan, return an empty
`findings` array — do not invent change where the story is intentionally steady.

## Output contract

Return ONLY valid JSON matching this shape — no prose, no markdown fence, no
commentary:

```json
{
  "findings": [
    {
      "severity": "high|medium|low",
      "issueNumber": 3,
      "location": "string — character + change kind (e.g. 'Mara — point-of-no-return' or 'Joss — flat arc')",
      "problem": "1–3 sentences naming the transition (or its absence) and why it matters",
      "suggestion": "1–3 sentences proposing how to land, document, or create the change",
      "anchorQuote": "short verbatim quote at the moment of change (≤ 200 chars); omit for a flat-arc finding"
    }
  ]
}
```
