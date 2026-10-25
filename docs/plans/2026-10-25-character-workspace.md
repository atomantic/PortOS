# Shared character workspace

## Context

Issue #13650 follows the catalog primitive and detail-loading work. `UniverseCanonSection` currently mounts `CanonCard` and its full `CharacterDetailEditor` for every character. `CreativeLibrary` has a separate tile, while `CatalogIngredient` combines registry fields, a read-only canon projection and an optional compact editor. This duplicates presentation and obscures the selected catalog cover.

## Design

Use one rich character card in Casting and Universe Cast. It links to the existing canonical Casting route, shows the chosen cover, role, description, ownership and usage summary, and exposes the same persisted lock control as the detail header. Universe membership removal remains distinct from deletion. Universe bulk and creative actions retain their current workflows.

Make the existing compact character editor the canonical profile: identity and stats beside Attributes, Story, Appearance and Voice pages. Move the catalog-only identity, aliases, background, notes and forms into that organization. Retain media/cover selection, reference sheets, looks, voice approvals, export consent, LoRA, sources, relations, usage, ownership, identity provenance and history. This is a presentation change over existing IDs and records, with no migration.

The canonical page owns unsaved drafts. Manual fields update that draft immediately; Save remains explicit. Visited editor pages stay mounted so local rows and voice drafts survive navigation. Unvisited production tools and universe context remain lazy. Locks preserve their existing AI/render protection; shared identity fences continue to disable writes.

Cards use bounded batch projections for selected cover and identity access, including retained requested IDs. Lock writes modify only the flag transactionally and project the result to linked canon; they never submit a stale full character payload or surrounding local draft. Socket invalidation and reconnect refresh the visible batch without a full-catalog scan.

## Verification

Exercise rendered navigation/card interactions and the canonical editor union, draft preservation, lazy sections, lock errors and read-only identities. Cover atomic lock writes, projection/history and bounded card lookup at the public route/database boundary. Run targeted single-worker checks and the default focused pregate, then required exact-head hosted CI and independent review. No live fixtures, record mutation or local full suite.
