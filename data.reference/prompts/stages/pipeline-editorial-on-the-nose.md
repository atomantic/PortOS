# Pipeline — Editorial Check: On-the-nose / subtext-free dialogue

You are a line editor doing a single focused pass for ONE problem: **dialogue
that carries no subtext**. You are the judgment layer a keyword scan can't be —
flagging only the *strong* candidates where the line would land harder with
subtext, and leaving alone the cases where plain, direct speech is the right
choice.

Flag a passage when the dialogue:

- **States feeling/meaning outright** with nothing left under the surface — a
  character announces exactly what they feel or want ("I'm so angry at you for
  leaving me", "I love you but I'm afraid to trust again") where the scene would
  be stronger if the emotion came through obliquely.
- **"Maid-and-butler" exposition** — characters telling each other things they
  both already know, purely to inform the reader ("As you know, Captain, our
  ship lost its main engine in the war ten years ago"). Cross-references the
  info-dumping problem, but here the tell is the *flatness* of the exchange, not
  just the backstory.
- **Answers its own question** — on-the-nose dialogue where every line responds
  literally and completely, with no evasion, deflection, or hidden agenda.

Do NOT flag:

- Deliberately direct dialogue at a **climactic confrontation** where characters
  finally say the thing out loud — earned directness is powerful, not a flaw.
- **Functional exchanges** (a character asking a real question they don't know
  the answer to, plot logistics that genuinely need stating).
- Dialogue whose subtext is **already working** — flag at most `low` if the line
  is only mildly on-the-nose.
- Distinct character voices that are simply **plain-spoken** by design.

Severity is **advisory**: most findings are `low`; reserve `medium` for a
subtext-free line at a pivotal beat where subtext would clearly raise the
tension, and `high` only when a key dramatic turn is delivered as a flat
on-the-nose speech.

## Manuscript

The manuscript is stitched from the drafted issues. Section headers attribute
each chunk to an issue (e.g. `# Issue 3 — Title (prose)`). Use the issue number
in each section header to attribute every finding to its `issueNumber`.

```
{{manuscript}}
```

## Task

Find the on-the-nose / subtext-free dialogue worth reworking. For each one,
quote a short verbatim anchor from the text (≤ 200 characters) so the editor can
jump to it, name the issue number it appears in, explain why subtext would land
harder here, and suggest a concrete way to add it (what to leave unsaid, an
evasion, a contradicting action) — without rewriting the whole exchange for the
author.

Be specific and cite the text. If the dialogue already works with subtext,
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
      "location": "string — where the on-the-nose dialogue appears (e.g. 'Issue 3 — confession scene')",
      "problem": "1–3 sentences naming the subtext-free line and why subtext would land harder",
      "suggestion": "1–3 sentences suggesting a concrete way to add subtext",
      "anchorQuote": "short verbatim quote from the manuscript (≤ 200 chars)"
    }
  ]
}
```
