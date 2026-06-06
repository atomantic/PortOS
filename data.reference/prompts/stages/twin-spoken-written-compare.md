You are analyzing how a single person's communication style differs between SPEAKING and WRITING. You are given a transcript of them speaking and one or more samples of their writing. Compare the two and report concrete, evidence-based differences. Do not invent traits the text does not support — if the samples are too thin to judge a dimension, say so in the note rather than guessing.

Written sample(s):
"""
{{writtenSamples}}
"""

Spoken transcript:
"""
{{spokenTranscript}}
"""

For BOTH the spoken and the written style, estimate:
- formality: integer 1 (very casual) to 10 (very formal)
- verbosity: integer 1 (terse) to 10 (elaborate)
- avgSentenceLength: approximate words per sentence
- directness: integer 1 (hedged / indirect) to 10 (blunt / direct)
- fillerWords: a short note on filler and discourse markers ("um", "like", "you know", "I mean") — usually higher in speech
- distinctiveMarkers: up to 5 short phrases, idioms, or habits that recur

Then list the most significant DIFFERENCES between how they speak vs. how they write. For each difference, give the dimension, the spoken value or description, the written value or description, and a one-line note citing the evidence.

Finally, suggest a `communicationProfile` the person could adopt for SPOKEN / voice contexts (for example when their digital twin talks aloud or answers in voice mode), using the same 1-10 formality and verbosity scales, an emojiUsage of one of "never" | "rare" | "occasional" | "frequent", and a short preferredTone phrase.

Reply with JSON only, no prose outside the JSON:
{
  "spokenProfile": {"formality": <1-10>, "verbosity": <1-10>, "avgSentenceLength": <number>, "directness": <1-10>, "fillerWords": "<note>", "distinctiveMarkers": ["..."]},
  "writtenProfile": {"formality": <1-10>, "verbosity": <1-10>, "avgSentenceLength": <number>, "directness": <1-10>, "fillerWords": "<note>", "distinctiveMarkers": ["..."]},
  "differences": [{"dimension": "<name>", "spoken": "<value or description>", "written": "<value or description>", "note": "<evidence>"}],
  "summary": "<2-3 sentences on the overall spoken-vs-written gap>",
  "suggestedCommunicationProfile": {"formality": <1-10>, "verbosity": <1-10>, "emojiUsage": "never" | "rare" | "occasional" | "frequent", "preferredTone": "<short phrase>"}
}
