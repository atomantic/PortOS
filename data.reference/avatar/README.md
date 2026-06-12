# Bundled CoS Avatar Models

These GLB models are shipped as selectable Chief-of-Staff avatar styles.

## Source & License

**Kenney Mini Characters** — https://kenney.nl/assets/mini-characters
License: **Creative Commons Zero (CC0)** — public domain, free for personal,
educational, and commercial use. Attribution appreciated but not required.

The models were re-exported from Kenney's source GLBs with the embedded
texture packed in and Draco compression intentionally disabled (PortOS must
render them offline / over Tailscale without fetching an external Draco
decoder from a CDN).

| File | Character |
|------|-----------|
| `mini-male-c.glb`   | Mini Character — Male C (uniformed) |
| `mini-female-d.glb` | Mini Character — Female D (jacket, bun) |

Each ships 32 named animation clips (`idle`, `walk`, `sprint`, `sit`,
`emote-yes`, `interact-right`, etc.) that the avatar maps onto CoS agent states.

## Adding more

Drop any rigged GLB at `data/avatar/<name>.glb` and reference it via
`/api/avatar/model.glb?variant=<name>`. Clip names that match the
`STATE_CLIP_MAP` in `client/src/components/cos/MiniCharacterCoSAvatar.jsx`
will animate per-state; others fall back to `idle`.
