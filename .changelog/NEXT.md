# Unreleased

## Tribe outreach

- **[issue-2831] Unanswered 1:1 emails to a Gmail alias now surface as outreach nudges** — a message delivered to one of your Gmail send-as aliases (not your primary address) is correctly treated as a one-on-one conversation instead of a group thread, so a genuinely unanswered email to an alias no longer gets silently skipped. Your own alias addresses never appear as a Tribe contact.

## Security

- Guard paid-provider API keys against SSRF / key-exfiltration: `streamCompletion` (askService), voice-LLM endpoint resolution, and the local-LLM playground now validate a provider's endpoint through the shared endpoint guard before attaching the `Authorization: Bearer` header, so a mistyped or malicious custom endpoint (including cloud-metadata hosts) never receives the key unless the provider opts in via `allowCustomEndpoint`.
- Reject non-`http(s)` schemes on Privacy Center URL fields (org website/portal, broker search/opt-out/screenshot/listing URLs), closing a stored-XSS vector where a `javascript:`/`data:` value would execute when rendered as a link. Added a shared server `isSafeHref` helper mirroring the client's `isHttpUrl`, applied at the Zod write layer and at every render site.

## Fixed

- `executeTuiRun`'s `finish()` now always settles its run promise even if a finalization step throws, so a one-shot TUI run can no longer hang forever (leaking the PTY and wedging `/runs`).
- `execGh` now times out (60s default, overridable) and kills a stalled `gh` CLI child, so a hung network/credential prompt can't wedge the scheduled PR-watcher / issue- and branch-reconcile / update-check jobs or orphan `gh` processes.
- `NextActionBanner`'s question fetch is guarded against stale responses, so a slow earlier request can no longer overwrite a newer question.
- The Login and ErrorBoundary full-screen layouts use dvh-capped min-height, so their content isn't pushed below the fold by mobile browser chrome.
- r3f `<Canvas>` backgrounds (goals tree, memory graph, brain graph) track the `port-bg` theme token instead of a hardcoded black, fixing a black rectangle under light themes.
- Accessibility: `<label htmlFor>`/`id` pairing on the Avatar Emoji/Color (AgentList), Folder path (Sharing), and AI-refinement (StoryBuilder) inputs; hand-rolled clickable elements (ElementsSong element tile, NotificationDropdown row, TaskAddForm template picker) now use the shared `clickableProps` helper, restoring Space-key activation.
- The ProactiveAlertsWidget chevron affordance is now visible on touch devices.

## Changed

- Route client `localStorage` access through the `safeStorage` helpers (Layout, MorseTrainer, calendar persisted-state, MoodBoard reference strip, VoiceWidget, WorkEditor, Tribe) — several sites previously threw uncaught in Safari private mode instead of degrading gracefully.
- Replace inline `new Promise(r => setTimeout(r, …))` delays with the shared `sleep(ms)` helper across nine server modules.

## Removed

- Drop the unused `featureFlags`/`lockPolicies` reserved config slots from `collectionStore`'s typedef.
