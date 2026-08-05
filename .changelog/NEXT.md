# Unreleased

## Documentation
- **Updated documentation index and feature references.** Added missing feature deep dive links for Quota-burn automation (`QUOTA-BURN.md`), Three.js procedural 3D models (`THREEJS_MODELS.md`), Stacker News stewardship (`stacker-news.md`), and the PortDeck native companion app API contract (`COMPANION_APP_API.md`) across `README.md` and `docs/README.md`. Improved inline JSDoc comments for client and server utility modules.

## Fixed
- **Pull requests opened by a CoS agent under a "merge when CI is green" policy now actually get merged.** The check that watches those PRs only ran when an app's optional "PR Watcher" scheduled task fired — and that task ships disabled, since its default prompt is a review-and-comment agent most setups don't want. So PortOS was queueing green PRs into a list nothing ever read: they sat open indefinitely, and because the retry counter never advanced, the safety net that gives up and notifies you after a few hours never fired either. The watch now runs on the normal CoS cadence, independent of that task.
