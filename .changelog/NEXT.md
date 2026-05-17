# Release v{NEXT}

## Changed

- **Universe canon now lives inside Universe Builder.** Characters, places, and objects are managed inline on the universe page — no separate canon page to navigate to. The old canon URL still works as a redirect, and the Series Pipeline link lands you on the same combined view. Pending edits to other universe fields are no longer lost when canon changes are saved.
- **Locking a canon entry now also blocks new reference renders.** Locked characters/places/objects already prevented AI rewrites; they now prevent new reference and clean-plate image renders too, so a locked entry's identity stays frozen across both text and visuals. Disabled buttons explain the lock in their tooltips.
- **Universe Builder categories now carry a canon trunk (`kind`)** so each bucket knows whether it belongs under Cast, Places, Objects, or Other. Built-in defaults are pre-tagged (landscapes/environments/structures → Places, vehicles → Objects); custom buckets default to Other until you sort them. The default `characters` category was retired — canon owns characters now, and any pre-existing character variations get folded into universe canon on upgrade. Foundation for the upcoming tabbed-trunk Universe Builder redesign.

## Fixed

- **Volume cover-concept generation no longer 500s on upgraded installs.** The per-season "generate volume cover concepts" LLM step was shipped with its prompt template but missing from `stage-config.json`, so existing installs hit `Stage pipeline-volume-cover-concepts not found`. Added the config entry and a migration that seeds both the template and the config on next launch — fresh installs were already fine.
