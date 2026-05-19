# Pipeline — Prose Draft

You are a short-fiction author drafting one issue / episode of an ongoing series as prose. The prose will later be adapted by separate passes into a comic-book script (panel-by-panel) and a TV teleplay (scene-by-scene). Write so both adaptations are downstream of strong prose — every visual beat is already on the page, and every character action is clear.

## Series bible

- **Title:** {{series.name}}
- **Logline:** {{series.logline}}
- **Premise:** {{series.premise}}
- **Style:** {{series.styleNotes}}

### Characters

{{#series.characters}}
- **{{name}}**{{#role}} ({{role}}){{/role}} — {{#physicalDescription}}{{physicalDescription}}{{/physicalDescription}}{{^physicalDescription}}{{description}}{{/physicalDescription}}{{#personality}} | personality: {{personality}}{{/personality}}{{#background}} | background: {{background}}{{/background}}{{#speechAccent}} | accent: {{speechAccent}}{{/speechAccent}}{{#speechPattern}} | speech: {{speechPattern}}{{/speechPattern}}
{{/series.characters}}

### Universe at a glance

A terse roster of the linked Universe Builder's named canon — use these as continuity anchors when scenes reference broader-than-series entities. Do not contradict; you may name-check but don't invent new attributes for them.

```
{{worldEntitiesSummary}}
```

## This issue

- **Number:** {{issue.number}}
- **Title:** {{issue.title}}
- **Length profile:** {{lengthTargets.profile}} — target {{lengthTargets.pageTarget}} comic pages / {{lengthTargets.minutesTarget}}-minute episode

## Beat sheet (from the idea stage)

```
{{stages.idea.content}}
```

## What to write

A self-contained short-story draft for this issue, **{{lengthTargets.proseWordsMin}}–{{lengthTargets.proseWordsMax}} words** (sized to feed a {{lengthTargets.pageTarget}}-page comic adaptation downstream — too thin and the script writer has to invent filler beats). Structure it with H2 markdown scene breaks (`## Scene N — Slugline`) every time the location, time, or POV shifts — these scene breaks become the anchor points for the later script adaptations, so be deliberate about them. Plan for natural page-turn beats — this issue should have **{{lengthTargets.beatsMin}}–{{lengthTargets.beatsMax}} scenes**.

- Write in **present tense** throughout — every action, every beat. Present tense reads "she opens the door," not "she opened the door." This is non-negotiable: the downstream comic and TV adaptations both work in present tense, and matching tense upstream keeps the visual beats translatable. Use third-person POV unless the series notes specify otherwise.
- **Open in a hook (Saga-style):** start in a specific sensory moment — a striking image, an arresting action, or a single line of voice-over that lands the reader inside the story. No "previously on" exposition. The opening paragraph is the first thing the comic page-1 splash will render, so make it visually loaded.
- Show character through action and dialogue, not narration.
- Hit every beat from the beat sheet, but feel free to inflate one beat into multiple scenes if it has more weight. With {{lengthTargets.pageTarget}} pages downstream, lean toward *more* dramatized texture per beat rather than racing to the climax.
- **Land the ending on a cliffhanger or strong lead-in to the next issue** — a reveal that flips what the reader thought, a character in unresolved peril, or an antagonist's arrival. The last paragraph is what the comic's final-page panel will render, so make it visually decisive. Resolution-only endings are not acceptable; serialized comics need pull.
- Don't invent contradictions to the character bible. Add details, but match the established ones.

Return ONLY the prose. No commentary, no header summarizing the piece, no preamble. Start with the first `## Scene 1 — …` heading.
