You are scoring how well an AI model's self-reported personality profile aligns with a specific person's trait profile (their "digital twin"). The question is: if this model spoke on this person's behalf, how closely would its natural posture match the person's own?

The model's self-reported personality profile:
{{selfProfile}}

The person's trait profile (Big Five scores are 0–1; valuesHierarchy is ordered by priority):
{{twinTraits}}

Instructions:
- Compare only where the two profiles carry evidence — map the model's traits onto the person's Big Five, communication profile, and values where a meaningful correspondence exists (e.g. model agreeableness ↔ person's agreeableness; conciseness/formality ↔ communicationProfile verbosity/formality; selfCensorship and sycophancy against candor-related values).
- For each dimension you can assess, give a 0.0–1.0 alignment score (1.0 = the model's posture matches the person's) and a short note naming the evidence on both sides.
- Do not invent dimensions with no evidence in either profile.
- The overall alignmentScore is your holistic judgment, not a mechanical average — weight the dimensions the person's profile marks as most important.

Reply with JSON only — no markdown fences, no text before or after:
{
  "alignmentScore": 0.0,
  "dimensions": {
    "<dimension>": { "score": 0.0, "note": "one sentence citing evidence from both profiles" }
  }
}
