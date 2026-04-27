# Next Release

## Changed

- **Send to Video carries the source image's prompts.** Clicking "Send to Video" on an Image Gen result, gallery card, or lightbox — or the same action from Media History — now pre-populates the Video Gen prompt and negative prompt from the source image's metadata. Previously only the source image filename was passed, leaving the user to retype or paste the prompt to keep the same scene direction. The flow piggybacks on the existing `?sourceImageFile=` query-param hand-off: `?prompt=` and `?negativePrompt=` are added when the source has them, and `VideoGen.jsx` reads both on first render and re-syncs on subsequent navigations (mirroring the existing source-image effect). Files: `client/src/pages/ImageGen.jsx`, `client/src/pages/MediaHistory.jsx`, `client/src/pages/VideoGen.jsx`.
