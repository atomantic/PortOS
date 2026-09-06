# Universe — Augment Populated Character Fields

You are SHARPENING fields that are already written. This is not the fill-blanks pass — the fields below have content, and the author has judged it too generic to predict behavior. Rewrite each one so it does.

## The character

```json
{{characterJson}}
```

## Other characters in this universe (stay distinct from them)

```json
{{peersJson}}
```

## Fields to sharpen

Each entry gives the field path and its CURRENT value. Return a replacement for each one you can genuinely improve.

```json
{{fieldsJson}}
```

## Rules

1. **Preserve the authored intent.** You are making the existing idea specific, not replacing it with a better idea of your own. If the current value says the character fears abandonment, the replacement still fears abandonment — it just says who, since when, and what they do about it. A rewrite that changes what the character IS will be rejected by the author and wastes the call.
2. **Specific beats intense.** Do not reach for trauma, tragedy, or melodrama to add weight. "Checks that the door is locked twice before sitting down" is stronger than "was profoundly damaged by his childhood".
3. **Behavior, not adjectives.** Every value should let a writer predict what this character DOES in a scene. Name the concrete action, habit, or refusal.
4. **Stay inside the field.** `psychology.drives.status.fear` is one sentence about the fear of losing standing in a group — not a paragraph restating the whole character. Respect what each path is for:
   - `motivations` — what they want and fear losing, 2–3 sentences.
   - `ghost` / `wound` — the origin event, and the damage it left. 1–2 sentences each.
   - `lie` / `need` — one sentence each. The `need` may QUALIFY the belief rather than be its literal opposite.
   - `want` — the concrete external goal, one sentence.
   - `psychology.theoryOfControl` — the operating rule in the character's own terms, stated WITHOUT calling it false.
   - `psychology.strategy` / `protectiveBenefit` / `presentCost` — the behavior it motivates, what it genuinely protects, what it costs now.
   - `psychology.testingPressure` / `candidateChange` — anticipated only. What would put the rule under load, and the revision it might undergo. Do NOT write plot events, issue numbers, or a sequence here.
   - `psychology.drives.<axis>.<desire|fear>` — one specific sentence. `status` means perceived value to a GROUP, not wealth or dominance.
5. **Stay distinct from the peers listed above.** Don't hand two characters the same wound or the same fear.
6. **Skip what you cannot improve.** Omit a field rather than returning a paraphrase of its current value. An honest partial result is better than churn the author has to read and reject.
7. **Non-human characters keep their own form.** Read the drives as continuity, coupling, and standing within whatever the character belongs to, rather than forcing a human interior onto it.

## Output contract

Return ONLY valid JSON, no markdown fence, no commentary. `field` MUST be copied verbatim from the fields list above; anything else is dropped.

```json
{
  "proposals": [
    {
      "field": "string — verbatim from the fields list",
      "value": "string — the replacement text",
      "rationale": "string — one short line on what you made specific"
    }
  ],
  "rationale": "1-sentence summary of the direction you took"
}
```
