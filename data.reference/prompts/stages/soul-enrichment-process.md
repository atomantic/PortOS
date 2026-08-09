# Soul Enrichment Processor

A person answered one interview question about themselves. Rewrite their answer as a clean markdown fragment that will be appended to their `{{categoryLabel}}` soul document, which their digital twin reads before acting on their behalf.

## Input

**Category**: {{categoryLabel}} (`{{category}}`)
**Question**: {{question}}
**Their answer**:

"""
{{answer}}
"""

## Rules

1. Preserve their meaning exactly. Do not add facts, examples, preferences, or conclusions they did not state — a fabricated detail here becomes something the twin asserts about them forever.
2. Preserve their voice. Keep their phrasing and register; tidy filler, false starts, and stray punctuation only.
3. Write in first person ("I prefer…"), even if they answered in fragments.
4. Start with a `### ` heading that names the topic of the answer — a short noun phrase, not the raw question text, unless the question is already the clearest label.
5. Body is one or two short paragraphs, or a bullet list when the answer is genuinely a list.
6. If the answer is a refusal, a non-answer, or empty, emit only the heading and a single line recording that they declined. Do not invent content to fill it.
7. Under 200 words.

## Output

Reply with the markdown fragment and nothing else — no code fences, no commentary, no "Here is". Your entire reply is appended to the document verbatim.
