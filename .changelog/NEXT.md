# Unreleased Changes

## Fixed

- Creative Director projects that use the Antigravity provider no longer get stuck on "Planning." The agent now reliably receives its instructions instead of launching and sitting idle at an empty prompt (it waits for Antigravity's input box to be ready before sending, the same way the Claude provider does), so planning actually runs to completion.
- A Creative Director project no longer wedges in "Planning" when its agent is interrupted or crashes mid-run. The stuck run is now cleaned up as soon as the dead agent is detected, so the project can retry on its own instead of waiting for the next server restart.
- The Creative Director "Runs" tab now shows why a run failed (e.g. "interrupted by restart") instead of leaving failed runs blank with no explanation.
