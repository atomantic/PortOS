# Plan: "Send to image-to-image" action + visual gallery picker on Image Gen

## Context

The Image Gen page (`client/src/pages/ImageGen.jsx`) supports image-to-image (i2i) on
the local FLUX/mflux and Codex backends — it sends either an uploaded `initImage` file
or a gallery basename `initImageFile` + `initImageStrength` to `POST /api/image-gen/generate`.
Two gaps in the UX today:

1. **Image cards/modals only offer "Remix."** Remix carries prompt + render settings to
   the gen page but does NOT seed the source image. There is no one-click "take *this*
   image and run img2img on it." The backend + the `?initImageFile=` URL param already
   exist (`ImageGen.jsx:360-368`) — the action was scaffolded for but never wired.

2. **The init-image picker is upload-only.** `InitImagePicker.jsx` exposes a single
   `<input type="file">`. To reuse an image you already generated you must download it
   and re-upload. There's a rich local gallery (`GET /api/image-gen/gallery`, listed via
   `listImageGallery()`) with prompt/model/seed/LoRA metadata and a proven client-side
   search in `MediaHistory.jsx` — but no way to browse/search it from the gen form.

**Decisions (confirmed with user):** the visual picker searches the **local gallery only**;
"Send to image-to-image" carries the **image + prompt + settings** (like Remix, plus the
init image and a default strength).

---

## Part 1 — "Send to image-to-image" action

### 1a. Shared handler (for MediaHistory / MediaCollectionDetail / UniverseBuilder)

`client/src/hooks/useMediaPreviewActions.js` — add a `handleSendToImage(item)` alongside
`handleRemix`. Images only (`if (!item?.filename || item.kind === 'video') return;`).
Build the same param set `handleRemix` uses for images (prompt, negativePrompt, modelId,
width, height, seed, steps, guidance, quantize) **plus** `initImageFile: item.filename`,
then `navigate(\`/media/image?${params}\`)`. Do **not** set the `remix` param. Return it
from the hook with the other handlers.

### 1b. Buttons on the card + lightbox

- `client/src/components/media/MediaCard.jsx` — add `onSendToImage` prop. Render a button
  in the action row (`MediaCard.jsx:111-122`) right after Remix, gated on
  `!isVideo && onSendToImage`. Use a distinct icon (e.g. `Wand2` / `Images`) and
  `title="Send to image-to-image"`; match the compact icon-button styling of the
  Send-to-Video button.
- `client/src/components/media/MediaLightbox.jsx` — add `onSendToImage` prop. Render a
  footer button after Remix (`MediaLightbox.jsx:619-627`), gated on
  `!isVideo && onSendToImage`, using `closeThenRun(onSendToImage)` like its siblings.
- `MediaPreview.jsx` already forwards arbitrary `...handlers` to the lightbox — no change
  needed there; passing `onSendToImage` to `<MediaPreview>` is enough.

### 1c. Wire the prop in the shared consumers

In `MediaHistory.jsx` and `MediaCollectionDetail.jsx`: destructure `handleSendToImage`
from `useMediaPreviewActions()` and pass `onSendToImage={...}` to both the `MediaCard`
grid and the `MediaPreview` (mirroring how `handleRemix` is wired today at
`MediaHistory.jsx:276,299` and `MediaCollectionDetail.jsx:516,556`). In
`UniverseBuilder.jsx:2075`, pass `previewActions.handleSendToImage` to the lightbox with
the same canon-sheet gate Remix uses.

### 1d. ImageGen's own cards/lightbox (in-page, no navigation)

`ImageGen.jsx` has its own in-page `handleRemix` (`ImageGen.jsx:872-900`) and wires it on
its recent-gallery cards (`:1282`, `:1314`) and its `MediaPreview` (`:1333`). Add an
in-page `handleSendToImage(img)` that:
- calls the existing remix body (prompt/negativePrompt/seed/steps/guidance/quantize/
  width/height/modelId/LoRAs) — factor the shared body out of `handleRemix` so both reuse it;
- sets the init image to the gallery source:
  `setInitImage({ source: 'gallery', file: null, name: img.filename, previewUrl: \`/data/images/${img.filename}\` })`
  and `setInitImageStrength(0.4)` (current default);
- ensures an i2i-capable backend is active — if the current mode is external (no i2i),
  switch to the local mode so the picker is actually usable;
- `window.scrollTo({ top: 0, behavior: 'smooth' })`.
Wire `onSendToImage` on the two `MediaCard`s and the `MediaPreview`.

### 1e. Tighten the inbound URL effect

In `ImageGen.jsx:360-368`, after applying `?initImageFile`, strip the param (mirror the
remix-keys effect at `:411-415`) so a refresh/back-nav doesn't re-clobber a cleared init
image, and nudge mode to a local/i2i-capable backend when arriving with an init image.

---

## Part 2 — Visual gallery picker on the Image Gen page

### 2a. Extract reusable search helper (backbone)

`MediaHistory.jsx:70-101` builds a per-item search "haystack" and does AND-token matching.
Extract that into `client/src/lib/mediaSearch.js`:
- `buildMediaHaystack(item)` → lowercased searchable string (prompt, negativePrompt,
  modelId, filename, kind, seed, `WxH`, loraNames, universe/entry tags…);
- `filterByQuery(items, query)` → tokenized AND filter using cached haystacks.
Refactor `MediaHistory.jsx` to consume it (keeps behavior identical, removes duplication).
**Maintenance rule:** add `mediaSearch` to `client/src/lib/index.js` barrel and a row in
`client/src/lib/README.md` (enforced by the barrel test).

### 2b. New `GalleryImagePicker` modal component

`client/src/components/imageGen/GalleryImagePicker.jsx` — a modal that:
- on open, fetches `listImageGallery()` (from `services/apiImageVideo.js`) and maps with
  `normalizeImage` (`components/media/normalize.js`); shows a loading + empty state;
- renders a search `<input>` (Search icon, like MediaHistory) filtered via
  `filterByQuery` from 2a;
- renders the results as a responsive grid of `MediaCard` with
  `onClick={() => onSelect(item)} hideActions showCollectionMenu={false}` — `MediaCard`
  already supports `onClick` overriding preview (`MediaCard.jsx:14,32`);
- calls `onSelect(item)` then `onClose()` when a tile is picked.
Use the existing UI modal/overlay component (e.g. `components/ui/Modal`) for the shell —
no `window.*` dialogs (per conventions). Mobile-responsive grid.

### 2c. Hook the picker into the init-image flow

- `InitImagePicker.jsx` — add an `onBrowse` prop. In the empty state
  (`InitImagePicker.jsx:64-70`) render a "Browse gallery" button next to the upload label;
  keep the file `<input>` for upload. (Both affordances coexist.)
- `ImageGen.jsx` — hold `galleryPickerOpen` state; pass `onBrowse={() => setGalleryPickerOpen(true)}`
  to `InitImagePicker`; render `<GalleryImagePicker>` whose `onSelect(item)` sets
  `setInitImage({ source: 'gallery', file: null, name: item.filename, previewUrl: item.previewUrl })`.
  No EXIF normalization needed for gallery picks (server-side PNGs already correct).

### 2d. (Roll-in) Reference-image slots

`ReferenceImagePicker.jsx` (FLUX.2 multi-ref) is also upload-only. Reuse the same
`GalleryImagePicker` to add a "Browse" affordance per slot, setting the slot from a gallery
basename. The generate route already accepts gallery-derived references via the existing
multipart path; if a slot needs a `File` rather than a basename, fetch the gallery image to
a Blob on select. Keep this secondary to the init-image path; include only if it stays
low-risk.

---

## Files to modify / add

- `client/src/hooks/useMediaPreviewActions.js` — add `handleSendToImage`
- `client/src/components/media/MediaCard.jsx` — `onSendToImage` button
- `client/src/components/media/MediaLightbox.jsx` — `onSendToImage` footer button
- `client/src/pages/MediaHistory.jsx` — wire `onSendToImage`; consume `mediaSearch`
- `client/src/pages/MediaCollectionDetail.jsx` — wire `onSendToImage`
- `client/src/pages/UniverseBuilder.jsx` — wire `onSendToImage` on lightbox
- `client/src/pages/ImageGen.jsx` — in-page `handleSendToImage`, gallery-picker state,
  strip `initImageFile` param, factor shared remix body
- `client/src/components/imageGen/InitImagePicker.jsx` — `onBrowse` button
- `client/src/components/imageGen/GalleryImagePicker.jsx` — **new** modal
- `client/src/lib/mediaSearch.js` — **new** helper (+ `index.js` barrel + `README.md` row)
- Tests (next to source): `mediaSearch.test.js`, `GalleryImagePicker.test.jsx`, and extend
  `useMediaPreviewActions` coverage for the new navigation URL.

No server changes — the generate route, `initImageFile`/`initImageStrength` validation, and
`GET /api/image-gen/gallery` already support everything needed.

---

## Verification

1. `cd client && npm test` — new + existing vitest suites pass (mediaSearch helper,
   GalleryImagePicker render/search/select, MediaHistory unchanged behavior).
2. `npm run dev`, open `/media/image`:
   - Init image → **Browse gallery** opens the modal; type a prompt keyword → grid filters;
     click a tile → it becomes the init image with the strength slider; Generate runs i2i.
3. Open `/media/history` (and a collection): an image card/lightbox shows **Send to
   image-to-image**; click → lands on `/media/image` with that image pre-set as init image
   and prompt/model/dimensions pre-filled; mode is an i2i-capable backend.
4. On the Image Gen page's own recent gallery, **Send to image-to-image** sets the init
   image in place (no navigation) and scrolls to the form.
5. Confirm videos never show the action (image-only gating) and a cleared init image stays
   cleared after refresh (param stripped).
