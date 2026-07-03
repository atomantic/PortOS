# Unreleased Changes

## Media

- **[issue-2036] Sketch & Annotation Canvas (phase 2): re-render an image guided by your annotations.** The annotate page (`/media/annotate/:mediaKey`) gained a "Re-render" action: draw over a generated image, then feed your markup back through local img2img so the marks reshape the render. A confirmation dialog names the exact local model it will run (no surprise AI calls) and lets you add an optional prompt and tune how much to change before it starts; the new render is queued and appears in Media History. Requires a local FLUX img2img runner — the action explains when one isn't available. Phase 3 (blank-canvas storyboard) remains open on #2036.

## MeatSpace POST

- **Multiplication drills now ramp up instead of starting hard.** The mental-math multiplication drill used to open at a fixed 2-digit × 2-digit difficulty (e.g. `566 × 191`) for everyone. It now climbs a mastery-gated ladder — `1×1` → `1×2` → `1×1×1` → `2×2` → … — starting at single-digit × single-digit and advancing to the next rung only after you answer a level quickly *and* accurately (≥90% correct within a per-rung speed target). The drill header and the config page show your current rung and per-level mastery. On by default; turn off "Progressive difficulty" on the Multiplication card to go back to the manual Max Digits setting.
- **Morse trainer audio now works on mobile Safari.** iOS Safari starts the Web Audio context suspended and only unlocks it once `resume()` fully settles. The trainer fired `resume()` without awaiting it, so the first tones were scheduled against a still-suspended clock and never sounded on iPhone/iPad. It now awaits the resume before scheduling any tone (matching the app's other audio modules), so Copy, Head Copy, and Send-mode keying all produce sound on mobile Safari.
