# Release v2.120.0 - Spotlight Swan

Released: 2026-11-15

## Highlights

- **Draft-to-final shot workflow:** Render draft or final clip tiers with per-model pricing, and approve draft shots to upgrade them to final resolution directly from the shot board.
- **Look-around camera plates:** Build matching camera-angle plates from a single look-around clip of a place, with tablet-friendly touch controls.
- **Multi-shot takes and extensions:** Render a run of shots as one hosted take from the shot board, and extend hosted Veo takes as child takes.
- **Configurable image verification:** Automatically or batch-verify generated and imported images with Gemini 4 Argon, Qwen 27G/27B, or Antigravity vision evaluators and inspect per-image details.
- **Richer video model support:** Use Kling 4.0 and Kling 4.0 Flash in Higgsfield video, view per-model reference/end-frame/audio hints, and check for newly available Higgsfield model families.
- **Organized Settings:** Navigate Settings more easily with tabs grouped into four clear sections and non-blocking password protection banners.

## Added

- Draft and final clip render tiers with pricing on shot cards, tier badges on clip takes, and one-click final-resolution upgrades from the shot board.
- Matching camera-angle plate generation from a single look-around clip of a place, tracked under backup asset leases.
- Multi-shot hosted take rendering from the shot board and child-take extension for hosted Veo takes.
- Configurable image verifier for generation and gallery imports, including individual inspection details, multi-select batch verification, and Gemini 4 Argon / Qwen 27G / Qwen 27B / Antigravity vision evaluators.
- Kling 4.0 and Kling 4.0 Flash support in Higgsfield video, per-model reference/end-frame/audio hints in Higgsfield and fal pickers, and a "Check for new models" discovery button.
- "Use end frame" option on plain still shots and a "no typography" option for composed music videos.
- Ability to set any reference sheet as a cast member's canonical image and download a music-video shot together with its song.

## Changed

- Settings tabs are grouped into four sections for clearer navigation.
- Unconfirmed password protection appears as a banner instead of a blocking modal.
- Music video frame and clip prompt edits commit on blur, cast media loads in batches, and archived agent records are memoized for faster startup and page loads.
- Scene storage and normalization keep scenes in `startSec` order while leaving untimed lead-in shots in place.
- Maintained dependencies updated across ESLint, PostCSS, browser, icon, and encrypted SQLite packages, alongside reconciled runtime image advisories.

## Fixed

- X thread publishing no longer fails at the third post.
- Unknown extend prices now display as unknown instead of `$0.00`.
- Plain reference images work properly on fal reference-to-video models.
- Hosted provider API key validation rejects non-header-safe keys on save and at render time.
- Canonical cast image replacements propagate to shot references and render as the character's current image, and removing a moved cast reference persists reliably.
- Rendered music videos stay current when kept clips were made from older frames.
- Look-around controls maintain a 44px minimum touch target on tablets.
- Release pre-flight dispatch, in-place release synchronization resumption, and checkout cleanup / fork-PR settlement handle edge cases cleanly without false holds.

## Full Changelog

**Full Diff**: https://github.com/atomantic/PortOS/compare/v2.119.0...v2.120.0
