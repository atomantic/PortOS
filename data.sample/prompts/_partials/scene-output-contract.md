## Output contract

Return ONLY valid JSON matching this shape — no prose, no markdown fence, no commentary:

```json
{
  "title": "string (the work or episode title)",
  "logline": "string (one-sentence pitch)",
  "scenes": [
    {
      "id": "scene-01",
      "heading": "Scene 1 — Title",
      "slugline": "INT. KITCHEN — NIGHT",
      "summary": "string",
      "characters": ["NAME", ...],
      "action": "string",
      "dialogue": [
        { "character": "NAME", "line": "string" }
      ],
      "visualPrompt": "string",
      "sourceSegmentIds": []
    }
  ]
}
```
