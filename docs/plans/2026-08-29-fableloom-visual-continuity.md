# FableLoom visual continuity and canon references

## Status and scope

This is the decision-complete design for keeping characters, environments,
objects, and style visually consistent across FableLoom storyboard stills and
video clips. The first increment is implemented: when a rendered direct graph
predecessor exists, its still conditions the next image generation. That is a
useful temporal bridge, but it is not a substitute for durable visual canon.

The design reuses the Universe's existing canon records and assets. It does not
create a second FableLoom-only character or location registry, train models, or
attempt automatic face recognition.

## Why the prior-shot bridge is insufficient

A previous shot can carry palette, lighting, costume, and likeness into the
next render, but it also carries accidental composition and only depicts the
entities visible in that one frame. It cannot establish a character who enters
later, recover an occluded costume detail, describe an environment after a
branch jump, or choose the correct source at a converging node. Repeated
image-to-image generations also accumulate drift.

Visual continuity therefore has three distinct inputs:

1. **World style** — the Universe's embrace/avoid influences, style notes, and
   selected style references.
2. **Entity canon** — stable Character, Place, and Object records plus their
   pinned reference assets.
3. **Temporal continuity** — the immediately preceding shot on the path being
   rendered, used for state that canon does not encode: current pose, damage,
   carried props, weather in progress, and lighting continuity.

Prompts and attached images must identify these roles separately. Treating all
attachments as an unordered reference pile makes it impossible to explain a
provider result or degrade honestly when a backend has fewer image slots.

## Existing sources of truth

Universe already owns the right durable primitives:

- `characters[]`, `places[]`, and `objects[]` are stable, id-addressed canon.
- Every canon entry has `imageRefs[]` and may pin one `primaryImageRef`.
- Characters may have variant reference sheets and structured wardrobes,
  palette, silhouette, posture, traits, props, expressions, and gestures.
- Places carry description, palette, era, weather, INT/EXT, time of day, and
  recurring details; their generated references may include clean plates.
- `styleReferences[]`, `styleImageRefs[]`, influences, and `styleNotes` define
  the visual language independently of scene content.
- `richCanonDescriptorFragments` and the scene-prompt matchers already define
  the shared field order and legacy name/alias matching behavior.

FableLoom should reference those ids and filenames; it must not copy canon prose
or image bytes into a loom record. Updating Universe canon must affect the next
render without rewriting every linked scene.

## Scene binding model

Add an optional `visualCanon` object to each scene node:

```json
{
  "visualCanon": {
    "characterAppearances": [
      {
        "characterId": "char-example",
        "wardrobeId": "wardrobe-field",
        "expression": "guarded",
        "continuityNotes": "mud on the left sleeve"
      }
    ],
    "placeId": "place-observatory",
    "objectIds": ["object-brass-key"],
    "continuitySourceNodeId": "node-prior",
    "shotNotes": "the storm has intensified; preserve the broken east window"
  }
}
```

All keys are optional and bounded. IDs are soft references because Universe
canon is independently editable; a missing id produces an explicit degraded
binding rather than invalidating the story graph. `continuitySourceNodeId` is
an author override for convergence, loops, and non-linear production order. If
it is absent, an unambiguous direct predecessor is used. Multiple predecessors
without an override are reported as ambiguous; the temporary first-in-episode
fallback remains only for pre-binding scenes.

Generation stages should return these structured bindings alongside prose,
`imagePrompt`, and `videoPrompt`. For legacy or manually authored nodes with no
bindings, the compiler may infer candidates with the existing exact
name/alias/place/object matchers. Inferred matches are request-local and marked
as inferred; they are never silently persisted as author decisions.

## Canon asset roles and selection

The compiler resolves assets in this order within each role:

| Role | Selection |
|---|---|
| Character identity | Pinned `primaryImageRef`; otherwise newest valid `imageRefs[]` entry |
| Character structure | Requested reference-sheet variant; otherwise the standard sheet when available |
| Character wardrobe | The bound wardrobe's future pinned reference, then identity reference plus wardrobe text |
| Environment | Pinned place `primaryImageRef`; otherwise newest valid place reference; prefer a clean plate once asset roles are persisted |
| Object | Pinned object `primaryImageRef`; otherwise newest valid object reference |
| Style | User-selected `styleReferences[]`, then a style probe when explicitly enabled for FableLoom |
| Temporal | Explicit `continuitySourceNodeId`, then the unambiguous direct predecessor still |

Missing files are different from absent references. Resolution returns
`ready`, `missing`, `ambiguous`, or `unsupported` for every requested role so
the UI and job provenance never represent a failed lookup as an authoritative
empty reference set.

Character sheets live in a managed reference root, while canon references and
today's clean plates are gallery images without a persisted role distinction.
Phase 2 therefore adds typed server-resolved asset references and stamps the
clean-plate role at generation time; it does not infer the role from a prompt or
filename. The image-generation route should accept those typed references
rather than exposing filesystem paths or forcing the browser to download and
re-upload them. Resolution remains server-side and constrained to approved
media roots. Federated renders reuse the existing conditioning-asset gate and
transfer only the allowlisted resolved inputs, never Universe records or
unrelated canon.

## Prompt compiler

Create one server-side `compileFableLoomVisualRequest` workflow used by both
image and video generation. The client submits loom/episode/node identity and
explicit per-render overrides; the server loads the current loom and Universe,
resolves bindings and assets, and returns the final prompt plus a conditioning
manifest. Centralizing compilation prevents a stale open browser from sending
old canon and gives API, voice, and future batch generation identical results.

The positive prompt is assembled in this order:

1. **Visual language** — Universe embrace influences and style notes.
2. **Environment lock** — place name, INT/EXT, time of day, then rich Place
   descriptor fragments in their shared precedence order.
3. **Character locks** — one named block per bound appearance: physical and
   visual identity, silhouette, posture, traits, palette, then wardrobe and
   per-shot expression/state overlays.
4. **Object locks** — identity/significance only for objects visible in this
   shot.
5. **Shot content** — the authored `imagePrompt` or `videoPrompt`: action,
   staging, framing, lens, and composition. This remains the primary statement
   of what is new in the shot.
6. **Temporal invariants** — concise changes and non-changes relative to the
   predecessor: carry forward costume, damage, prop ownership, environment
   state, and lighting unless the shot explicitly changes them.
7. **Camera direction** — shared FableLoom movement vocabulary for video.

The negative prompt starts with the authored avoid list and Universe avoid
influences, then adds only relevant anti-drift clauses such as duplicate
characters, changed costume colors, altered signature props, or a populated
clean plate. It must not dump narrative secrets, motivations, relationships,
or unrevealed facts into a visual-provider prompt. Only visual canon fields and
the scene's already-visible continuity state are eligible.

Prompt budgeting drops detail in reverse importance: optional style prose,
secondary objects, character detail beyond identity anchors, then environment
atmospherics. It never truncates ids, entity names, the shot content, or the
selected wardrobe/state overlay. The compiled request records which fragments
were omitted.

## Provider capability and attachment budget

Backends have different input-image limits and roles. Extend the image/video
capability contract to expose total input slots and support for `init`,
`reference`, and video-first-frame conditioning. Allocate slots
deterministically:

1. Temporal predecessor when the shot explicitly continues it.
2. Every on-screen character's identity reference, in authored appearance
   order.
3. The environment reference.
4. Signature objects.
5. Style references.

An attachment is never silently dropped. If the full manifest does not fit,
the compiler retains the highest-priority assets, keeps the corresponding text
canon, and reports a degraded result naming omitted roles. The editor shows the
effective set before generation (for example, “Previous shot + 2 characters +
environment; 1 style reference omitted”). A backend that cannot accept the
required temporal/character inputs blocks a canon-locked render rather than
quietly producing an unconditioned image. Authors may explicitly choose a
text-only draft, which is labeled as such in the job and preview.

For the temporary prior-shot path, the predecessor is an init image at strength
`0.4`, matching the existing Image Gen and Universe reference-render default.
Once typed multi-reference inputs exist, temporal continuity becomes a distinct
role and provider adapters decide whether it maps to init/edit or reference
conditioning without changing FableLoom semantics.

## Branches, convergence, and production order

A graph edge defines temporal adjacency. Array position never does. A node with
one incoming edge inherits that predecessor; an opening node inherits none. A
node with multiple incoming edges needs one of:

- an explicit `continuitySourceNodeId` for a shared canonical render;
- path-specific render variants keyed by incoming transition; or
- an intentional continuity reset, which uses canon only.

The first implementation supports the shared canonical render. Path-specific
variants are a later extension because they affect playback asset selection,
job destination tags, storage caps, and editing UI. Loops never use a node's own
still as its automatic predecessor, though an author may explicitly select a
different prior loop node.

Batch generation follows graph topology and waits for each selected temporal
source to finish before queueing its dependent. Independent branches may render
in parallel. A failed predecessor blocks only descendants that require it;
canon-only branches can continue.

## Provenance and observability

Persist a versioned `visualConditioning` manifest in image sidecars and video
history:

```json
{
  "version": 1,
  "universeId": "universe-example",
  "bindings": {
    "characterIds": ["char-example"],
    "placeId": "place-observatory",
    "objectIds": []
  },
  "assets": [
    { "role": "character", "entryId": "char-example", "filename": "character.png" },
    { "role": "temporal", "nodeId": "node-prior", "filename": "prior-shot.png" }
  ],
  "omitted": [],
  "promptCompilerVersion": 1
}
```

The editor exposes this as a compact “Continuity” summary on each scene and a
details view containing resolved/missing/omitted references and the compiled
prompt. Regeneration reads current canon by default; “repeat exact inputs” uses
the recorded manifest and refuses if an asset has been removed. This keeps
“latest canon” and reproducibility explicit rather than conflated.

## Delivery phases

### Phase 0 — predecessor bridge

- Condition a scene image on the first rendered direct predecessor.
- Use graph edges, exclude self-loops, and leave openings text-to-image.
- Warn and retry text-to-image when the backend cannot edit or the predecessor
  file is stale, preserving the existing render path until typed capability
  checks land.
- Cover request composition and the editor-to-API boundary.

### Phase 1 — structured visual bindings and compiler

- Add backward-compatible `visualCanon` sanitization, validation, and prompt-
  stage schemas; preserve absent fields on old records.
- Add the server compiler using shared canon descriptor and matcher helpers.
- Update weave/branch/feedback prompt templates and preserve previous defaults
  through the required prompt migration/version mechanism.
- Expose binding editors beside the scene's image/video prompts.

### Phase 2 — typed assets and capability-aware generation

- Add server-resolved typed asset references for gallery, reference-sheet, and
  clean-plate roots.
- Extend backend capability payloads with role and slot support.
- Add effective/degraded conditioning preview and blocking rules.
- Persist the versioned conditioning manifest for images and videos.

### Phase 3 — production workflows

- Add topological “generate missing storyboards/videos” with dependency-aware
  queueing.
- Add an explicit convergence-source/reset control.
- Add optional path-specific render variants only after playback and storage
  contracts are specified and migrated.

### Phase 4 — continuity review

- Add a user-triggered visual review comparing generated shots with their
  bound canon and predecessor; no boot-time or unrequested provider calls.
- Report suspected drift as review findings with source images and fields, not
  automatic canon mutations.
- Use accepted corrections to update pinned Universe references or scene-local
  state only through explicit author actions.

## Acceptance criteria

- Two adjacent rendered nodes send the predecessor still into the dependent
  image request; unrelated nodes do not.
- Every generated shot can state which Universe entities, text fragments, and
  image assets conditioned it, including omissions.
- Editing linked Universe visual canon changes the next render without copying
  data into FableLoom.
- Missing canon or files are visibly degraded, never collapsed into an empty
  success state.
- Provider limits never cause silent reference loss.
- Branch convergence is deterministic and author-overridable.
- Image and video generation use the same scene bindings and prompt compiler;
  video additionally receives camera direction and the generated scene still
  as its first frame.
- Existing looms with no `visualCanon` continue to load, edit, play, and render.
- No provider call occurs at boot or solely because a loom was opened.
