"""Song helpers for PortOS Blender films.

Every function takes the `song` dict a film receives as `ctx.song` (the
contents of song.json) and returns plain Python values. Times are seconds on
the song. Standard library only, so a film can use these outside Blender too.
"""

from bisect import bisect_left, bisect_right
from math import ceil, floor
from statistics import median


def _analysis(song):
    return (song or {}).get("analysis") or {}


def beats(song):
    """Beat times in seconds."""
    return list(_analysis(song).get("beats") or [])


def downbeats(song):
    """Bar-start times in seconds."""
    return list(_analysis(song).get("downbeats") or [])


def _bar_length(song):
    grid = downbeats(song)
    lengths = [b - a for a, b in zip(grid, grid[1:]) if b > a]
    if lengths:
        return float(median(lengths))
    beat_grid = beats(song)
    beat_lengths = [b - a for a, b in zip(beat_grid, beat_grid[1:]) if b > a]
    if beat_lengths:
        return float(median(beat_lengths) * 4)
    bpm = (_analysis(song).get("bpm") or 0)
    return 240.0 / bpm if bpm > 0 else 2.0


def bar_time(song, bar, beat=0.0):
    """Song time at a 1-based bar and beat offset, extrapolating the bar grid."""
    grid = downbeats(song)
    if not grid:
        return 0.0
    length = _bar_length(song)
    index = int(bar) - 1
    if index < 0:
        start = float(grid[0]) + index * length
        bar_length = length
    elif index < len(grid):
        start = float(grid[index])
        bar_length = float(grid[index + 1] - grid[index]) if index + 1 < len(grid) else length
    else:
        start = float(grid[-1]) + (index - len(grid) + 1) * length
        bar_length = length
    return start + beat * (bar_length / 4.0)


def bar_at(song, t):
    """Return ``(1-based bar, beat offset)`` at ``t``; an absent grid is bar 1."""
    grid = downbeats(song)
    if not grid:
        return 1, 0.0
    length = _bar_length(song)
    time = float(t)
    if time < grid[0]:
        offset = (time - float(grid[0])) / length
        bar_offset = int(offset // 1)
        return bar_offset + 1, (offset - bar_offset) * 4.0
    if time >= grid[-1]:
        offset = (time - float(grid[-1])) / length
        bar_offset = int(offset // 1)
        return len(grid) + bar_offset, (offset - bar_offset) * 4.0
    index = bisect_right(grid, time) - 1
    start = float(grid[index])
    bar_length = float(grid[index + 1] - grid[index])
    return index + 1, max(0.0, min(4.0, (time - start) / bar_length * 4.0))


def phrases(song, bars=4):
    """Consecutive ``bars``-bar time ranges from the first downbeat to song end."""
    grid = downbeats(song)
    if not grid or bars <= 0:
        return []
    duration = (song or {}).get("durationSec")
    if duration is None:
        duration = grid[-1] + _bar_length(song)
    result = []
    span = int(bars)
    start_bar = 1
    start = float(grid[0])
    while start < duration:
        end = min(bar_time(song, start_bar + span), duration)
        if end > start:
            result.append((start, end))
        start_bar += span
        start = bar_time(song, start_bar)
    return result


def sections(song):
    """Song sections: dicts with `label`, `startSec`, `endSec`, `energy`."""
    return list(_analysis(song).get("sections") or [])


def section_at(song, t):
    """The section playing at `t`, or None."""
    for section in sections(song):
        if section.get("startSec", 0) <= t < section.get("endSec", 0):
            return section
    return None


def nearest_beat(song, t):
    """The beat time closest to `t`, or None when the song has no beat grid."""
    grid = beats(song)
    if not grid:
        return None
    at = bisect_left(grid, t)
    around = grid[max(0, at - 1):at + 1]
    return min(around, key=lambda beat: abs(beat - t))


def beats_between(song, a, b):
    """Beat times in `[a, b)`."""
    grid = beats(song)
    return grid[bisect_left(grid, a):bisect_left(grid, b)]


def beat_phase(song, t):
    """`(index, phase)`: the last beat at or before `t` and how far to the next one (0..1)."""
    grid = beats(song)
    if not grid:
        return 0, 0.0
    index = bisect_right(grid, t) - 1
    if index < 0:
        return 0, 0.0
    start = grid[index]
    end = grid[index + 1] if index + 1 < len(grid) else start + (start - grid[index - 1] if index else 0.5)
    span = max(1e-6, end - start)
    return index, max(0.0, min(1.0, (t - start) / span))


def pulse(song, t, decay=4.0):
    """1 on each beat, falling toward 0 before the next: a hit to drive a light or a scale."""
    if not beats(song):
        return 0.0
    _, phase = beat_phase(song, t)
    return (1.0 - phase) ** decay


def cue_words(song, cue_index):
    """The timed words of one lyric line: dicts with `w`, `startSec`, `endSec`."""
    cues = ((song or {}).get("lyrics") or {}).get("cues") or []
    if cue_index < 0 or cue_index >= len(cues):
        return []
    return list(cues[cue_index].get("words") or [])


def words_between(song, a, b):
    """Every timed word starting in `[a, b)`, in song order, each with its line's `cue` index."""
    found = []
    for cue in ((song or {}).get("lyrics") or {}).get("cues") or []:
        for word in cue.get("words") or []:
            start = word.get("startSec")
            if start is not None and a <= start < b:
                found.append({**word, "cue": cue.get("index")})
    return sorted(found, key=lambda word: word["startSec"])


def envelope(song, band, t):
    """Loudness of `band` (`rms`, `low`, `mid` or `high`) at `t`, 0..1, interpolated between analysis frames."""
    features = _analysis(song).get("features") or {}
    envelopes = features.get("envelopes") or {}
    values = envelopes.get(band) or []
    rate = envelopes.get("fps") or 0
    if not values or rate <= 0:
        return 0.0
    position = max(0.0, t * rate)
    index = int(position)
    if index >= len(values) - 1:
        return float(values[-1])
    mix = position - index
    return float(values[index]) * (1.0 - mix) + float(values[index + 1]) * mix


def onsets(song, band="low", min_gap=0.12, sensitivity=1.5):
    """Times of spaced local peaks in positive envelope change above median + sensitivity*MAD."""
    env = ((_analysis(song).get("features") or {}).get("envelopes") or {})
    values = env.get(band) or []
    rate = env.get("fps") or 0
    if len(values) < 3 or rate <= 0:
        return []
    rises = [max(0.0, float(b) - float(a)) for a, b in zip(values, values[1:])]
    center = median(rises)
    mad = median([abs(value - center) for value in rises])
    threshold = center + max(0.0, sensitivity) * mad
    peaks = []
    for index, value in enumerate(rises):
        if (value > threshold
                and (index == 0 or value >= rises[index - 1])
                and (index + 1 == len(rises) or value > rises[index + 1])):
            peaks.append((value, (index + 1) / rate))
    selected = []
    for _, time in sorted(peaks, key=lambda peak: (-peak[0], peak[1])):
        if all(abs(time - kept) >= max(0.0, min_gap) for kept in selected):
            selected.append(time)
    return sorted(selected)


def swell(song, band, t, window=2.0):
    """Mean band envelope in a window centred on ``t``; empty analysis returns zero."""
    env = ((_analysis(song).get("features") or {}).get("envelopes") or {})
    values = env.get(band) or []
    rate = env.get("fps") or 0
    if not values or rate <= 0 or window <= 0:
        return 0.0
    first = max(0, ceil((t - window / 2) * rate - 1e-9))
    last = min(len(values), floor((t + window / 2) * rate + 1e-9) + 1)
    if first >= last:
        return 0.0
    return sum(float(value) for value in values[first:last]) / (last - first)
