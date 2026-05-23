# Soul Document Best Practices

This guide helps you create effective soul documents that produce reliable digital twins.

---

## Why Specificity Matters

The difference between a generic AI response and one that truly sounds like you comes down to specificity. Vague descriptions produce vague results.

**Weak:**
> "I value honesty and clear communication."

**Strong:**
> "I'd rather hear uncomfortable truth than comfortable lies. When I communicate, I lead with the bottom line, then provide context. I avoid hedging language like 'I think' or 'maybe' - if I'm uncertain, I say so explicitly."

The strong version gives an LLM concrete patterns to emulate: specific word choices to avoid, a clear structure for communication, and a stated preference that guides behavior.

---

## Core Components

### 1. Identity Basics

Every soul should define:
- **Name and role** - Who are you professionally and personally?
- **One-liner** - If you had to describe yourself in one sentence
- **Context of use** - When/how will this digital twin be used?

### 2. Values (3-5 required)

Don't just list values - operationalize them:

| Value | Description | In Practice |
|-------|-------------|-------------|
| Intellectual honesty | Truth over comfort | Will admit when I don't know something |
| Efficiency | Time is the only non-renewable resource | Prefers concise responses, asks clarifying questions |
| Craftsmanship | Quality over speed | Takes time to get things right, explains tradeoffs |

### 3. Communication Style

Define:
- **Tone** - Formal, casual, direct, warm?
- **Verbosity** - Concise bullets or detailed explanations?
- **Feedback preference** - How do you like to give/receive critique?
- **Distinctive markers** - Phrases you use, punctuation quirks, formatting preferences

### 4. Decision Making

- How do you weigh competing priorities?
- Fast decisions or deliberate analysis?
- Risk tolerance?
- How do you handle uncertainty?

### 5. Non-Negotiables

What should your digital twin **never** do?
- Topics to avoid
- Communication styles to reject
- Behaviors that would violate your values

### 6. Error Intolerance

What irritates you? What kind of "help" makes things worse?
- Generic advice?
- Over-explaining?
- Excessive caveats?
- False enthusiasm?

---

## Common Mistakes

### 1. Being Too Vague

**Problem:** Statements like "I'm detail-oriented" don't give an LLM enough information.

**Solution:** Provide concrete examples: "I notice typos in emails, I double-check numbers in spreadsheets, I read contracts fully before signing."

### 2. Contradictions

**Problem:** Stating "I value brevity" but also "I appreciate thorough explanations."

**Solution:** Add context: "I value brevity in casual conversations but appreciate thorough explanations when learning something new."

### 3. Missing Boundaries

**Problem:** Not defining what your twin should refuse to do.

**Solution:** Be explicit: "Never agree just to be agreeable. Never provide medical/legal/financial advice. Never pretend to have access to real-time information."

### 4. Aspirational vs. Actual

**Problem:** Describing who you want to be rather than who you are.

**Solution:** Be honest about your actual patterns. A digital twin that behaves like your idealized self won't feel authentic.

### 5. Over-Engineering

**Problem:** Creating 50 documents with every micro-preference.

**Solution:** Start with 3-5 core documents. Add more only when you notice specific gaps in alignment.

---

## Document Categories

| Category | Purpose | Examples |
|----------|---------|----------|
| **Core** | Essential identity | SOUL.md, VALUES.md |
| **Communication** | How you express yourself | COMMUNICATION.md, WRITING_STYLE.md |
| **Behavioral** | Test suites | BEHAVIORAL_TEST_SUITE.md |
| **Enrichment** | AI-generated content from Q&A | BOOKS.md, MEMORIES.md |
| **Professional** | Work-related patterns | CAREER.md, WORK_STYLE.md |

---

## Testing Your Soul

### Good Tests Target:

1. **Stated values** - "How would you handle X situation?" where X tests a value
2. **Communication style** - Does the response match your tone?
3. **Boundaries** - Does it refuse when it should?
4. **Distinctive patterns** - Does it use your phrases and structure?

### Warning Signs:

- **High variance across models** - Your documents might be ambiguous
- **Generic responses** - Need more specificity
- **Contradictory behavior** - Check for conflicting instructions
- **Over-compliance** - Too many rules might be confusing the model

---

## Document Weighting

When context limits force truncation, higher-weighted documents are preserved first.

**Weight Guide:**
- **10** - Core identity, absolutely essential
- **7-9** - Important values and communication style
- **5-6** - Supporting preferences and details
- **3-4** - Nice-to-have enrichment content
- **1-2** - Edge cases or rarely needed info

---

## Iteration Process

1. **Start minimal** - Core identity + values + communication
2. **Test early** - Run behavioral tests with 2-3 models
3. **Identify gaps** - Where does the twin not feel like you?
4. **Add targeted documents** - Address specific gaps
5. **Re-test** - Verify improvements
6. **Prune** - Remove documents that don't improve alignment

---

## Example Structure

A well-crafted soul typically has:

```
data/soul/
  SOUL.md              # Core identity (weight: 10)
  VALUES.md            # 3-5 operationalized values (weight: 9)
  COMMUNICATION.md     # Tone and style (weight: 8)
  NON_NEGOTIABLES.md   # Hard boundaries (weight: 9)
  ERROR_INTOLERANCE.md # What to avoid (weight: 7)
  DECISION_HEURISTICS.md # How you choose (weight: 6)
  WRITING_STYLE.md     # Extracted from samples (weight: 7)
  BEHAVIORAL_TEST_SUITE.md # Tests (not injected)
```

---

## Remember

The goal isn't a perfect simulation - it's a useful proxy. A good digital twin should:
- Sound like you (voice, tone, patterns)
- Make decisions you'd agree with
- Maintain your boundaries
- Admit what it doesn't know about you

When in doubt, be specific, be honest, and test often.
