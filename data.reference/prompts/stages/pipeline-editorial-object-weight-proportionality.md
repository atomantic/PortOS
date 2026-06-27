# Pipeline — Editorial Check: Object narrative-weight proportionality

You are a developmental editor doing a single focused pass for ONE problem:
**object weight-proportionality** — an object whose narrative weight (the depth
of backstory, lineage, and payoff the story invests in it) is out of proportion
to its prominence (how much the plot actually leans on it). The failure runs in
both directions:

- **Over-weighted** — a minor object the prose barely uses is handed a
  disproportionate backstory or significance: a one-line locket given a
  three-issue origin, a throwaway prop with a reverent history nothing pays off.
  The machinery is heavier than the moment it serves, so the setup feels like
  wasted load-bearing weight.
- **Under-established** — a prominent or decisive object carries little or no
  established lineage to earn its weight: an heirloom that resolves the finale
  but was never set up, a "legendary" relic the story treats as climactic
  without ever planting why it matters. The payoff outruns its setup, so the
  beat lands unearned.

Judge the *proportion* between weight and prominence — not the absolute amount of
either. A richly backstoried object that genuinely drives the plot is healthy; so
is a minor object with a light touch of significance. The problem is the
mismatch: heavy setup spent on a trivial object, or a pivotal object resting on
no setup at all.

## Established objects (canon)

These are the objects the canon records, with the prose significance and each
character attachment already on file — for every attachment, the emotion, its
significance, the **origin** (how that character came to have the object — its
recorded lineage/backstory), and a role archetype. Treat this as the *recorded*
weight an object carries going in; weigh it together with what the prose itself
plants and pays off. An object with deep canon significance, a rich origin, and
attachments but almost no presence in the manuscript is a candidate for
over-weighting; a manuscript-pivotal object with thin canon significance and no
on-page or recorded lineage is a candidate for under-establishment.

```
{{objects}}
```

## Manuscript

The manuscript is stitched from the drafted issues. Each section begins with a
header like `# Issue 3 — Title (prose)`; use the issue number in that header to
attribute each finding to its `issueNumber`.

{{#finalPart}}
You are seeing the FINAL part of the manuscript, so the whole story is now in
view and you may judge each object's overall weight against its overall
prominence. The "setup so far" digest above carries each object's established
backstory/significance, how prominent it has been, the issue(s) it appears in,
and a short verbatim snippet of its most weight-bearing moment — so an object
that pays off here can be weighed against lineage planted pages earlier, and an
object whose backstory loaded up early can be judged against how little (or much)
the whole story actually used it. When the object that is out of proportion
appears only in an EARLIER part (its text is no longer in the part below),
attribute the finding to the carried-forward issue number and use the
carried-forward snippet as your `anchorQuote` — do not drop a real imbalance just
because its evidence sits pages earlier.
{{/finalPart}}
{{^finalPart}}
You are seeing an EARLIER part of a long manuscript reviewed in pieces. Do NOT
yet flag an over- or under-weighted object — a later part may pay off an object
that looks over-weighted now, or establish lineage for one that looks
under-established. Note each object's prominence and the backstory/significance
established so far (the "setup so far" digest carries this forward) but reserve
every weight-proportionality verdict for the final part, and return an empty
`findings` array for this part.
{{/finalPart}}

```
{{manuscript}}
```

## Task

Find the objects whose narrative weight and prominence are out of proportion. For
each, quote a short verbatim anchor from the text (≤ 200 characters), name the
issue number it appears in, classify the imbalance in the `location` (e.g.
`Issue 2 — over-weighted backstory`, `Issue 7 — under-established payoff`),
explain why the weight and prominence don't match, and suggest a concrete fix —
trim or cut the disproportionate setup, or plant the missing lineage earlier so a
pivotal object earns its moment. Set severity by how much the mismatch distorts
the story: a climactic object resting on no setup is more serious than a minor
prop with a slightly heavy backstory.

Do NOT flag: an object whose weight matches its role (well set up and genuinely
pivotal, or minor with a light touch); a deliberate red herring or
slow-burn mystery the story is actively and intentionally building toward; or an
object whose lineage is established off-page in canon and only lightly echoed in
prose by design.

Be specific and cite the text. If every object's weight is proportionate to its
prominence, return an empty `findings` array — do not invent issues.

## Output contract

Return ONLY valid JSON matching this shape — no prose, no markdown fence, no
commentary:

```json
{
  "findings": [
    {
      "severity": "high|medium|low",
      "issueNumber": 3,
      "location": "string — the imbalance + where (e.g. 'Issue 2 — over-weighted backstory')",
      "problem": "1–3 sentences naming the object and why its weight and prominence are out of proportion",
      "suggestion": "1–3 sentences proposing how to rebalance (trim the setup, or plant the missing lineage)",
      "anchorQuote": "short verbatim quote from the manuscript (≤ 200 chars)"
    }
  ]
}
```
