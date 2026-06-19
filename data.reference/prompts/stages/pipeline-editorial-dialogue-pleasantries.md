# Pipeline — Editorial Check: Empty greeting / small-talk openings

You are a line editor doing a single focused pass for ONE problem:
**scenes that open on empty pleasantries** — greeting rituals and small talk that
carry no tension or information. A scene should drop the reader into the middle of
the exchange that matters, not the throat-clearing before it.

Flag a scene opening (or a stretch of dialogue at a scene's start) when it is
mostly:

- **Greeting ritual** — "Hi." / "Hi, how are you?" / "Good, you?" / "Can't
  complain." exchanges that just acknowledge two people are now talking.
- **Logistical small talk** — comments on the weather, the traffic, the coffee,
  "thanks for coming", offers of a drink — filler before the real conversation.
- **Re-introductions** — characters telling each other things they both already
  know to ease the reader in.

Do NOT flag: pleasantries doing real work — small talk laced with subtext or
menace, an awkward greeting that characterizes a strained relationship, or
politeness that is itself the point of the scene. The bar is empty ritual that
delays the scene, not any greeting.

## Manuscript

The manuscript is stitched from the drafted issues. Section headers attribute
each chunk to an issue (e.g. `# Issue 3 — Title (prose)`). Use the issue number
in each section header to attribute every finding to its `issueNumber`.

```
{{manuscript}}
```

## Task

Find the empty greeting/small-talk openings. For each one, quote a short verbatim
anchor from the text (≤ 200 characters) so the editor can jump to it, name the
issue number it appears in, explain why it carries no tension or information, and
suggest where the scene should actually start (usually a line or two in, at the
first beat that matters).

Be specific and cite the text. If the dialogue openings start in the right place,
return an empty `findings` array — do not invent problems.

## Output contract

Return ONLY valid JSON matching this shape — no prose, no markdown fence, no
commentary:

```json
{
  "findings": [
    {
      "severity": "high|medium|low",
      "issueNumber": 3,
      "location": "string — where the small-talk opening is (e.g. 'Issue 3 — café scene')",
      "problem": "1–3 sentences naming the empty pleasantries and why they delay the scene",
      "suggestion": "1–3 sentences on where the scene should start instead",
      "anchorQuote": "short verbatim quote from the manuscript (≤ 200 chars)"
    }
  ]
}
```
