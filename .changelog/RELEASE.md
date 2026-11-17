# Release v2.122.0 - Nimble Maestro

Released: 2026-11-17

## Highlights

- **Music Video Timeline Editor**: A new Editor page places shots on a zoomable, docked timeline beneath the player with a song waveform row, drag-to-trim cuts, shot reordering, split-at-playhead, self-previewing effect tiles, Spacebar play/pause, and lane-by-lane spend tracking including Google Veo render pricing.
- **Faster Startup & Page Loads**: The server now starts serving before the media library sweep finishes, AI run history loads from memory, and heavy modules—including the voice stack, POST drill trainers, and App Detail and Settings tabs—load only when opened.
- **Reliable Quick AI Calls & Voice Dictation**: Stopping or deleting a quick AI call now cancels model loading and fallback requests cleanly without recording phantom usage, while voice dictation handles mic presses during startup and cancels pending starts when voice controls are hidden.
- **Smarter Local Models & Learning Metrics**: The local LLM catalog adds Ornith 1.5, Flint, LFM3 Omni, Nemotron 3.5 Super, and EmbeddingGemma 2, and the Learning tab displays reviewer clean rates from recorded run verdicts.
- **Streamlined Editing Across Builders**: Prompt Manager splits into routed per-editor tabs, Story Builder and creative setup fields edit in place without modal ceremonies, and LoRAs can delete retired training data inline.

## Added

- **Music Video Timeline Editor**: Added a zoomable timeline editor with a song waveform track, docked effects library, self-previewing effect tiles, shot cards, and keyboard playback shortcuts.
- **Music Video Spend Tracking**: Added spend tracking across every paid render lane, including pricing estimates for Google Veo renders.
- **Local LLM Catalog**: Added Ornith 1.5, Flint, LFM3 Omni, Nemotron 3.5 Super, and EmbeddingGemma 2 to the local model catalog.
- **Reviewer Clean Rate**: Added reviewer verdict tracking on agent runs and clean-rate reporting in the Learning tab.

## Changed

- **Faster Cold Loads**: Deferred loading of the voice stack, POST drill trainers, App Detail and Settings tabs, and heavy server SDKs until first use, and opened the Music Video project list without downloading workspace state.
- **Music Video Workflow**: Allowed director-started renders to proceed without separate art and storyboard approvals, warned when shots use older character references, and tracked render staleness across video finish settings, lyric cues, and take color matches.
- **Inline Editing & Tabs**: Split Prompt Manager into routed per-editor tabs, enabled in-place editing in Story Builder and creative setup, and kept list views mounted during their own saves.
- **LoRA Cleanup**: Added inline deletion of retired LoRA training data on the LoRAs page.

## Fixed

- **Quick AI Calls**: Fixed Stop and Delete so cancelled calls stop loading models, avoid provider fallbacks, stay deleted, and never claim another run's CLI usage.
- **Voice Controls**: Fixed dictation mic presses while voice loads and cancelled pending mic starts when voice controls are hidden.
- **AI Runs & Media Lists**: Refreshed the AI Runs list immediately on run start, end, and boot recovery, and refreshed open media lists once the boot sweep finishes.
- **Composite Preview & Playback**: Fixed composite preview falling back to frame-by-frame playback after engine updates and aligned shot jumps to the first whole frame.
- **Save Feedback & Task Formatting**: Surfaced previously swallowed save errors in the UI and preserved multi-line Chief of Staff task descriptions and metadata.
- **Issue & Swarm Reliability**: Prevented stale-claim and swarm-reservation sweeps from treating active reservations as orphaned or leaving stale in-progress labels behind.

## Full Changelog

**Full Diff**: https://github.com/atomantic/PortOS/compare/v2.121.0...v2.122.0
