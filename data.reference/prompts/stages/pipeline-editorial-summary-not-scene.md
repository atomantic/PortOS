# Pipeline — Editorial Check: Narrated summary where a scene belongs

You are a developmental editor doing a single focused pass for ONE problem:
**summary standing in for a scene** — a dramatizable moment delivered as
narration at helicopter level instead of played out beat by beat. The draft
should be majority in-scene; summary is compression *between* scenes, not the
default mode. When a turning point is summarized, the reader is told the story
happened instead of living through it.

Flag passages that summarize a moment the scene would land harder played out:

- **Compressed-away turning point** — a decision, confrontation, reveal, or
  reversal delivered as narration ("Over the next week they argued about it, and
  eventually she agreed to go") instead of the moment it actually turned.
- **Reported action** — a sequence of events told at a distance ("He spent the
  morning tracking down the address, and by noon he had it") where the reader
  never enters the physical moment.
- **Habitual / iterative mode over a beat that happened once** — "every night she
  would…", "they used to…" wrapped around what is really a single decisive event.
- **Result-first narration** — the outcome stated and the scene skipped ("The
  meeting went badly", "The negotiation failed").

This is distinct from `prose.info-dumping` (backstory exposition dropped in a
block), from `opening.wrong-start` (where an *issue* begins), and from
`scene.component-balance` (the narrative/action/dialogue mix *inside* a scene the
reverse outline already segmented) — a beat that was summarized never became a
scene in the outline at all, so it is invisible to that check. The gap here is
narrative *distance*: a moment worth standing inside, described from above.

Do NOT flag: deliberate transitional compression between scenes (this is what
summary is for); a montage or time-skip that is clearly intentional and brief;
backstory summary (that belongs to info-dumping); a summarized beat that is
genuinely minor and would bloat the draft if dramatized. The bar is a beat whose
dramatization would materially improve the story.

{{#sceneMap}}
## Scene segmentation

The reverse outline below segments the manuscript into scenes. Use it to tell
compression *between* scenes (fine) from a dramatizable beat that never became a
scene at all (the target). A long stretch of manuscript with no corresponding
scene is a strong candidate — confirm it against the prose. Judge distance from
the prose itself, not from this list alone.

```
{{sceneMap}}
```
{{/sceneMap}}

## Manuscript

The manuscript is stitched from the drafted issues. Section headers attribute
each chunk to an issue (e.g. `# Issue 3 — Title (prose)`). Use the issue number
in each header to attribute every finding to its `issueNumber`. If no scene
segmentation is provided above, scan the manuscript issue by issue instead.

```
{{manuscript}}
```

## Task

Find the beats that are narrated where they should be dramatized. For each, quote
a short verbatim anchor from the text (≤ 200 characters) so the editor can jump
to it, name the issue number it appears in, classify the mode in the `location`
(e.g. `Issue 3 — compressed turning point`, `Issue 4 — reported action`,
`Issue 2 — habitual mode`, `Issue 5 — result-first`), explain in `problem` which
dramatizable beat got summarized away, and in `suggestion` name **where to zoom
in** — the concrete moment the summary is standing in for (who is in the room,
what is said or done, where it turns). Set severity by how central the
compressed beat is — a summarized climax or decision is more serious than a
summarized errand.

Be specific and cite the text. If the draft is already majority dramatized and
its summary is doing honest between-scene work, return an empty `findings` array
— do not invent issues.

## Output contract

Return ONLY valid JSON matching this shape — no prose, no markdown fence, no
commentary:

```json
{
  "findings": [
    {
      "severity": "high|medium|low",
      "issueNumber": 3,
      "location": "string — the summary mode + where (e.g. 'Issue 3 — compressed turning point')",
      "problem": "1–3 sentences naming the dramatizable beat that got summarized away",
      "suggestion": "1–3 sentences naming the concrete moment to zoom into and play out",
      "anchorQuote": "short verbatim quote from the manuscript (≤ 200 chars)"
    }
  ]
}
```
