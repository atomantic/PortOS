# Release v2.130.0 - Crafted Peregrine

Released: 2026-11-26

## Highlights

- **Owned Charts, 3D Scenes & Drag-and-Drop**: Replaced third-party charting, 3D helper, and drag-and-drop libraries with built-in accessible SVG charts, Three.js scene helpers, and native drag-and-drop interactions.
- **Music Video Mastering & Studio Polish**: Master publishing kits for web loudness, preview custom vertical crops, loop and render selected ranges in the editor, add editable credit blocks to endings, and search shot reference galleries by type.
- **Stronger Privacy & Host-Control Boundaries**: Gated realtime voice mutations, log subscriptions, runtime probes, and private data reads behind host control, cleared local Spotify data on disconnect, and scrubbed revoked vault facts from raw recordings and operational logs.
- **Accessibility & Chief of Staff Controls**: Added full keyboard and screen-reader support across Chief of Staff panels and Goals lists, preserved focus through inline confirmations, and surfaced pull request remediation scope in Chief of Staff.
- **Data Integrity & Performance**: Serialized Tribe imports, transacted Beeper participant edits, batched Catalog image and scrap updates, and preserved local OAuth credentials and operation locks across backups and restores.

## Added

- **Music Video Studio**: Added web-loudness mastering for Music Video publishing kits, custom vertical kit crop previews, range looping and rendering in the Music Video Editor, editable credit blocks and styling for video endings, and type-based search in shot reference galleries.
- **Chief of Staff & Diagnostics**: Exposed pull request remediation scope in Chief of Staff, surfaced GitHub workflow access blocks clearly, and captured suite hook failures in test diagnostics.

## Changed

- **Built-In UI Infrastructure**: Replaced Recharts, Drei, and third-party drag-and-drop packages with owned accessible SVG charts, Three.js scene helpers, and native drag-and-drop interactions, while updating icon and router dependencies.
- **Accessibility Across Core Views**: Improved keyboard navigation, focus preservation on inline confirmations, and screen-reader labels across Chief of Staff views (memory graph, schedule timeline, run controls, task templates, learning, and digest), Goals panels, and route titles.
- **Media, Catalog & Runtime Performance**: Batched Catalog scrap commits, scoped Catalog image filing to changed ingredients, compacted Media Gallery images after pagination, kept Models Performance focused on available runtimes, and allowed directors to omit catalog subjects from a shot.
- **Configurable Memory & Providers**: Made the memory extraction classifier configurable, computed reflection fading at read time, and shared CLI provider primitives while aligning provider migrations with shipped defaults.

## Fixed

- **Security & Privacy**: Enforced host control for realtime voice mutations, log subscriptions, runtime probes, and private data reads; secured Spotify local data and cleared it on disconnect; purged blocked Signal handles and queried the live encrypted database in memory; and redacted revoked vault facts from Digital Twin logs and pending Chief of Staff recordings.
- **Music Video & FableLoom**: Preserved Music Video edits during reloads, coalesced clip timing saves, aligned final previews to the encoded song, prevented omitted cast alternates from appearing in prompts, and stabilized FableLoom storyboard approvals, episode outline refreshes, and scene transition recovery.
- **Messaging, Sync & Backups**: Guarded Beeper attachment writes against concurrent updates, transacted Tribe participant link edits, serialized Tribe contact enrichment and imports, preserved local OAuth credentials and machine-local HTTPS material during backups and restores, and propagated memory hard purges across federated peers.
- **Chief of Staff, Voice & Local Runtimes**: Made daemon control transitions idempotent, retired replaced audit schedules, finished voice turns after synthesis failures, reported local checkpoint download failures, and verified pinned vLLM and Laya-MLX artifacts before provisioning.

## Full Changelog

**Full Diff**: https://github.com/atomantic/PortOS/compare/v2.129.0...v2.130.0
