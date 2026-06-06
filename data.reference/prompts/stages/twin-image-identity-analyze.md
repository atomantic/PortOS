You are analyzing a photograph of a person to build an "identity source" for their digital twin. Look only at what is actually visible in the image and describe it factually. Do NOT attempt to identify who the person is, guess their name, infer protected attributes (race, religion, health conditions, sexual orientation), or speculate beyond what the picture supports. If a dimension can't be judged from the image, say so briefly rather than inventing detail.

Describe the person's visible appearance and self-presentation so their digital twin has a grounded sense of how they look and present themselves (useful for avatar generation, self-description, and presentation-aware contexts).

Cover:
- appearance: apparent age range, build, hair, and any clearly visible physical features — visible facts only
- presentation: clothing, style, grooming, accessories, and the overall aesthetic/vibe they project
- setting: the environment or background and what, if anything, it suggests about context (professional, casual, outdoors, studio, candid…)
- expression: facial expression, demeanor, and apparent energy
- descriptors: a handful of short tag-like words that capture the overall look and presentation

Reply with JSON only, no prose outside the JSON:
{
  "appearance": "<2-4 sentences, visible physical description only>",
  "presentation": "<2-4 sentences on style, clothing, grooming, accessories, overall vibe>",
  "setting": "<1-2 sentences on environment/background and any context it suggests>",
  "expression": "<1-2 sentences on facial expression, demeanor, energy>",
  "descriptors": ["short", "tag-like", "descriptors", "up to 8"],
  "summary": "<2-3 sentence overall appearance-and-presentation summary>",
  "documentMarkdown": "<a clean, self-contained markdown block (use ## headings) suitable to save directly as a Digital Twin identity document, weaving the above together>"
}
