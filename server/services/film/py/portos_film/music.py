"""Song helpers for PortOS Blender films.

Every function takes the `song` dict a film receives as `ctx.song` (the
contents of song.json) and returns plain Python values. Times are seconds on
the song. Standard library only, so a film can use these outside Blender too.
"""

from bisect import bisect_left, bisect_right


def _analysis(song):
    return (song or {}).get("analysis") or {}


def beats(song):
    """Beat times in seconds."""
    return list(_analysis(song).get("beats") or [])


def downbeats(song):
    """Bar-start times in seconds."""
    return list(_analysis(song).get("downbeats") or [])


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
