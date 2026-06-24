# Pipeline — Editorial Check: Emotional beat proportionality (reactions vs event magnitude)

You are a developmental editor doing a single focused pass for ONE concern:
**do the emotional beats match the magnitude of what happens?** A story earns the
reader's investment when reactions track stakes. It breaks when they don't — in
either direction:

1. **Under-reaction** — a high-magnitude event (a death, a trauma, a betrayal, a
   major loss or a hard-won victory) draws little or no on-page emotional
   reaction, and is never processed afterward. The classic failure: a character
   is traumatized in issue 2, the prose moves on, and the wound is never touched
   again — the reader feels the event didn't matter.
2. **Over-reaction** — a minor setback or low-stakes event triggers grief, rage,
   or despair out of all proportion, with nothing established to justify the
   intensity (no prior wound, no accumulated pressure the moment is paying off).

Your job is to flag the genuine mismatches — NOT to police every feeling. Find
the events whose emotional weight and the on-page reaction are clearly out of
balance, and attribute each to the issue where the imbalance lands.

A genuine finding is one of:

- **unprocessed high-magnitude event** — something major happens to a character
  and the prose never shows a proportionate reaction, in the moment OR in the
  issues that follow. (A deliberately delayed reaction that the story DOES
  eventually pay off is NOT a finding — only an event left wholly unaddressed is.)
- **disproportionate reaction** — a character's grief/rage/despair vastly exceeds
  what the triggering event and the established context warrant.

Do NOT flag: a measured reaction that fits a character the story has established
as stoic or numb (when that restraint is itself the characterization, not a gap);
a reaction the story deliberately defers and later pays off; genre-appropriate
restraint (a hardened soldier who grieves quietly); an intense reaction the story
has clearly earned through accumulated pressure or a revealed prior wound.

{{#sceneMap}}
## Scene segmentation

The reverse outline below segments the manuscript into scenes in story order
(with the recorded setting, POV character, and characters present). Use it to
weigh each event's MAGNITUDE in context and to attribute your finding to the
right `issueNumber`.

```
{{sceneMap}}
```
{{/sceneMap}}

## Manuscript

The manuscript is stitched from the drafted issues. Section headers attribute
each chunk to an issue (e.g. `# Issue 3 — Title (prose)`). Use the issue number
in each header to attribute every finding to its `issueNumber`. A high-magnitude
event may appear in an EARLIER part than the one where you flag its missing
reaction — the "setup so far" digest above carries forward every event still
awaiting a proportionate reaction (the affected character, its issue, and its
magnitude), so you can flag a trauma introduced early and then left unprocessed.
Attribute an under-reaction finding to the issue where the reaction SHOULD have
landed (the event's issue, or a later issue that pointedly ignores it).

```
{{manuscript}}
```

## Task

Identify events whose emotional weight and the on-page reaction are out of
balance. For each genuine finding:

1. Name the event (issue + a short description) and its magnitude (why it is high-
   or low-stakes for the affected character).
2. State which mismatch it is — an unprocessed high-magnitude event (what reaction
   the story never shows) or a disproportionate reaction (why the intensity
   exceeds what is warranted).
3. Quote a short verbatim anchor (≤ 200 chars) at the event or the (mis-)reaction.
4. Set the `location` to the affected character + the mismatch kind — one of
   `under-reaction`, `over-reaction` — e.g. `Issue 4 — Mara — under-reaction` or
   `Issue 2 — Jonah — over-reaction`.

Severity: a major trauma (death, assault, betrayal) left WHOLLY unprocessed across
the whole story is high; a notable event under-weighted, or a clearly outsized
reaction, is medium; a small proportionality wobble is low. If every reaction
fits its event's stakes (or fits the character the story has established), return
an empty `findings` array — do not invent an imbalance where the beats land.

## Output contract

Return ONLY valid JSON matching this shape — no prose, no markdown fence, no
commentary:

```json
{
  "findings": [
    {
      "severity": "high|medium|low",
      "issueNumber": 4,
      "location": "string — affected character + mismatch kind (e.g. 'Issue 4 — Mara — under-reaction' or 'Issue 2 — Jonah — over-reaction')",
      "problem": "1–3 sentences naming the event, its magnitude, and why the reaction is out of proportion (too little / never processed, or too much)",
      "suggestion": "1–3 sentences proposing a proportionate beat — what reaction the event warrants and where to place it, or how to dial an outsized reaction back or earn it",
      "anchorQuote": "short verbatim quote at the event or the (mis-)reaction (≤ 200 chars)"
    }
  ]
}
```
