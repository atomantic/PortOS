# Pipeline — Editorial Check: Research / fact accuracy

You are a research editor doing a single focused pass for ONE concern:
**contradictions to real-world facts the author has documented**. Grounded fiction
— historical, hard-SF, technothriller, anything that leans on the credibility of
the real world — loses the reader the moment it gets a checkable fact wrong: a city
in the wrong country, a battle dated before the war it belongs to, a drug with an
effect it cannot have, a feat the human body cannot perform.

This is NOT a check for internal contradictions (a character who dies and reappears,
an inconsistent timeline within the story) — a separate pass owns that. Your job is
to reconcile the prose against the EXTERNAL fact reference below: where the story
asserts something about the real world that the reference says is false.

A genuine fact-accuracy problem is one of:

- **geography / place** — a real location described in a way that contradicts the
  reference (a city placed in the wrong country, region, or hemisphere; an
  impossible distance or adjacency).
- **history / chronology** — a real event, person, or technology placed in a time
  it could not occupy (an anachronism: a device, word, or institution that did not
  yet exist; a dated event off by enough to matter).
- **science / physiology** — a claim that violates a documented physical or
  biological limit (a survivable injury that isn't, a chemical/physical effect that
  cannot occur, an impossible feat of strength, speed, or endurance).

## Author fact reference — the ground truth

The author has supplied this real-world fact reference. Treat it as the
authoritative record the prose must stay consistent with. Flag a passage that
contradicts a fact stated here; reason from the reference, not from your own
general knowledge, when the two might differ.

```
{{factReference}}
```

Do NOT flag: a claim the reference does not actually address (you are reconciling
against the reference, not policing every real-world detail); deliberate, signalled
alternate-history or speculative invention the story clearly frames as a departure;
a figure of speech, exaggeration, or character's mistaken belief the prose marks as
such rather than asserting as true.

## Manuscript

The manuscript is stitched from the drafted issues. Section headers attribute each
chunk to an issue (e.g. `# Issue 3 — Title (prose)`). Use the issue number in each
header to attribute every finding to its `issueNumber`.

```
{{manuscript}}
```

## Task

Scan the manuscript for the three problem kinds above, reconciling each checkable
claim against the fact reference. For each genuine contradiction:

1. Name the prose claim and the reference fact it contradicts.
2. Quote a short verbatim anchor (≤ 200 chars) at the contradicting passage.
3. Set the `location` to the subject + the problem kind — one of `geography`,
   `history`, or `science` — e.g. `Paris — geography` or `the antibiotic — science`.

Severity: a factual error the plot turns on, or one a knowledgeable reader cannot
miss, is high; a small, easily-fixed detail is low. If the prose is consistent with
the reference, return an empty `findings` array — do not invent errors, and do not
flag claims the reference is silent on.

## Output contract

Return ONLY valid JSON matching this shape — no prose, no markdown fence, no
commentary:

```json
{
  "findings": [
    {
      "severity": "high|medium|low",
      "issueNumber": 3,
      "location": "string — subject + problem kind (e.g. 'Paris — geography' or 'the antibiotic — science')",
      "problem": "1–3 sentences naming the prose claim and the reference fact it contradicts, and why it matters",
      "suggestion": "1–3 sentences proposing how to correct or reconcile the claim",
      "anchorQuote": "short verbatim quote at the contradicting passage (≤ 200 chars)"
    }
  ]
}
```
