"""Timing helpers for PortOS Blender films. Standard library only."""

import math


def clamp(value, low=0.0, high=1.0):
    return max(low, min(high, value))


def remap(value, in_low, in_high, out_low=0.0, out_high=1.0, clamped=True):
    """Map `value` from one range onto another."""
    if in_high == in_low:
        return out_low
    mix = (value - in_low) / (in_high - in_low)
    if clamped:
        mix = clamp(mix)
    return out_low + (out_high - out_low) * mix


def ease(value, kind="in_out", power=2.0):
    """Ease a 0..1 value. `kind`: linear, in, out, in_out, smooth (smoothstep) or back (a small overshoot)."""
    x = clamp(value)
    if kind == "linear":
        return x
    if kind == "in":
        return x ** power
    if kind == "out":
        return 1.0 - (1.0 - x) ** power
    if kind == "smooth":
        return x * x * (3.0 - 2.0 * x)
    if kind == "back":
        overshoot = 1.70158
        y = x - 1.0
        return 1.0 + (overshoot + 1.0) * y ** 3 + overshoot * y ** 2
    if x < 0.5:
        return 0.5 * (2.0 * x) ** power
    return 1.0 - 0.5 * (2.0 * (1.0 - x)) ** power


def stepped(t, fps, on=2):
    """Hold time on every `on`-th frame: `stepped(t, 24, 2)` animates on twos."""
    hold = max(1, int(on)) / float(fps)
    return math.floor(t / hold + 1e-6) * hold
