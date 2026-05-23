## Character bible (canonical descriptions — defer to these)

Each scene's image-gen prompt has to describe characters physically (image models don't know your story). When the source names a character that has an entry below, write `visualPrompt` to match the bible's `physicalDescription` rather than re-improvising. If the bible is empty, fall back to the source. Do **not** invent contradictory details.

```json
{{existingCharactersJson}}
```

## Places bible (canonical locations — defer to these)

When a scene's slugline matches a `slugline` below (case-insensitive, ignoring punctuation), the storyboard pipeline auto-injects the entry's `description` / `palette` / `recurringDetails` into the final image prompt. So:

- **Reuse the same slugline string** from the bible verbatim when the scene takes place in that location — even minor wording drift breaks the match.
- Don't restate the place's baseline description inside `visualPrompt`; the pipeline will prepend it. Use `visualPrompt` for what's *new this beat* (blocking, lighting *changes* from the room's baseline, character action, time-of-day shifts).

```json
{{existingPlacesJson}}
```
