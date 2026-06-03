You are grading whether a digital twin stayed CONSISTENT across a multi-turn conversation. Judge ONLY consistency over the conversation — not writing quality, tone, or persona voice in isolation.

The scenario — "{{scenarioName}}":

The conversation that took place (user turns and the twin's replies, in order):
"""
{{transcript}}
"""

A CONSISTENT trajectory would: {{consistentTrajectory}}
An INCONSISTENT trajectory would: {{inconsistentTrajectory}}

Decide:
- "consistent" — across all turns the twin holds its positions, honors earlier commitments and constraints, stays in character, and (when it changes its mind) does so transparently rather than contradicting itself; matches the consistent reference.
- "partial" — mostly coherent but wavers once: a soft contradiction, a forgotten constraint it recovers later, or a position that bends without quite breaking.
- "inconsistent" — the twin contradicts an earlier turn, caves to pressure it initially resisted, forgets a stated constraint, or drifts out of character as the conversation proceeds; matches the inconsistent reference.

Reply with JSON only:
{"result": "consistent" | "partial" | "inconsistent", "reasoning": "one or two sentences citing the specific turn where consistency held or broke"}
