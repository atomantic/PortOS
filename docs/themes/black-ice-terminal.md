# Black ICE Terminal

## Intent

Black ICE Terminal is PortOS as an operator console: dense, fast, cyberpunk, and log-friendly. It should make agents, shell sessions, process monitors, and orchestration feel native without making the whole app hard to read.

## Integration Rules

- Prefer compact layouts and clear separators over airy marketing-style cards.
- Do not rely on color alone for status. Pair neon color with labels, icons, or layout position.
- Keep forms and controls keyboard-friendly. Focus must be obvious.
- Use terminal tokens for log/code regions: `var(--port-terminal-bg)` and `var(--port-terminal-text)`.
- Avoid large soft gradients inside content panels. The theme uses sharp borders, scanlines, and restrained glow.

## Component Notes

- Panels use harder corners and visible borders.
- Active nav and tabs should have both accent color and a shape/border cue.
- Neutral controls should use the control fill tokens, not the neon border color as a solid background.
- Tables, logs, and event streams should feel especially strong in this theme.
- Media-heavy pages should keep media neutral; do not tint generated images or previews.
- Long prose pages should not be forced into all-caps or oversized terminal styling.

## Validation

Check dense pages first: Shell, Dev Tools, Processes, Chief of Staff, Agents, Runs, CyberCity, and logs. Confirm scanline overlay does not reduce readability or block interaction.
