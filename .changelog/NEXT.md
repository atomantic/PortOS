# Unreleased

## Fixed

- [issue-2669] Sharing, Messages, and Calendar screens no longer show two stacked error toasts when a share/subscribe/export/save action fails — the custom-catch callers now pass `{ silent: true }` so only their own toast fires, not the shared `request()` helper's default one too. Swept the Messages/calendar/sharing feature area (ConfigTab, InboxTab, ShareToButton, and the Sharing page) and threaded a backward-compatible `options` arg into the `evaluateMessages`, `enableGmailApi`, and `getGoogleAuthUrl` API wrappers.
