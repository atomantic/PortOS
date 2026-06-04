# Unreleased

## Added

- **[issue-708] Digital Twin "Voice" tab — spoken vs. written style** — Paste a transcript of yourself speaking and the Digital Twin compares it against how you write (a pasted sample, or your existing twin documents), surfacing where your spoken voice differs from your writing — formality, verbosity, sentence length, directness, filler words — and suggesting a communication profile for voice contexts that you can apply in one click.

## Changed

- **[issue-875] CyberCity district layout internals consolidated** — the city's districts now share one set of layout primitives for grid placement, category tallies, and log-scaled building heights, so each district no longer carries its own copy of that math. No visible change to the city.
