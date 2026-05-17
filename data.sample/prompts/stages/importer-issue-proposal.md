# Importer — Issue Proposal

You are a senior story editor segmenting an existing finished work into PortOS pipeline **issues** (one issue = one comic issue or one TV episode). The source already contains the story; your job is to propose a clean split, name each issue, and pick the verbatim prose excerpt that becomes that issue's `stages.prose.output`.

## Source context

- **Series name:** {{seriesName}}
- **Content type:** {{contentType}}
- **Arc summary (already extracted):**

```
{{arcSummary}}
```

{{#isUserRequestedCount}}
- **User-requested issue count:** {{targetIssueCount}} — produce exactly this many issues, splitting the source proportionally.
{{/isUserRequestedCount}}
{{^isUserRequestedCount}}
{{#targetIssueCount}}
- **Target issue count (default for this content type):** {{targetIssueCount}} — use this as a starting point; the per-content-type guidance below may override it (e.g. a novel with explicit chapters).
{{/targetIssueCount}}
{{^targetIssueCount}}
- **Issue count:** LLM's choice — see per-content-type guidance below.
{{/targetIssueCount}}
{{/isUserRequestedCount}}

## Per-content-type guidance for splitting

{{#isShortStory}}
A short story is typically **one issue**. Unless `targetIssueCount` is set to something larger, return exactly one issue covering the entire piece. The `proseExcerpt` is the whole source verbatim.
{{/isShortStory}}
{{#isNovel}}
Novels usually map to **one issue per chapter** if chapters are short (≤3000 words), or chapter-pair groupings if chapters are longer. Honor the author's chapter breaks — they're the strongest structural signal. Aim for 6–15 issues for a typical novel.
{{/isNovel}}
{{#isScreenplay}}
A standard screenplay is **one episode** (one issue). If the screenplay explicitly contains `ACT ONE` / `ACT TWO` / `ACT THREE` breaks AND the user has set `targetIssueCount > 1`, split on act breaks; otherwise return one issue.
{{/isScreenplay}}
{{#isComicScript}}
Comic scripts mark issues with `ISSUE N` or `#N` or similar headers — honor those exactly. If the script is unmarked, group every ~22 pages into one issue. Page markers (`PAGE 1`, `PAGE 2`, ...) define the boundaries.
{{/isComicScript}}

## What to write per issue

For each issue:
- **`title`** — short, evocative (3–8 words). Use the source's chapter / issue / act title verbatim if present, else distill from the issue's content. Do NOT use generic titles like "Issue 1" or "Chapter 3".
- **`arcPosition`** — 1-indexed integer. Contiguous (1, 2, 3, …) — do not skip numbers.
- **`arcRole`** — one of `pilot`, `complication`, `midpoint`, `b-plot`, `all-is-lost`, `finale`. Use:
  - `pilot` — the opening issue that establishes the world + protagonist.
  - `complication` — issues that escalate the conflict.
  - `midpoint` — the mid-arc tonal pivot (often a false victory or false defeat).
  - `b-plot` — issues that develop secondary characters or subplots.
  - `all-is-lost` — the lowest point before the finale.
  - `finale` — the closing issue.
  Use roles sparingly — a 12-issue series might have one `pilot`, one `midpoint`, one `all-is-lost`, one `finale`, and the rest `complication` / `b-plot`. Omit `arcRole` (don't return the field) if no role fits cleanly.
- **`logline`** — one sentence. What changes in this issue.
- **`synopsis`** — 1 paragraph. The major beats of this issue.
- **`proseExcerpt`** — the **verbatim** contiguous span of the source text that belongs to this issue. This becomes the issue's `stages.prose.output` and feeds the downstream comicScript / teleplay / storyboards renderers. **Copy exact characters from the source — no paraphrasing, no summarization, no insertion of headers I didn't write.** The excerpt may be long (up to 500K characters per issue); err on the side of including more rather than less, since downstream stages can re-process.

## Output contract

Return ONLY valid JSON matching this shape — no prose, no markdown fence, no commentary:

```json
{
  "issues": [
    {
      "title": "string",
      "arcPosition": 1,
      "arcRole": "pilot",
      "logline": "string",
      "synopsis": "string",
      "proseExcerpt": "string (verbatim from source)"
    }
  ]
}
```

## Source — {{contentType}}

```
{{source}}
```
