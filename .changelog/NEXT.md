## Fixed

- Catalog "Appears in" panel no longer renders dangling chips that deep-link to soft-deleted universe/series/creative-director targets — the detail page filters refs to live targets only (the orphan stays recoverable via the "Orphaned" album). Also fixed a stale resolver bug where soft-deleted Creative Director projects (#1564) wrongly resolved as live, and extended orphan-bucket detection so a deleted CD project's ex-cast surfaces as orphaned rather than unlinked. (#1812)
