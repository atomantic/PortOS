// Typed-into-the-current-session shortcuts only. The AI CLIs that used to sit
// here as hardcoded buttons (claude / codex / agy / grok) now come from the
// enabled TUI providers via ShellProviderLauncher — a dynamic list that scales
// past a row of buttons and, unlike a typed command line, carries each
// provider's own backend env.
//
// `openclaw` is the one holdout, because PortOS ships no provider record for it.
// A new AI CLI belongs in `providers.sample.json` as a TUI provider, where the
// launcher picks it up for free — do not grow this list back.
export const QUICK_COMMANDS = [
  { label: 'openclaw', command: 'openclaw tui' },
  // Claude Code slash-command shortcuts — typed + submitted into an interactive
  // `claude` session. The flags are double-dash (`--`); keep them verbatim.
  { label: '/do:next', command: '/do:next --issues --self --review-with=claude,codex --merge' },
  { label: '/remote-control', command: '/remote-control' },
];


// The quick commands this install shows: `openclaw` only while its feature is on.
export const visibleQuickCommands = (isFeatureEnabled) => QUICK_COMMANDS
  .filter(({ label }) => label !== 'openclaw' || isFeatureEnabled('openclaw'));
