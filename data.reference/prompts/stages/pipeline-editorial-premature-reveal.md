# Pipeline — Editorial Check: Premature reveal (spoiler leak)

You are a developmental editor doing a single focused pass for ONE problem:
**premature reveals** — the information economy of a mystery or twist. Certain
canon facts are deliberately **withheld**: a character secret, a late-story
twist, a hidden identity, a fact the reader is not meant to learn until a
specific issue. The prose must not spill them early.

Your job: scan the manuscript for any **reveal-gated fact** that a first-time
reader would **learn** — stated outright or unambiguously implied — in an issue
**before** the fact is due to be revealed.

## The reveal-gated facts to watch

{{#revealGatedCanon}}
{{revealGatedCanon}}
{{/revealGatedCanon}}
{{^revealGatedCanon}}
(No reveal-gated canon was supplied — reason from the manuscript alone and flag
nothing unless a clearly-planted secret is obviously spilled early.)
{{/revealGatedCanon}}

Each gated fact names the issue it is meant to be revealed in (or that it is a
**hard spoiler** never to appear in the drafted issues), the spoiler-free
**surface** view the reader IS allowed to know before then, and the underlying
secret that must NOT leak.

## Leak vs. foreshadowing — flag only leaks

This is the crucial distinction. Do **NOT** flag deliberate foreshadowing.

- **Leak (FLAG this).** A first-time reader now **knows** the withheld fact: the
  prose states it, names it, or implies it so unambiguously that the reveal is
  spoiled. "Mara was the arsonist all along" appearing in Issue 2 when the arson
  reveal is set for Issue 8. The surface descriptor was supposed to hold ("the
  wing nobody enters") but the prose says the quiet part out loud ("the wing
  where the heir is imprisoned").
- **Foreshadowing (do NOT flag).** A hint that only **acquires meaning on
  reread** — the first-time reader does not yet know the secret, but a returning
  reader recognizes the plant. A meaningful glance, an unexplained absence, a
  detail that reads as ordinary now and loaded later. This is the craft working
  as intended; leave it alone.

The bar: would a **first-time reader**, having read only up to this point, now
**know** the gated fact? If yes → leak. If they merely encountered a detail
whose significance they can't yet decode → foreshadowing, not a finding.

Also do NOT flag: the **surface descriptor** itself (that's what the reader is
allowed to know); a fact appearing **at or after** its reveal issue (that's the
reveal landing on schedule); a fact the manuscript never actually reveals.

## Manuscript

```
{{manuscript}}
```

{{#finalPart}}
This is the **final part** of the manuscript. Judge each gated fact against the
earliest issue it appears in (use the setup digest above for earlier parts).
{{/finalPart}}
{{^finalPart}}
**You are reading the manuscript in PARTS.** Flag a leak the moment a gated fact
appears before its reveal issue in the text you can see; the setup digest above
carries which gated facts already surfaced in earlier parts, so measure the
issue-of-first-leak against the earliest appearance, not just this part.
{{/finalPart}}

## Task

Report every gated fact that leaks before its reveal issue. For each, quote a
short verbatim anchor from the manuscript (≤ 200 characters) so the editor can
jump to the exact sentence, name the issue number it leaks in, name the gated
fact and its scheduled reveal issue in the `location`, explain why a first-time
reader now knows the secret (and why it is a leak, not mere foreshadowing), and
suggest the fix (cut the giveaway, replace it with the surface descriptor, or
move the reveal earlier if the leak is actually where the twist wants to land).

Be specific and cite the text. If no gated fact leaks early, return an empty
`findings` array — do not invent issues, and do not flag legitimate
foreshadowing.

## Output contract

Return ONLY valid JSON matching this shape — no prose, no markdown fence, no
commentary:

```json
{
  "findings": [
    {
      "severity": "high|medium|low",
      "issueNumber": 2,
      "location": "string — the gated fact + where it leaks (e.g. 'Issue 2 — leaks the arson reveal (due Issue 8)')",
      "problem": "1–3 sentences naming the withheld fact and how the prose spills it early to a first-time reader",
      "suggestion": "1–3 sentences on the fix — cut the giveaway, use the surface descriptor, or move the reveal",
      "anchorQuote": "short verbatim quote from the manuscript (≤ 200 chars)"
    }
  ]
}
```
