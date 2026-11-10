#!/usr/bin/env python3
"""Real-checkpoint accuracy check of align_lyrics_ctc.align() on a synthetic vocal.

Opt-in; CI never runs it. It loads the 1.2 GB MMS_FA checkpoint through the
production digest gate (downloaded into --model-dir on first use). Run it with
the lyric-align venv's interpreter, which the app builds on first alignment:

  ~/.portos/venvs/lyric-align/bin/python scripts/align_lyrics_ctc_accuracy.py \
    --model-dir ~/.portos/venvs/lyric-align-models

(Windows: Scripts\\python.exe.) The vocal is one TTS clip per word (espeak-ng,
espeak or macOS `say`), placed at known sample offsets over a synthetic chord
bed with an instrumental intro and gaps between lines, so the reference word
timings are exact and no recorded or copyrighted audio is involved.

When the installed torchaudio still ships its MMS_FA bundle and forced_align,
the same fixture also runs through that previous path (bundle model, library
Viterbi and token merge) on the same verified checkpoint, so the two can be
compared word for word. Exit 0 only when every word keeps its slot and lands on
its own spoken occurrence, onsets are within tolerance, and they are no worse
than the previous path. CTC character spans are peaky, so a word's end lands
early in its decay tail (or a silent final letter drifts into the gap after
it); end error is reported, not gated.
"""
import argparse
import json
import math
import os
import platform
import shutil
import statistics
import subprocess
import sys
import tempfile
import wave

from align_lyrics_ctc import (DICTIONARY, HOP, SAMPLE_RATE, align, emissions_for_audio,
                              open_verified_checkpoint, targets_for_lines, word_times)

# Repeated words, a repeated word run and a repeated line check that each
# occurrence keeps its own slot. The fixture runs past 20 s, so emissions cross
# a CHUNK_FRAMES seam as on a real song.
LINES = [['Hello,', 'world'], ['the', 'quick', 'brown', 'fox'], ['jumps', 'over', 'the', 'lazy', 'dog'],
         ['oh', 'oh', 'oh'], ['bright', 'morning', 'river'], ['sing', 'it', 'again'], ['hello', 'world']]
INTRO_SEC = 2.0
WORD_GAP_SEC = 0.12
LINE_GAP_SEC = 1.5
OUTRO_SEC = 1.0
BED_DB = -18.0  # Chord bed level relative to the vocal's RMS.
# A word is active from its first to last 10 ms window above this fraction of
# the clip's loudest window; TTS clips are padded with digital silence.
ACTIVE_FRACTION = 0.01
FRAME_SEC = HOP / SAMPLE_RATE


def find_engine(requested):
    names = [requested] if requested else ['espeak-ng', 'espeak', 'say']
    for name in names:
        path = shutil.which(name)
        if path:
            return name, path
    raise SystemExit(f'No TTS engine found (tried {", ".join(names)}).')


def synthesize(engine, binary, word, path):
    if engine == 'say':
        command = [binary, '-o', path, '--file-format=WAVE', f'--data-format=LEI16@{SAMPLE_RATE}', word]
    else:
        command = [binary, '-v', 'en-us', '-s', '150', '-w', path, word]
    subprocess.run(command, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def read_clip(path, torch, torchaudio):
    with wave.open(path, 'rb') as source:
        if source.getsampwidth() != 2:
            raise SystemExit('TTS output must be 16-bit PCM.')
        channels, rate = source.getnchannels(), source.getframerate()
        pcm = torch.frombuffer(bytearray(source.readframes(source.getnframes())), dtype=torch.int16)
    samples = pcm.to(torch.float32).reshape(-1, channels).mean(dim=1) / 32768
    if rate != SAMPLE_RATE:
        samples = torchaudio.functional.resample(samples, rate, SAMPLE_RATE)
    window = SAMPLE_RATE // 100
    usable = samples[:len(samples) // window * window]
    rms = usable.reshape(-1, window).pow(2).mean(dim=1).sqrt()
    active = (rms >= rms.max() * ACTIVE_FRACTION).nonzero().flatten()
    if len(active) == 0:
        raise SystemExit('TTS produced a silent clip.')
    return usable[int(active[0]) * window:(int(active[-1]) + 1) * window]


def chord_bed(length, torch):
    # Two bars per chord at 120 bpm (Am F C G), each note with two harmonics and
    # a per-beat decay, so the bed is tonal, rhythmic and never silent.
    t = torch.arange(length, dtype=torch.float64) / SAMPLE_RATE
    chords = [(220.0, 261.63, 329.63), (174.61, 220.0, 261.63), (261.63, 329.63, 392.0), (196.0, 246.94, 293.66)]
    chord = (t // 4).long() % len(chords)
    envelope = torch.exp(-3 * (t % 0.5))
    bed = torch.zeros(length, dtype=torch.float64)
    for index, notes in enumerate(chords):
        tone = sum(torch.sin(2 * math.pi * f * h * t) / h for f in notes for h in (1, 2, 3))
        bed += torch.where(chord == index, tone, torch.zeros_like(tone))
    return (bed * envelope).to(torch.float32)


def build_fixture(engine, binary, scratch, torch, torchaudio):
    clips = []
    for line_index, line in enumerate(LINES):
        for word_index, word in enumerate(line):
            path = os.path.join(scratch, f'word-{line_index}-{word_index}.wav')
            synthesize(engine, binary, word.strip(',.!?').lower(), path)
            clips.append(read_clip(path, torch, torchaudio))
    reference, placements, cursor, clip = [], [], round(INTRO_SEC * SAMPLE_RATE), iter(clips)
    for line_index, line in enumerate(LINES):
        words = []
        for word_index, word in enumerate(line):
            samples = next(clip)
            placements.append((cursor, samples))
            words.append({'w': word, 'startSec': cursor / SAMPLE_RATE, 'endSec': (cursor + len(samples)) / SAMPLE_RATE})
            cursor += len(samples) + round((WORD_GAP_SEC if word_index < len(line) - 1 else LINE_GAP_SEC) * SAMPLE_RATE)
        reference.append(words)
    length = cursor - round(LINE_GAP_SEC * SAMPLE_RATE) + round(OUTRO_SEC * SAMPLE_RATE)
    vocal = torch.zeros(length)
    for start, samples in placements:
        vocal[start:start + len(samples)] += samples
    voiced = torch.cat([samples for _, samples in placements])
    bed = chord_bed(length, torch)
    bed *= voiced.pow(2).mean().sqrt() / bed.pow(2).mean().sqrt() * 10 ** (BED_DB / 20)
    mix = vocal + bed
    mix *= 0.9 / mix.abs().max()
    path = os.path.join(scratch, 'fixture.wav')
    with wave.open(path, 'wb') as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(SAMPLE_RATE)
        output.writeframes((mix * 32767).round().to(torch.int16).numpy().tobytes())
    return path, reference, length / SAMPLE_RATE


def previous_path(audio, lines, model_dir, torch, torchaudio):
    """Words from the pre-#15652 pipeline (torchaudio's MMS_FA bundle, forced_align, merge_tokens) on this runtime."""
    bundle = getattr(torchaudio.pipelines, 'MMS_FA', None)
    if bundle is None or not callable(getattr(torchaudio.functional, 'forced_align', None)):
        return None
    if bundle.get_dict() != DICTIONARY:
        raise SystemExit('torchaudio MMS_FA labels differ from align_lyrics_ctc.LABELS.')
    # The bundle loads <model_dir>/model.pt; link it to the verified file so the
    # bundle never downloads or reads unverified bytes.
    with open_verified_checkpoint(model_dir) as verified:
        checkpoint = verified.name
    with tempfile.TemporaryDirectory(dir=model_dir) as bundle_dir:
        os.link(checkpoint, os.path.join(bundle_dir, 'model.pt'))
        model = bundle.get_model(dl_kwargs={'model_dir': bundle_dir, 'progress': False})
    with wave.open(audio, 'rb') as source:
        pcm = torch.frombuffer(bytearray(source.readframes(source.getnframes())), dtype=torch.int16)
    waveform = pcm.to(torch.float32).unsqueeze(0) / 32768
    tokens, slots = targets_for_lines(lines, DICTIONARY)
    with torch.inference_mode():
        emission = emissions_for_audio(model, waveform, torch, 'cpu')
        path, scores = torchaudio.functional.forced_align(emission, torch.tensor([tokens]), blank=0)
        spans = torchaudio.functional.merge_tokens(path[0], scores[0].exp())
    if [span.token for span in spans] != tokens:
        return []
    return word_times(lines, slots, spans, HOP / SAMPLE_RATE)


def score(reference, aligned, duration):
    flat_ref = [word for line in reference for word in line]
    flat_got = [word for line in aligned for word in line]
    shape_ok = [len(line) for line in aligned] == [len(line) for line in reference]
    slots_ok = shape_ok and [w['w'] for w in flat_got] == [w['w'] for w in flat_ref]
    clock_ok = all(0 <= a['startSec'] < a['endSec'] <= duration + 0.001 for a in flat_got) and all(
        previous['endSec'] <= current['startSec'] for previous, current in zip(flat_got, flat_got[1:]))
    rows = [{'w': ref['w'], 'refStart': round(ref['startSec'], 3), 'refEnd': round(ref['endSec'], 3),
             'startSec': got['startSec'], 'endSec': got['endSec'],
             'startErr': round(got['startSec'] - ref['startSec'], 3), 'endErr': round(got['endSec'] - ref['endSec'], 3),
             # Reference words are disjoint, so a centred span is on its own occurrence.
             'ownOccurrence': ref['startSec'] <= (got['startSec'] + got['endSec']) / 2 <= ref['endSec']}
            for ref, got in zip(flat_ref, flat_got)] if slots_ok else []
    return slots_ok, clock_ok, rows


def summarize(rows, key):
    errors = [abs(row[key]) for row in rows]
    return {'median': round(statistics.median(errors), 3), 'max': round(max(errors), 3)} if errors else None


def main():
    parser = argparse.ArgumentParser(description=__doc__.split('\n', 1)[0])
    parser.add_argument('--model-dir', required=True, help='MMS_FA checkpoint cache (production: <venv>-models).')
    parser.add_argument('--engine', choices=['espeak-ng', 'espeak', 'say'], help='TTS engine; default: first found.')
    parser.add_argument('--max-start-error', type=float, default=0.2, help='Seconds; every word must start within it.')
    parser.add_argument('--max-median-error', type=float, default=0.05,
                        help='Seconds; the median start error must be within it.')
    parser.add_argument('--report', help='Write the JSON report here as well.')
    args = parser.parse_args()

    import torch
    import torchaudio

    engine, binary = find_engine(args.engine)
    with tempfile.TemporaryDirectory(prefix='portos-ctc-accuracy-') as scratch:
        audio, reference, duration = build_fixture(engine, binary, scratch, torch, torchaudio)
        lines = [[word['w'] for word in line] for line in reference]
        aligned = align(audio, lines, args.model_dir)
        previous = previous_path(audio, lines, args.model_dir, torch, torchaudio)
    slots_ok, clock_ok, rows = score(reference, aligned, duration)
    start, end = summarize(rows, 'startErr'), summarize(rows, 'endErr')
    checks = {
        'everyWordKeepsItsSlot': slots_ok,
        'songClockMonotonicAndInRange': clock_ok,
        'everyWordOnItsOwnOccurrence': bool(rows) and all(row['ownOccurrence'] for row in rows),
        'maxStartError': bool(start) and start['max'] <= args.max_start_error,
        'medianStartError': bool(start) and start['median'] <= args.max_median_error,
    }
    comparison = None
    if previous is not None:
        _, _, previous_rows = score(reference, previous, duration)
        previous_start = summarize(previous_rows, 'startErr')
        drift = [abs(a[key] - b[key]) for a, b in zip(rows, previous_rows) for key in ('startSec', 'endSec')]
        comparison = {'startError': previous_start, 'endError': summarize(previous_rows, 'endErr'),
                      'maxWordTimeDifference': round(max(drift), 3) if drift and previous_rows else None}
        # One 20 ms frame of slack: the owned emitter may round differently from the bundle's.
        checks['noWorseThanPreviousPath'] = bool(previous_start and start) and all(
            start[key] <= previous_start[key] + FRAME_SEC + 1e-9 for key in ('median', 'max'))
    report = {
        'runtime': {'python': platform.python_version(), 'machine': platform.machine(), 'system': platform.system(),
                    'torch': torch.__version__, 'torchaudio': torchaudio.__version__, 'tts': engine},
        'fixtureSec': round(duration, 3), 'words': len(rows), 'startError': start, 'endError': end,
        'previousPath': comparison or 'unavailable in this torchaudio',
        'checks': checks, 'passed': all(checks.values()), 'rows': rows,
    }
    for row in rows:
        print(f"{row['w']:>8}  ref {row['refStart']:7.3f}-{row['refEnd']:7.3f}  got {row['startSec']:7.3f}-"
              f"{row['endSec']:7.3f}  err {row['startErr']:+.3f}/{row['endErr']:+.3f}")
    print(json.dumps({key: value for key, value in report.items() if key != 'rows'}, indent=2))
    if args.report:
        with open(args.report, 'w', encoding='utf-8') as output:
            json.dump(report, output, indent=2)
    sys.exit(0 if report['passed'] else 1)


if __name__ == '__main__':
    main()
