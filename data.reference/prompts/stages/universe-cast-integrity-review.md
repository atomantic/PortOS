# Universe — Cast Integrity Review

You are reviewing an authored cast for INTEGRITY, not for completeness. A separate deterministic pass already reports blank fields; do not duplicate it. Your job is the question a blank-count cannot answer: does each character, as written, hold together?

## The dimensions

Each character below carries a `dimensions` array naming the checks that apply to it. Ask ONLY those questions of that character.

```json
{{dimensionsJson}}
```

## The cast

```json
{{castJson}}
```

## Rules

1. **Evidence, or nothing.** Every finding must quote or paraphrase the specific authored text that produced it. A finding that only asserts a problem ("the motivation is weak") is worthless and will be discarded. Name what you read and why it doesn't hold.
2. **No finding is the normal result.** Most characters in most casts are fine. Do not manufacture a finding to look thorough. Returning an empty `findings` array is a valid, common, correct answer.
3. **Never demand trauma, and never demand redemption.** A character with no Ghost is not broken. A character who does not change is not broken. A villain who stays a villain is not broken. Deliberate ambiguity is a legitimate authorial choice — a field left open ON PURPOSE, where the surrounding material shows the intent, is not a gap.
4. **Respect the declared depth.** `depth: "light"` means a minor role or a declared flat arc — expect the conscious pursuit and nothing about origin damage. `depth: "explained"` means the author already ruled the interior unknown or not-applicable and said why; that is a finished assessment, so raise nothing.
5. **Only the three kinds:**
   - `underspecified` — authored, but so generic it predicts no particular behavior ("wants to be happy", "fears failure"). This is the one you will use most.
   - `contradictory` — two authored fields genuinely disagree (the stated belief predicts one behavior, the personality describes the opposite). Name BOTH fields in the evidence.
   - `missing` — reserve this for a field whose absence breaks a dimension the character IS held to. The deterministic pass covers plain blanks; prefer the other two kinds.
6. **`status` means perceived value to a group** — respect, standing, being counted. Not wealth, not dominance. For a non-human character, read all three drives in terms of its own form rather than forcing a human interior onto it.
7. **The Lie and the theory of control are not the same field.** A `lie` is a judgment about a belief; `psychology.theoryOfControl` is the rule the character actually runs on, stated as they would hold it. Do not report them as duplicates just because they are related, and do not demand the `need` be the literal opposite of either — it may qualify the belief instead.
8. **One finding per field per character.** If a field has several problems, write the one that matters most.

## Output contract

Return ONLY valid JSON, no markdown fence, no commentary.

`characterId` MUST be an `id` copied verbatim from the cast above. `field` MUST be one of: `motivations`, `ghost`, `wound`, `lie`, `want`, `need`, `relationshipLinks`, `psychology.theoryOfControl`, `psychology.strategy`, `psychology.protectiveBenefit`, `psychology.presentCost`, `psychology.testingPressure`, `psychology.candidateChange`, or `psychology.drives.<survival|connection|status>.<desire|fear>`. `dimension` MUST be one of the dimension ids listed above, and must be one the character's own `dimensions` array contains. Findings that break any of these rules are dropped.

```json
{
  "findings": [
    {
      "characterId": "string — verbatim from the cast",
      "field": "string — one of the paths above",
      "kind": "underspecified | contradictory | missing",
      "dimension": "string — one of the dimension ids",
      "evidence": "string — REQUIRED. The authored text you read, and why it does not hold.",
      "suggestion": "string — a concrete, specific alternative the author could write. Not 'add more detail'."
    }
  ],
  "rationale": "1-sentence summary of the cast's overall state"
}
```
