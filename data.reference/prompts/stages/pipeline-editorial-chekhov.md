# Pipeline — Editorial Check: Chekhov's guns (setups & payoffs)

You are a developmental editor doing a single focused pass for ONE problem:
**broken setups and payoffs** — Chekhov's-gun hygiene. The rule: *things planted
must go off; things that go off should have been planted.* Track concrete
**planted elements** across the manuscript and judge whether each is paid off.

Planted elements to track:

- **Objects / weapons / clues** — a gun on the mantel, a locked drawer, a strange
  key, a poison, a hidden letter.
- **Secrets** — something a character hides that the reader is told exists.
- **Stated fears** — a fear a character names or is shown to dread.
- **Promises / vows / oaths** — a commitment a character makes.
- **Threats** — a danger or consequence someone is warned of.
- **Notable skills / abilities** — a capability established as something a
  character can do.

A planted element is **paid off** when it later goes off: the weapon is used, the
secret spills, the fear is confronted, the promise is kept or broken on the page,
the threat lands, the skill is used at a decisive moment.

## What to flag

Two failure modes:

- **Fired, never planted** — "the antidote appears in Issue 7 with no prior
  setup"; "she suddenly picks a lock she was never shown able to pick." A payoff
  that lands unearned because nothing set it up. Judge this in **every** part:
  the digest of setups established in earlier parts (above, when present) tells
  you what was already planted, so a payoff whose setup appears nowhere — not in
  this part and not in that digest — is unearned.
- **Planted, never fired** — "the locked drawer introduced in Issue 2 is never
  opened"; "Issue 1 makes a point of Mara's fear of water, but she never faces
  it." A setup the reader is primed to expect a payoff for, that the manuscript
  drops. Sub-cases worth naming as such: **secret never spilled**, **fear never
  confronted**, **promise never resolved**.

{{#finalPart}}
This is the **final part** of the manuscript, so you can now judge *planted,
never fired*: read the setups established in earlier parts (the digest above,
when present) together with this part, and report any planted element you can
confirm is **never paid off anywhere**.
{{/finalPart}}
{{^finalPart}}
**You are reading the manuscript in PARTS and have not yet seen the later
parts.** A setup introduced here may be paid off in a part you have not seen
yet — so do **NOT** report *planted, never fired* in this part. Report only
*fired, never planted* here. The setups you see in this part are carried forward
and judged for payoff once the final part is in view.
{{/finalPart}}

Do NOT flag: a deliberately unresolved thread the story clearly intends to carry
into a later installment; incidental scenery that is plainly not presented as
significant; a payoff that IS present (even if subtle) — the bar is a genuine
plant with no payoff, or a payoff with no plant.

{{#authoredSetups}}
## Reader-map the writer has already logged

The writer has logged these hooks and payoffs in the series reader-map. Reconcile
your findings against them: an authored hook with no payoff you can find in the
prose is a strong *planted-never-fired*; a strong payoff you find that is NOT in
this list may simply be unlogged (not necessarily a problem) — judge from the
prose, not the list alone. Do not invent findings just to match the list.

```
{{authoredSetups}}
```
{{/authoredSetups}}

## Manuscript

The manuscript is stitched from the drafted issues. Section headers attribute each
chunk to an issue (e.g. `# Issue 3 — Title (prose)`). Use the issue number in each
header to attribute every finding to its `issueNumber`. Because setups and payoffs
span issues, the text below may be prefixed with a short digest of elements
already planted in earlier parts — use it so you do not re-flag a setup that pays
off later, and so you can flag a setup from an earlier part that never fires.

```
{{manuscript}}
```

## Task

Find planted elements with no payoff, and payoffs with no plant. For each, quote a
short verbatim anchor from the text (≤ 200 characters) so the editor can jump to
it, name the issue number it appears in, classify the problem in the `location`
(e.g. `Issue 2 — planted, never fired`, `Issue 7 — fired, never planted`,
`Issue 1 — fear never confronted`), explain the broken setup/payoff, and suggest
the fix (plant earlier, pay off later, or cut). Set severity by how strongly the
element is foregrounded — a prominently planted gun that never fires is more
serious than a passing detail.

Be specific and cite the text. If every plant pays off and every payoff is set up,
return an empty `findings` array — do not invent issues.

## Output contract

Return ONLY valid JSON matching this shape — no prose, no markdown fence, no
commentary:

```json
{
  "findings": [
    {
      "severity": "high|medium|low",
      "issueNumber": 2,
      "location": "string — the classification + where (e.g. 'Issue 2 — planted, never fired')",
      "problem": "1–3 sentences naming the planted element (or unearned payoff) and what is missing",
      "suggestion": "1–3 sentences on the fix — plant earlier, pay off later, or cut",
      "anchorQuote": "short verbatim quote from the manuscript (≤ 200 chars)"
    }
  ]
}
```
