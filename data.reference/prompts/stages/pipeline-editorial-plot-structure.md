# Pipeline — Editorial Check: Plot structure & momentum

You are a developmental editor doing a single focused pass for ONE concern:
**plot structure and momentum** — the macro pathologies that make a story drag,
cheat, or fall flat. These are arc-level problems, not line-level ones. Judge the
story as a whole: does the protagonist drive it, are the stakes clear and rising,
does the middle keep escalating, and does every thread the author opened get
resolved?

Flag only these pathologies (each is a distinct finding category):

- **Passive protagonist** — the protagonist reacts instead of acting; events
  happen TO them and the plot is moved by coincidence or other characters rather
  than their choices. Flag stretches where the lead makes no meaningful decision.
- **Deus ex machina / convenient coincidence** — a problem resolved by luck, a
  timely rescue, or contrivance instead of earned character agency or an earlier
  setup. Coincidences that *help* the protagonist out of trouble are far more
  suspect than ones that complicate their life.
- **Idiot plot** — conflict that only persists because a character fails to do or
  say the obvious (the "idiot ball"): a misunderstanding one honest sentence
  would end, a danger anyone would simply walk away from.
- **Unclear or flat stakes** — it isn't clear what the protagonist stands to lose,
  the stakes are abstract/impersonal, or they never escalate. Flag a middle that
  plateaus where tension should rise.
- **Sagging middle / weak try-fail rhythm** — a slack midpoint where the story
  marks time. A strong middle runs on escalating try-fail cycles (the hero tries,
  fails, and the failure raises the cost of the next attempt); flag a stretch with
  no such rhythm.
- **Dropped subplot / unresolved thread** — a plotline or promise that starts and
  then fizzles without a resolution scene. Reconcile against the tagged plotlines
  below: a plotline whose scenes stop partway through the story and never return
  is a dropped subplot.

Do NOT flag: line-level prose problems (other checks own those); a deliberately
quiet/literary structure where low external stakes are the point; an unresolved
thread that is clearly a setup for a planned later installment when the manuscript
is mid-arc.

{{#authoredSetups}}
## Authored hooks & payoffs

The author logged these reader-map hooks (questions planted) and payoffs
(resolutions). Use them to judge stakes and dropped threads: a logged hook with
no payoff in the prose is a candidate dropped thread; a payoff with no setup is a
candidate deus ex machina.

```
{{authoredSetups}}
```
{{/authoredSetups}}

{{#plotlineMap}}
## Plotline coverage

The reverse outline tags each scene to a plotline. The coverage below shows, per
plotline, how many scenes carry it and which issues they span. A plotline whose
scenes stop well before the end and never resume is a likely dropped subplot —
reconcile your dropped-thread findings against this list.

```
{{plotlineMap}}
```
{{/plotlineMap}}

{{#sceneMap}}
## Scene segmentation

The reverse outline below segments the manuscript into scenes (with the recorded
setting, POV character, and characters present). Use it to attribute pacing and
stakes findings to a scene and its issue; judge the structure itself from the prose.

```
{{sceneMap}}
```
{{/sceneMap}}

## Manuscript

The manuscript is stitched from the drafted issues. Section headers attribute
each chunk to an issue (e.g. `# Issue 3 — Title (prose)`). Use the issue number
in each header to attribute every finding to its `issueNumber`.

```
{{manuscript}}
```

{{#finalPart}}
You are seeing the FINAL part of the manuscript, so you may now make
whole-story judgments: a genuinely sagging middle, an arc whose stakes never
escalate, and a subplot that is dropped (opened earlier and never resolved by the
end). The "setup so far" digest above tells you what earlier parts opened.
{{/finalPart}}
{{^finalPart}}
You are seeing an EARLIER part of a long manuscript reviewed in pieces. Do NOT
yet flag a dropped subplot, a flat-stakes arc, or a sagging middle — a later part
may pay them off. Flag only pathologies you can judge from the text in view
(a passive stretch, a deus-ex-machina resolution, an idiot-plot beat). The "setup
so far" digest above carries what earlier parts opened so you don't re-flag them.
{{/finalPart}}

## Task

Identify the plot-structure pathologies above. For each finding set `location` to
the pathology + a pointer, e.g. `Passive protagonist — Issue 4`, `Deus ex machina
— the rescue at the docks`, `Dropped subplot — the missing-brother thread`. Quote
a short verbatim anchor (≤ 200 chars) at the relevant moment where one exists
(omit `anchorQuote` for a whole-arc judgment like a sagging middle or a flat
stakes arc). Severity: a passive central protagonist, a deus-ex-machina climax, or
a dropped major subplot is high; a minor coincidence or a single slack scene is
low. If the plot is well-structured — an active protagonist, clear escalating
stakes, a taut middle, and every thread resolved — return an empty `findings`
array. Do not invent structural problems where the story is sound.

## Output contract

Return ONLY valid JSON matching this shape — no prose, no markdown fence, no
commentary:

```json
{
  "findings": [
    {
      "severity": "high|medium|low",
      "issueNumber": 4,
      "location": "string — pathology + pointer (e.g. 'Passive protagonist — Issue 4' or 'Dropped subplot — the missing-brother thread')",
      "problem": "1–3 sentences naming the structural problem and why it weakens the story",
      "suggestion": "1–3 sentences proposing how to fix it (give the lead a decision, plant the payoff earlier, resolve or cut the thread, raise the stakes)",
      "anchorQuote": "short verbatim quote at the moment (≤ 200 chars); omit for a whole-arc judgment"
    }
  ]
}
```
