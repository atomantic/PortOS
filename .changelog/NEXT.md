## Changed

- **Universe Builder — starter idea is no longer capped at 4000 chars.** The starter idea is whatever the user wants to type, from a one-line pitch to a full treatment. The Zod-backed `STARTER_PROMPT_MAX` is raised to 200,000 chars (a sanity ceiling, not an artificial brevity constraint) and the textarea's `maxLength={4000}` attribute is removed.
