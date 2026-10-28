# Music Video festival packet

Open a music-video project's **Publish → Festival packet** card. Existing projects
start with an empty version 1 packet; no migration, provider call or account is
needed. Edit the film details, credits, synopses, biography, AI process and tools,
rights/consent declarations, release and screening history, and premiere status.
Add festival notes for deadlines, fees, categories, requirements and extra
questions/answers. Empty fields mean **unknown**, not no, cleared or eligible.

Suggestions name their source (project title or story summary). **Apply** replaces
only that draft field; **Save festival packet** persists the draft. Later project
updates and publishing-kit rebuilds preserve the packet. Source changes never
replace manual edits automatically. The missing-fields checklist is preparation
help, not an eligibility assessment. Rights status is explicitly a user declaration.

Check each field to include it, and opt individual festival notes into the export.
Nothing is selected by default. **Preview selected export** produces the exact
plain text used by **Copy selected packet** and **Download selected packet**.
Changing a field, selection or selected render invalidates the preview. A preview
may include unsaved edits; saving and exporting are separate actions. Review the
exact preview before sharing it with a festival.

Preview requires the existing operator authority because the current selected master is probed locally for actual pixel dimensions and
runtime. Missing/unreadable files, failed measurements or a master changed during
measurement stay unknown. Measurements are made again for each preview and are
labeled as measured at preview; they are not stored as durable technical claims.
Declared runtime and format are separate editable statements. The local inventory
shows recorded assets only for a kit bound to the current master. Files are not
uploaded, embedded or converted; add a public screener, poster, still or captions
URL when you have one. Inventory does not certify asset availability or rights.

Do not enter screener passwords, access tokens, payment details or login
credentials. The schema has no credential fields, rejects recognizable secret
assignments and private file/network references, and only accepts public HTTPS
links without user information, ports or fragments. Query parameters are limited
to `v` for common video links. Validation refuses unsafe input instead of silently
rewriting it. This is a bounded validator, not a guarantee that arbitrary prose
contains no sensitive information; review what you enter and share.

The packet is part of the existing project JSON on PostgreSQL and the development/
test file backend. It follows the project's existing opted-in `musicVideoProjects`
peer sharing between user-controlled machines. It adds no new sync audience or
external service. Schema version 32 prevents newer packets reaching older strict project editors.
The optional field is retained by current whole-record peers; a legacy incoming
record that omits it preserves the local packet. Invalid packets are excluded
from both incoming and outgoing wire projections. Explicit
`null` clears it. No separate local-path or render-measurement snapshot is synced.

PortOS does not discover festivals, certify eligibility, submit applications,
accept terms, pay fees or publish anything through this feature.
