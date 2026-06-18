// Build the durable section-local render tag that converges canon/character
// reference renders onto the same server-side auto-filing path batch renders
// use. When this tag rides a `generateImage` call as `universeRun`, the route
// (server/routes/imageGen.js) resolves the universe's media collection and tags
// the queued job, so `universeBuilderCollectionHook` files the finished render
// into that collection AND `appendEntryImageRef` durably appends the filename to
// the entry's `imageRefs[]` — even if the originating page unmounts mid-render.
//
// This is the front-end half of the generate-then-attach removal (#1362): the
// three canon-render call sites (UniverseCanonSection, NounsStage, the Story
// Builder characters step) previously POSTed an untagged render and then made a
// second full-array `updateUniverse` PATCH on completion to append the ref. With
// this tag the server append is the source of truth; the client only mirrors the
// ref into its local draft optimistically.
//
// `entryRef.kind` is always `'canon'` here (characters/places/objects all live
// under a top-level universe array keyed by `kindKey`). The shape mirrors the
// batch path's entryRef (server/services/universeBuilder.js `ENTRY_REF_KIND`)
// and the route's Zod schema (canon → kindKey + id).
//
// Returns null when the universe/entry identity isn't resolvable yet — the
// caller still renders, just untagged (no auto-file).
export function buildUniverseSectionRenderTag(universe, kindKey, entry) {
  if (!universe?.id || !universe?.name || !kindKey || !entry?.id) return null;
  return {
    universeId: universe.id,
    universeName: universe.name,
    entryRef: { kind: 'canon', kindKey, id: entry.id },
    label: entry.name || kindKey,
    category: kindKey,
  };
}
