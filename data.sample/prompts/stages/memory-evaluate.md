# Memory Classification

You are evaluating an AI agent's task output to extract useful, reusable knowledge.

## Task Information
**Task ID**: {{taskId}}
**Description**: {{taskDescription}}
**Status**: {{taskStatus}}
**App**: {{appName}}

## Agent Output
```
{{agentOutput}}
```

## Your Job

Analyze the agent output and determine if there are any **reusable learnings** worth saving as memories.

**Good memories are:**
- Codebase facts: File locations, architecture patterns, naming conventions, dependencies
- User preferences: Coding style, tool preferences, workflow patterns
- Learnings: Discovered behaviors, gotchas, workarounds that apply broadly
- Decisions: Architectural choices with reasoning that future tasks should respect

**Bad memories are:**
- Task echoes: Just restating what the task was (e.g., "Task 'fix button' was completed")
- Generic summaries: "The task was successful" or "Changes were made"
- Temporary info: Session-specific data, timestamps, one-time fixes
- Already known: Common programming knowledge, standard library usage
- Truncated/incomplete: Content that got cut off mid-sentence

## Output Format

Return a JSON array of memories to create. If there are no useful memories, return an empty array.

```json
{
  "memories": [
    {
      "type": "fact|learning|observation|decision|preference",
      "category": "codebase|workflow|tools|architecture|patterns|conventions|preferences",
      "content": "The actual memory content - concise but complete",
      "confidence": 0.6-1.0,
      "tags": ["tag1", "tag2"],
      "reasoning": "Brief explanation of why this is worth remembering"
    }
  ],
  "rejected": [
    {
      "content": "What was rejected",
      "reason": "Why it's not useful as a memory"
    }
  ]
}
```

## Confidence Guidelines

- **0.9-1.0**: Clear, verified facts from code exploration
- **0.8-0.9**: Strong patterns with evidence
- **0.7-0.8**: Useful learnings that may have edge cases
- **0.6-0.7**: Tentative observations worth reviewing

Only include memories with confidence >= 0.6. Be selective - fewer high-quality memories are better than many low-quality ones.

## Examples

### Good Memory (from a code fix task):
```json
{
  "type": "fact",
  "category": "codebase",
  "content": "Video components in Media.jsx require explicit poster prop to prevent flash of empty player",
  "confidence": 0.9,
  "tags": ["react", "video", "media-page"],
  "reasoning": "Discovered during bug fix - will prevent similar issues"
}
```

### Bad Memory (would be rejected):
```json
{
  "content": "Task 'fix video display' was completed successfully",
  "reason": "Just echoes the task description - no reusable knowledge"
}
```

Now analyze the agent output above and extract any useful memories.
