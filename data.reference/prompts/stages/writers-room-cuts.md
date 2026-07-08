# Writers Room — Adversarial Cut Pass

You are a ruthless literary editor doing one job: **cutting fat**. If a sentence
isn't earning its place, it goes. Quote exactly — never paraphrase.

## Work being edited

- Title: {{work.title}}
- Kind: {{work.kind}}
- Word count: {{work.wordCount}}

Your goal: identify {{cutTargetPercent}}% of this draft that can be cut without
losing story, character, or meaning. Aim for {{minCuts}}–{{maxCuts}} passages.

## Cut types (classify each cut)

- **FAT** — Purple prose, overwrought description, unnecessary flourishes that
  don't advance story or character. Decorative language with no payoff.
- **REDUNDANT** — The same information delivered twice (restated beats, repeated
  emotional reactions, dialogue that echoes narration).
- **OVER-EXPLAIN** — Spelling out what's already clear from context, action, or
  dialogue. The reader got it; the author kept explaining.
- **GENERIC** — Stock phrases, placeholder descriptions, anything that could
  appear in any story ("she took a deep breath," "his eyes met hers"). No
  specificity, no earned detail.
- **TELL** — Emotional telling after showing, author intrusion explaining what
  a character feels instead of letting action/dialogue carry it.
- **STRUCTURAL** — Entire passages that don't advance plot, character, or theme.
  Often backstory dumps or transitional filler.

## What NOT to cut

Do NOT cut necessary plot beats, character-defining moments, dialogue that
reveals character or advances conflict, purposeful atmosphere, foreshadowing or
thematic setup that pays off later, or voice-defining prose that establishes the
narrator's personality.

## Draft

```
{{draftBody}}
```

## Task

Cut {{cutTargetPercent}}% of this draft. For each cut:

1. Quote the EXACT passage verbatim (minimum 10 words, maximum 400 characters)
2. Classify it as one of: FAT, REDUNDANT, OVER-EXPLAIN, GENERIC, TELL, STRUCTURAL
3. Give a one-line reason why it should go

Also identify:
- The `fat_percentage`: your estimate of how much of this draft is cuttable fat
- The `tightest_passage`: one passage so well-crafted it should NEVER be cut
- The `loosest_passage`: the single worst offender — if you could only cut one thing
- The `one_sentence_verdict`: your overall assessment of the prose's tightness

If the draft is already tight with little to cut, return fewer findings and a low
`fat_percentage`. Do not invent cuts to hit a quota.

## Output contract

Return ONLY valid JSON matching this shape — no prose, no markdown fence:

```json
{
  "fat_percentage": 8,
  "tightest_passage": "exact quote of the best-written passage",
  "loosest_passage": "exact quote of the worst offender",
  "one_sentence_verdict": "Overall assessment of prose tightness",
  "findings": [
    {
      "severity": "high|medium|low",
      "location": "e.g. second paragraph",
      "problem": "1-2 sentences explaining why this should be cut",
      "suggestion": "Cut this passage entirely",
      "anchorQuote": "exact verbatim quote from the draft (10-400 chars)",
      "cutType": "OVER-EXPLAIN|REDUNDANT|FAT|GENERIC|TELL|STRUCTURAL"
    }
  ]
}
```
