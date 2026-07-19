#!/usr/bin/env python3
"""
Adversarial-jamming SynthID-disruption experiment (issue #1764).

STATUS: experimental / research-only. NOT wired into the PortOS image-cleaner
pipeline (`server/lib/imageClean.js`, `server/services/imageGen/regen.js`). Run
standalone to reproduce the measurements recorded in
`docs/plans/2026-07-18-synthid-adversarial-jamming-experiment.md`.

WHAT THIS DOES / WHAT IT CANNOT DO
----------------------------------
The motivating question (issue #1764): can *adversarial jamming* — low-amplitude
structured noise / phase perturbation aimed at the frequency bands an invisible
watermark rides in — knock a detector's correlation below threshold with LESS
image degradation than a diffusion (VAE) round-trip?

Hard constraint (from `docs/plans/2026-06-05-synthid-removal-eval.md`): Google's
SynthID Detector is limited-access with NO public API, so we have NO oracle for
real SynthID. We therefore CANNOT measure disruption of real SynthID here.

To still get a *disruption* signal (not just a fidelity signal), this script
stands up its own **synthetic spread-spectrum watermark** with a matched-filter
detector as a PROXY ORACLE. It is a mid-frequency-band linear spread-spectrum
mark — a classic, well-understood robust watermark — NOT SynthID. SynthID's real
carrier is a proprietary, likely learned per-pixel signal. So the numbers here
characterize the SHAPE of the jamming-vs-fidelity frontier and confirm mechanism
plausibility; they do NOT transfer as effectiveness claims against real SynthID.
Keep that caveat attached to every result. (This is the same "no detector-verified
claims" honesty guardrail the issue mandates.)

Metrics per processed image:
  - detector z-score  : proxy-oracle correlation of the mark (higher = still detected)
  - disruption %      : how much of the watermark's detection margin was removed
  - PSNR (dB)         : global fidelity vs the watermarked source (higher = better)
  - text-legibility   : retained high-frequency edge energy in the text band
                        (higher = glyphs better preserved) — the #1763 comic-dialog concern

Dependencies: numpy, pillow. No GPU, no torch, no network.
"""

import argparse
import json
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFont

RNG_SEED = 20260718           # fixed so runs are reproducible
WM_SEED = 0xC0FFEE            # synthetic-watermark key (proxy oracle)
BAND_LO, BAND_HI = 0.14, 0.34  # annular mid-frequency band (fraction of Nyquist)


# ----------------------------------------------------------------------------
# Test image — fully synthetic (no real user images / no PII). A mix of smooth
# gradients, photo-like textured noise, hard geometric edges, and rendered text
# so we can measure BOTH global fidelity and text-glyph preservation.
# ----------------------------------------------------------------------------
def make_test_image(size=512):
    rng = np.random.default_rng(RNG_SEED)
    yy, xx = np.mgrid[0:size, 0:size].astype(np.float64)
    grad = (xx / size) * 180 + (yy / size) * 40                       # smooth gradient
    radial = 60 * np.cos(np.hypot(xx - size / 2, yy - size / 2) / 22)  # low-freq structure
    texture = rng.normal(0, 12, (size, size))                         # photo-like grain
    base = np.clip(grad + radial + texture + 30, 0, 255)

    img = Image.fromarray(base.astype(np.uint8)).convert("RGB")
    draw = ImageDraw.Draw(img)
    # Hard edges (frequency content across the spectrum)
    for i in range(4):
        draw.rectangle([40 + i * 90, 40, 90 + i * 90, 470], outline=(255, 255, 255), width=2)
    # Rendered text — the comic-dialog legibility case from #1763.
    # The absolute z-scores/PSNR/text-legibility numbers depend on which font
    # actually renders (different glyph shapes → different edge spectra), so the
    # exact results table in the design doc is the REFERENCE run on the first
    # font found below. Try a few common cross-platform TTFs before Pillow's
    # tiny bitmap default so a Linux/Windows run still renders real glyphs (the
    # *directional* conclusions hold regardless of font; only the exact figures
    # shift). Record the resolved font in the output meta for transparency.
    font, font_used = ImageFont.load_default(), "pillow-default"
    for path in (
        "/System/Library/Fonts/Supplemental/Arial.ttf",              # macOS
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",           # Debian/Ubuntu
        "/usr/share/fonts/dejavu/DejaVuSans.ttf",                    # Fedora/Arch
        "C:\\Windows\\Fonts\\arial.ttf",                             # Windows
    ):
        try:
            font, font_used = ImageFont.truetype(path, 34), path
            break
        except OSError:
            continue
    make_test_image.font_used = font_used
    for row, txt in enumerate(["QUALITY", "vs", "DISRUPTION", "0123456789"]):
        draw.text((60, 120 + row * 70), txt, fill=(255, 255, 255), font=font)
    return np.asarray(img.convert("L"), dtype=np.float64)


def luminance(a):
    return a


# ----------------------------------------------------------------------------
# Synthetic spread-spectrum watermark + matched-filter detector (PROXY ORACLE).
# The mark is a zero-mean pseudorandom field, band-limited to a mid-frequency
# annulus, added at low amplitude. Detection correlates the band-passed candidate
# against the known field and reports a z-score (0 ~= not present).
# ----------------------------------------------------------------------------
def _annulus_mask(shape, lo=BAND_LO, hi=BAND_HI):
    h, w = shape
    fy = np.fft.fftfreq(h)[:, None]
    fx = np.fft.fftfreq(w)[None, :]
    r = np.hypot(fy, fx) / 0.5  # normalize so Nyquist -> 1.0
    return (r >= lo) & (r <= hi)


def watermark_field(shape):
    rng = np.random.default_rng(WM_SEED)
    noise = rng.standard_normal(shape)
    F = np.fft.fft2(noise)
    F[~_annulus_mask(shape)] = 0.0            # keep only the mid-frequency band
    field = np.real(np.fft.ifft2(F))
    field -= field.mean()
    field /= (field.std() + 1e-9)
    return field


def embed_watermark(img, alpha=2.2):
    return img + alpha * watermark_field(img.shape)


def _bandpass(img):
    F = np.fft.fft2(img - img.mean())
    F[~_annulus_mask(img.shape)] = 0.0
    return np.real(np.fft.ifft2(F))


def detect_zscore(candidate, field):
    """Matched-filter z-score of the mark in `candidate`.

    Correlate the band-passed candidate against the known field, normalized by a
    null distribution built from many random rotations of the field. High z =>
    the watermark is still detectable.
    """
    bp = _bandpass(candidate)
    bp = (bp - bp.mean()) / (bp.std() + 1e-9)
    f = (field - field.mean()) / (field.std() + 1e-9)
    obs = float(np.mean(bp * f))
    rng = np.random.default_rng(RNG_SEED + 7)
    null = []
    flat = f.ravel()
    n = flat.size
    for _ in range(200):
        shift = int(rng.integers(1, n - 1))
        null.append(float(np.mean(bp.ravel() * np.roll(flat, shift))))
    null = np.asarray(null)
    return (obs - null.mean()) / (null.std() + 1e-9)


# ----------------------------------------------------------------------------
# Fidelity metrics
# ----------------------------------------------------------------------------
def psnr(a, b):
    mse = float(np.mean((a - b) ** 2))
    if mse <= 1e-12:
        return 99.0
    return 10.0 * np.log10((255.0 ** 2) / mse)


def text_legibility(ref, cand):
    """Retained high-frequency edge energy in the text region (rows 110..400).

    Ratio of candidate gradient energy to reference gradient energy in the text
    region, clipped to [0, 1.2]. 1.0 = edges fully preserved; lower = the process
    softened them. Sensitive to blur (diffusion/roundtrip proxies) and to spatial
    resampling (resize-squeeze). Note: the crop spans the rendered glyphs AND the
    vertical rectangle outlines that pass through those rows, so this is
    text-region edge retention, not glyph edges in isolation — both degrade
    together under blur/resize, so the ratio still tracks glyph legibility.
    """
    def edge_energy(a):
        crop = a[110:400, 40:472]
        gx = np.diff(crop, axis=1)
        gy = np.diff(crop, axis=0)
        return float(np.mean(gx ** 2) + np.mean(gy ** 2))
    e_ref = edge_energy(ref)
    e_cand = edge_energy(cand)
    return min(1.2, e_cand / (e_ref + 1e-9))


# ----------------------------------------------------------------------------
# Disruption stages under test
# ----------------------------------------------------------------------------
def jam_fft_band_noise(img, amp):
    """Additive structured noise confined to the watermark's FFT band."""
    rng = np.random.default_rng(RNG_SEED + 101)
    noise = rng.standard_normal(img.shape)
    F = np.fft.fft2(noise)
    F[~_annulus_mask(img.shape)] = 0.0
    band = np.real(np.fft.ifft2(F))
    band /= (band.std() + 1e-9)
    return img + amp * band


def jam_fft_phase_perturb(img, amp):
    """Randomize phase within the watermark band, keep magnitude (reverse-SynthID
    'phase subtraction' family). `amp` in [0,1] blends toward fully random phase."""
    rng = np.random.default_rng(RNG_SEED + 202)
    F = np.fft.fft2(img)
    mask = _annulus_mask(img.shape)
    mag = np.abs(F)
    phase = np.angle(F)
    rand_phase = rng.uniform(-np.pi, np.pi, img.shape)
    new_phase = phase.copy()
    new_phase[mask] = (1 - amp) * phase[mask] + amp * rand_phase[mask]
    F2 = mag * np.exp(1j * new_phase)
    return np.real(np.fft.ifft2(F2))


def spatial_resize_squeeze(img, factor):
    """Downscale by `factor` then back — the CPU-cheap resolution-shift defeat
    stage PortOS already ships (REGEN_SQUEEZE_FACTOR, #970). Baseline to beat."""
    h, w = img.shape
    im = Image.fromarray(np.clip(img, 0, 255).astype(np.uint8))
    small = im.resize((max(1, int(w * factor)), max(1, int(h * factor))), Image.LANCZOS)
    back = small.resize((w, h), Image.LANCZOS)
    return np.asarray(back, dtype=np.float64)


def diffusion_roundtrip_proxy(img, sigma):
    """Gaussian-blur round-trip as a CPU stand-in for a low-strength VAE/diffusion
    img2img pass. A real VAE resample redraws texture rather than blurring, so
    this OVERSTATES diffusion's fidelity cost on smooth regions and text — treat
    it as a conservative (pessimistic) fidelity bound for the diffusion path, not
    a faithful diffusion model."""
    from math import ceil
    radius = max(1, int(ceil(sigma * 3)))
    ax = np.arange(-radius, radius + 1)
    k = np.exp(-(ax ** 2) / (2 * sigma ** 2))
    k /= k.sum()
    blurred = img.copy()
    blurred = np.apply_along_axis(lambda m: np.convolve(m, k, mode="same"), 0, blurred)
    blurred = np.apply_along_axis(lambda m: np.convolve(m, k, mode="same"), 1, blurred)
    return blurred


# ----------------------------------------------------------------------------
# Sweep driver
# ----------------------------------------------------------------------------
STAGES = {
    "fft_band_noise":   (jam_fft_band_noise,        [0.5, 1.0, 2.0, 3.5, 5.0]),
    "fft_phase_perturb": (jam_fft_phase_perturb,    [0.15, 0.3, 0.5, 0.75, 1.0]),
    "resize_squeeze":    (spatial_resize_squeeze,   [0.92, 0.85, 0.75, 0.6, 0.5]),
    "diffusion_proxy":   (diffusion_roundtrip_proxy, [0.6, 0.9, 1.3, 1.8, 2.5]),
}


def run(size=512, alpha=2.2):
    clean = make_test_image(size)
    field = watermark_field(clean.shape)
    wm = embed_watermark(clean, alpha=alpha)

    z_clean = detect_zscore(clean, field)     # baseline: no mark
    z_wm = detect_zscore(wm, field)           # baseline: mark present
    margin = z_wm - z_clean

    rows = []
    for name, (fn, params) in STAGES.items():
        for p in params:
            out = fn(wm, p)
            z = detect_zscore(out, field)
            disruption = max(0.0, min(1.0, (z_wm - z) / (margin + 1e-9)))
            rows.append({
                "stage": name,
                "param": p,
                "z_after": round(z, 2),
                "disruption_pct": round(100 * disruption, 1),
                "psnr_db": round(psnr(wm, out), 2),
                "text_legibility": round(text_legibility(wm, out), 3),
            })
    return {
        "meta": {
            "size": size, "alpha": alpha,
            "z_clean": round(z_clean, 2), "z_watermarked": round(z_wm, 2),
            "detection_margin": round(margin, 2),
            "band": [BAND_LO, BAND_HI],
            # Absolute figures depend on the rendered font; record which one ran
            # so a differing table on another host is explainable, not "broken".
            "font": getattr(make_test_image, "font_used", "unknown"),
        },
        "results": rows,
    }


def print_table(out):
    m = out["meta"]
    print(f"# Synthetic proxy-oracle: z(clean)={m['z_clean']}  z(watermarked)={m['z_watermarked']}  "
          f"margin={m['detection_margin']}  band={m['band']}  font={m.get('font')}\n")
    hdr = f"{'stage':<18}{'param':>7}{'z_after':>9}{'disrupt%':>10}{'PSNR dB':>9}{'text_leg':>10}"
    print(hdr)
    print("-" * len(hdr))
    last = None
    for r in out["results"]:
        if last and last != r["stage"]:
            print()
        print(f"{r['stage']:<18}{r['param']:>7}{r['z_after']:>9}{r['disruption_pct']:>10}"
              f"{r['psnr_db']:>9}{r['text_legibility']:>10}")
        last = r["stage"]


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--size", type=int, default=512)
    ap.add_argument("--alpha", type=float, default=2.2, help="watermark embed strength")
    ap.add_argument("--json", action="store_true", help="emit JSON instead of a table")
    args = ap.parse_args()
    out = run(size=args.size, alpha=args.alpha)
    if args.json:
        json.dump(out, sys.stdout, indent=2)
        print()
    else:
        print_table(out)


if __name__ == "__main__":
    main()
