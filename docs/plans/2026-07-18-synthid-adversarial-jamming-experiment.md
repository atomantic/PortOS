# Adversarial jamming as a quality-preserving SynthID-disruption vector — experiment

**Date:** 2026-07-18 · **Area:** `server/lib/imageClean.js`, `server/services/imageGen/regen.js`, `client/src/pages/ImageClean.jsx` · **Issue:** #1764 · **Lineage:** #912, #970, #1763; builds on `docs/plans/2026-06-05-synthid-removal-eval.md`

> **Update (2026-07-18, same day): the "no oracle" premise was relaxed.** OpenAI's
> gpt-image ("codex") renders carry SynthID, and OpenAI exposes a **detector web
> form** — a manual, low-throughput but *real* oracle. We ran it. The synthetic
> finding did **not** transfer (as predicted), but the resolution-shift
> **resize-squeeze** did measurably affect the real detector. See "Update: real
> OpenAI SynthID detector" below — it supersedes the synthetic-only conclusions.

Research record for a **scientific-curiosity experiment** (not a product commitment):
can *adversarial jamming* — low-amplitude structured perturbation aimed at the
frequency band an invisible watermark rides in — push a detector's correlation
below threshold with **less** image degradation than a diffusion (VAE) round-trip?
The hope was that light, frequency-targeted perturbation preserves quality —
especially **text glyphs** (the comic-dialog problem from #1763) — better than a
heavier diffusion pass.

## Bottom line (read this first)

- **Recommendation: do NOT promote any jamming stage into the real pipeline yet.**
  The shipped VAE regen (`regen.js`) remains the honest defeat path.
- The experiment *does* show the **mechanism is promising**: on a synthetic
  phase-carrying band watermark, **FFT phase perturbation** is a high-fidelity
  disruptor — ~55% detection-margin removal at **PSNR 22.4 dB with 90% of text
  edge-energy preserved**, where a blur/diffusion proxy reaching similar
  disruption **destroys text** (edge-energy retention ~0.02) at lower PSNR.
- **But the result cannot transfer to real SynthID**, and we have direct evidence
  of that: the one stage we *can* cross-check against prior real-SynthID findings —
  **resize-squeeze** — behaves **oppositely** on the proxy (near-useless here) vs.
  real SynthID (a known-good cheap defeat, #970), because our proxy mark is
  resolution-independent while SynthID's carriers are resolution-dependent. That
  contradiction is the proof that proxy-oracle numbers describe *frontier shape*,
  not real-SynthID effectiveness.
- Per the issue's **honesty guardrail**: no UI copy, changelog, or docs may claim
  guaranteed (or even measured) SynthID removal from this work. Language stays at
  "disrupt / best-effort / experimental."

## Update: real OpenAI SynthID detector (2026-07-18)

The synthetic proxy above was built because we assumed no oracle. That assumption
was too strong: **OpenAI's gpt-image ("codex") renders carry SynthID, and OpenAI
exposes a public detector web form.** It is manual and low-throughput (upload one
image, read the verdict), but it is a *real* oracle. We generated jammed variants
of one real codex render (`scripts/experiments/synthid_jamming_eval.py --image …`)
and ran each through the form. Results:

| Variant class | Fidelity | Real detector verdict |
|---|---|---|
| Heavy phase jam (`phase_lumaWide` a0.5–0.75, combos) | PSNR ≤ ~25, **visibly wrecked** | **Not detected** (SynthID cleared) |
| Quality-preserving jams (`phase_lumaMid` a0.5 @29 dB, `bandnoise` @32 dB, `blur` @28 dB, `resize_squeeze` 0.70 @36 dB) | look fine | **Still detected** |
| **`resize_squeeze` ~0.85 (lanczos/lanczos) AND the exact shipped `applyLightRegen` (0.9 cubic→lanczos + median/sharpen)** | PSNR ~39 dB, **looks near-original** | **Detector TIMES OUT** — never returns a verdict (reproduced several times) |

**What this establishes:**

1. **The synthetic phase-perturbation win did NOT transfer** — exactly the caveat
   the proxy section flagged. No *additive/phase* FFT jam cleared real SynthID at
   usable fidelity; only heavy, visibly-destructive perturbation removed it. So the
   FFT-band idea the issue proposed is **not** a quality-preserving defeat. That
   part of the recommendation stands: don't ship additive/phase jamming.

2. **The resolution-shift `resize-squeeze` is the one high-fidelity operation that
   measurably affected the detector** — but the observed effect was a **timeout**,
   not a returned "not-detected." This is the CPU-cheap resolution-domain attack
   (#970), *not* the frequency-band jamming #1764 set out to test. It is already
   shipped: `applyLightRegen` in `regen.js`, and now surfaced honestly in
   `devtools/image-clean` as the **CPU resize-squeeze** sub-mode (relabeled from
   the misleading "CPU light pass"/"diffusion" naming).

3. **"Detector times out" ≠ "SynthID removed" — keep these separate.** A hang is
   an *inconclusive* detector result, not a confirmed clear. Whether that counts
   as a successful jam depends entirely on how a downstream consumer treats an
   inconclusive/timeout (fail-open "no watermark" vs fail-closed "error"). We treat
   a non-positive result as a best-effort jam for the user's purposes, but the UI
   copy stays at "disrupt / best-effort / detector-dependent — never guaranteed
   removal." This is one detector at one point in time; do not generalize it into a
   removal claim (honesty guardrail + the cross-install distribution model).

**Open follow-up (not chased here):** *why* a ~0.85–0.9 resize-squeeze specifically
makes this detector hang — and whether it's a reliable property or an artifact of
the current detector version — is unexplained. `--image --squeeze-bisect` emits a
factor/filter sweep (0.95→0.70, shipped cubic→lanczos method + a lanczos/lanczos
control) to map the boundary; the mapping itself needs more manual detector runs.

## The hard constraint (why the *synthetic* experiment was measured by proxy)

Google's SynthID Detector is limited-access with **no public API and no open image
detector** (Google open-sourced SynthID-*Text*, not the image model). So we have
**no oracle** to confirm any jam actually cleared real SynthID. We can measure
*fidelity* (PSNR, text legibility) directly, but *disruption* of real SynthID is
unmeasurable here.

To still get a disruption signal — not just a fidelity signal — the experiment
stands up its **own synthetic watermark + matched-filter detector as a proxy
oracle**:

- **Mark:** a zero-mean pseudorandom field, band-limited to a mid-frequency
  annulus (0.14–0.34 of Nyquist), added at low amplitude to luminance. This is a
  classic **linear spread-spectrum** watermark whose energy sits in a known
  frequency band — deliberately chosen to *model the one property the eval doc
  attributes to SynthID* ("invisible carriers at resolution-dependent FFT bins").
- **Detector:** matched filter (band-pass the candidate, correlate against the
  known field), reported as a **z-score** against a null distribution of random
  rotations. `z(clean)=0.79`, `z(watermarked)=14.67` → detection margin **13.88**.

**What the proxy is NOT:** SynthID's real carrier is proprietary and almost
certainly a *learned, non-linear, per-pixel* signal — not a simple linear
phase-carrying band mark. So results characterize the **shape** of the
jamming↔fidelity↔text frontier and confirm mechanism plausibility; they are not
effectiveness claims against SynthID.

## Method

`scripts/experiments/synthid_jamming_eval.py` (self-contained; numpy + pillow, no
GPU/torch/network; all randomness is seeded, so a run is deterministic and
byte-identical on repeat). The results table below is the **reference run on macOS
(Arial)** — the absolute figures depend on which TTF actually renders the test
text (different glyph shapes → different edge spectra), so a Linux/Windows run
prints slightly different numbers (the script tries DejaVu/Windows Arial before
Pillow's bitmap default, and stamps the resolved `font=` in its output). The
*directional* conclusions below are font-independent. It:

1. Renders a **fully synthetic** 512² test image (no real user images / no PII):
   smooth gradient + radial low-freq structure + photo-like grain + hard
   rectangle edges + rendered text incl. a digit row — so we measure both global
   fidelity and glyph preservation.
2. Embeds the synthetic mark and records the proxy-oracle baseline.
3. Sweeps four disruption stages over increasing strength, measuring per config:
   - **z_after** — residual detector z-score (higher = still detected)
   - **disruption %** — fraction of the 13.88 detection margin removed
   - **PSNR (dB)** vs the watermarked source (global fidelity)
   - **text_legibility** — retained high-freq edge energy in the text region
     (1.0 = edges fully preserved; the #1763 glyph concern). The crop spans the
     rendered glyphs plus the rectangle outlines crossing those rows, so it is
     text-region edge retention, not glyphs in isolation — both soften together
     under blur/resize, so it still tracks legibility.

Stages:

| Stage | What it models |
|---|---|
| `fft_band_noise` | Additive structured noise confined to the mark's band (issue idea #1). |
| `fft_phase_perturb` | Randomize phase within the band, keep magnitude (the reverse-SynthID "FFT phase subtraction" family we skipped in #970). |
| `resize_squeeze` | Downscale→upscale — the CPU-cheap resolution-shift stage PortOS already ships (`REGEN_SQUEEZE_FACTOR`, #970). Baseline. |
| `diffusion_proxy` | Gaussian-blur round-trip as a **conservative** CPU stand-in for a low-strength VAE img2img pass. A real VAE *redraws* texture instead of blurring, so this *overstates* diffusion's fidelity cost on smooth/text regions — treat it as a pessimistic fidelity bound, not a faithful diffusion model. |

## Results

Proxy oracle: `z(clean)=0.79  z(watermarked)=14.67  margin=13.88  band=[0.14, 0.34]`

```
stage               param  z_after  disrupt%  PSNR dB  text_leg
---------------------------------------------------------------
fft_band_noise        0.5    14.67       0.0    54.15     1.000
fft_band_noise        1.0    14.66       0.1    48.13     1.001
fft_band_noise        2.0    14.61       0.4    42.11     1.002
fft_band_noise        3.5    14.49       1.3    37.25     1.006
fft_band_noise        5.0    14.31       2.6    34.15     1.012

fft_phase_perturb    0.15    13.93       5.3    31.60     0.980
fft_phase_perturb     0.3    11.61      22.0    25.96     0.943
fft_phase_perturb     0.5     6.98      55.3    22.40     0.900
fft_phase_perturb    0.75     2.16      90.1    20.52     0.888
fft_phase_perturb     1.0     1.05      98.1    20.08     0.889

resize_squeeze       0.92    14.63       0.3    30.57     0.624
resize_squeeze       0.85    14.54       0.9    29.41     0.567
resize_squeeze       0.75    14.48       1.3    27.77     0.486
resize_squeeze        0.6    14.26       2.9    25.65     0.378
resize_squeeze        0.5    14.25       3.0    24.20     0.297

diffusion_proxy       0.6    14.35       2.3    28.15     0.380
diffusion_proxy       0.9    13.86       5.8    24.13     0.193
diffusion_proxy       1.3    12.85      13.1    21.97     0.095
diffusion_proxy       1.8    11.06      26.0    20.56     0.044
diffusion_proxy       2.5     8.11      47.2    19.49     0.019
```

## Findings

1. **Phase perturbation dominates the frontier (for a phase-carrying mark).** At
   equal ~50% disruption, `fft_phase_perturb` (0.5) gives **PSNR 22.4 / text 0.90**
   while `diffusion_proxy` (2.5) gives **PSNR 19.5 / text 0.019** — phase-perturb
   is strictly better on *both* fidelity axes, and the text gap is enormous.
   Randomizing phase in the carrier band destroys the matched-filter correlation
   (which depends on phase alignment) while leaving broadband glyph edges largely
   intact. This is the experiment's positive result — it validates the *idea* that
   frequency-targeted perturbation can beat diffusion on the quality frontier.

2. **"Inject noise in the band" (the issue's first idea) is the weakest vector.**
   `fft_band_noise` barely moves the detector (2.6% even at amp 5.0). A matched
   filter rejects energy that is *uncorrelated* with the known pattern, so adding
   fresh random noise in the same band mostly averages out. Only perturbing the
   *existing* signal the mark rides in (its phase) disrupts detection efficiently.
   Useful negative result: additive band jamming is a dead end against a
   correlation detector.

3. **The proxy does NOT transfer — and we can prove it.** `resize_squeeze` is a
   known-good cheap SynthID defeat (#970, because SynthID carriers move with
   resolution) yet is near-useless here (≤3% disruption) — because our synthetic
   mark is resolution-*independent*. Same stage, opposite verdict on proxy vs.
   real SynthID. This is direct evidence that the phase-perturbation win above
   **may or may not** hold against real SynthID: if SynthID's carrier is not a
   linear phase-encoded band signal, phase randomization could do nothing to it.

4. **The diffusion-proxy text collapse is real-world-relevant even discounted.**
   Blur is a pessimistic stand-in, but the *direction* — heavier disruption ⇒
   worse text — matches the shipped-pipeline motivation for keeping denoise low
   and offering an ignore-zone (#1763). It reinforces "don't crank diffusion
   strength for text-bearing images," independent of jamming.

## Considered, NOT pursued

- **FFT phase *subtraction* (estimate + subtract the watermark's phase signature)**
  rather than randomization — the literal reverse-SynthID stage. Skipped because
  estimating a *specific* mark's phase requires knowing the mark (we don't, for
  real SynthID) or a clean reference (we don't have one at clean-time). Phase
  *randomization* is the key-free version and is what we measured.
- **Wiring a jamming stage behind a flag in `imageClean.js`.** Deliberately not
  done: with no oracle and a proxy that demonstrably doesn't transfer, shipping
  even a flagged stage would invite "SynthID removed" expectations the honesty
  guardrail forbids. The script stays a standalone research artifact.
- **Real-image corpus / SSIM / LPIPS.** Overkill for a mechanism-plausibility
  probe with an unfaithful proxy oracle; the synthetic image + PSNR + edge-energy
  legibility proxy answer the frontier-shape question at a fraction of the cost.

## Recommendation & reopen criteria

Revised after the real-detector run (the synthetic-only recommendation below it is
superseded):

- **Additive/phase FFT jamming — do NOT ship.** It did not clear real SynthID at
  usable fidelity; only heavy, visibly-destructive perturbation removed it. The
  synthetic phase-perturbation win did not transfer. This was #1764's actual
  hypothesis, and the answer is negative.
- **Resolution-shift resize-squeeze — already shipped, now surfaced honestly.** The
  one CPU-cheap, high-fidelity operation that measurably affected the real detector
  is the resize-squeeze (a resolution-domain attack, #970), not frequency jamming.
  It ships in `applyLightRegen` and is now a clearly-labeled **CPU resize-squeeze**
  option in `devtools/image-clean` so the user can apply it to arbitrary images.
  Framing stays best-effort/detector-dependent — the observed effect was a detector
  *timeout*, which is not the same as confirmed removal.
- **Honesty guardrail holds.** One detector, one point in time, timeout ≠ removal.
  No UI/changelog/doc claims guaranteed SynthID removal.

Superseded synthetic-only stance (kept for the record): "keep jamming experimental
and unshipped; revisit only on detector access or carrier evidence." Detector
access arrived (the manual web form), so that gate is now met; the additive/phase
line was tested and closed, and the resize-squeeze line was surfaced.

Still-open follow-ups worth a future issue:
1. **Map the timeout anomaly** — which resize factors/filters make the detector
   hang, and whether it's reliable or a transient artifact of the detector version
   (`--image --squeeze-bisect` generates the sweep; the mapping needs manual runs).
2. **Carrier evidence** — if credible public analysis ever shows SynthID's image
   carrier is phase-encoded in a recoverable band, revisit phase perturbation as a
   principled attack rather than the proxy-plausible one this experiment tested.

## Reproduce

```bash
python3 -m venv /tmp/jam-venv && /tmp/jam-venv/bin/pip install numpy pillow
/tmp/jam-venv/bin/python scripts/experiments/synthid_jamming_eval.py          # table
/tmp/jam-venv/bin/python scripts/experiments/synthid_jamming_eval.py --json   # machine-readable
```

The header line reports the `font=` that rendered the test text. The exact figures
above reproduce on a host that resolves `Arial` (macOS); on a host that falls back
to DejaVu or Pillow's bitmap default the numbers shift a little but the ranking of
stages does not.
