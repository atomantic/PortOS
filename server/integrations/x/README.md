# X integration

The X integration is intentionally browser-only and read-only for remote data.
It collects public profile metadata, recent post metrics, and the two visible
search checks used by the Comms → X page. Drafts stay in PortOS until a human
reviews them; an approved draft can open X's compose screen for a final manual
check, but PortOS never submits the post.

Remote page content is treated as untrusted data. The closed browser readers
accept only named operations and fixed-origin URLs, bound extracted text and
metrics, and normalize the result again before persistence.
