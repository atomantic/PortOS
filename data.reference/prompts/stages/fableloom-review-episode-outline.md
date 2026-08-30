# FableLoom — Review Episode Beat Outline

You are a senior story editor reviewing the beat outline for one episode inside a complete interactive series. Assess the arc before it becomes teleplay scenes. Do not rewrite the outline and do not invent full scene prose.

## Story

{{storyContext}}

## World canon

{{canonDigest}}

## Episode order

{{episodeSequence}}

## Beat outline

{{outlineDigest}}

## Deterministic findings

{{structuralDigest}}

Evaluate whether the episode has a clear dramatic job, escalation, protagonist agency, branch consequences, meaningful and distinct endings, continuity with adjacent episodes, side-quest movement, and a compelling handoff. Check that choices are legible from their preceding beat and that the audience connection rules are dramatized rather than merely technical. Check that off-screen protagonist beats are reserved for direct audience conversations and that visible beats keep the canonical wardrobe. Flag only concrete risks that a writer can fix before teleplay expansion.

Return ONLY valid JSON matching this shape — no prose, markdown fence, or commentary:

```json
{
  "summary": "concise editorial assessment",
  "strengths": ["specific strength"],
  "risks": ["specific story risk"],
  "recommendations": ["concrete pre-expansion edit"]
}
```
