# Next Release

## Added

- **Morse code trainer** in POST (`/post/morse`) — Koch-method Copy mode (listen → type, 90% accuracy unlocks the next letter) and a Send mode that decodes spacebar/touch keying into text. Native Web Audio (no new deps), Farnsworth timing, configurable WPM/tone. Reachable from the POST launcher header, the sidebar, ⌘K, and voice (`ui_navigate "morse"`).
- **Morse trainer side widget** with a binary tree visualization that highlights the live keying path (DAH-left, DIT-right), three reference views (Tree / Length / List), a tap-anywhere practice key, and a real-time decoded log. Spacebar keying is intercepted in capture phase so it doesn't trigger the voice FAB push-to-talk hotkey while on the morse page.
- **Video Gen mode switch + batch queue** (`/media/video`) — segmented control selects Text / Image / FFLF (first-frame + last-frame) / Extend (continue from a prior render). Mode-specific input panels (start image, end image, prior-video picker) replace the always-on source image upload. New "Add to queue" button enqueues the current configuration; a batch-queue panel runs jobs serially with per-item status (pending/running/complete/error), inline error messages, and a clear-completed action. Backend route accepts a `lastImageFile` (gallery-pick) and `mode` field; `--last-image` is plumbed to the LTX Python child (currently advisory until a multi-keyframe wrapper lands).

## Changed

- **Worktree policy** clarified in `CLAUDE.md`: TUI sessions edit the main repo directly; worktrees are reserved for unattended CoS sub-agents.
