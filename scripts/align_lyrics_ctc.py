#!/usr/bin/env python3
"""MMS_FA emissions + one CTC Viterbi pass, with garbage between lyric lines.

Only this CLI invocation loads/downloads weights. Input is ffmpeg's 16 kHz
mono PCM and a JSON array of word arrays; output keeps those exact word slots.
Torchaudio 2.8 is pinned by the caller because 2.9 removed forced_align.
"""
import argparse
import json
import sys
import unicodedata
import wave

SAMPLE_RATE = 16000
HOP = 320
RECEPTIVE_FIELD = 400
CHUNK_FRAMES = 1000  # 20 s; bound transformer attention memory on long songs.
CONTEXT_FRAMES = 50


def targets_for_lines(lines, dictionary):
    tokens = [dictionary['*']]
    slots = []
    for line in lines:
        for word in line:
            normalized = ''.join(c for c in unicodedata.normalize('NFKD', word.lower())
                                 if not unicodedata.combining(c))
            chars = [c for c in normalized if c.isalpha() or c.isdigit()]
            if not chars or any(c not in dictionary for c in chars):
                raise ValueError('Spell lyric numbers out and use MMS_FA supported letters.')
            start = len(tokens)
            tokens.extend(dictionary[c] for c in chars)
            slots.append((start, len(tokens), word))
        # A star may absorb silence, instrumental gaps, or untranscribed vocals.
        if tokens[-1] != dictionary['*']:
            tokens.append(dictionary['*'])
    if not slots:
        raise ValueError('No lyric words to align.')
    return tokens, slots


def word_times(lines, slots, spans, frame_sec):
    words = []
    for start, end, original in slots:
        words.append({'w': original, 'startSec': round(spans[start].start * frame_sec, 3),
                      'endSec': round(spans[end - 1].end * frame_sec, 3)})
    result, cursor = [], 0
    for line in lines:
        result.append(words[cursor:cursor + len(line)])
        cursor += len(line)
    return result


def emissions_for_audio(model, waveform, torch, device):
    # Every inference crop starts on the encoder's global 320-sample grid.
    # Keep only owned frames, with 1 s of context on each side. Concatenation
    # preserves the song clock; alignment itself is never split into windows.
    frame_count = (waveform.shape[-1] - RECEPTIVE_FIELD) // HOP + 1
    if frame_count <= 0:
        raise ValueError('The vocal is too short to align.')
    chunks = []
    for first in range(0, frame_count, CHUNK_FRAMES):
        last = min(frame_count, first + CHUNK_FRAMES)
        left = max(0, first - CONTEXT_FRAMES)
        right = min(frame_count, last + CONTEXT_FRAMES)
        crop = waveform[:, left * HOP:(right - 1) * HOP + RECEPTIVE_FIELD]
        emission, _ = model(crop.to(device))
        chunks.append(emission[:, first - left:last - left].cpu())
        print(f'PROGRESS:emissions:{round(last / frame_count * 100)}', flush=True)
    return torch.cat(chunks, dim=1)


def align(audio, lines):
    import torch
    import torchaudio
    from torchaudio import functional as F

    with wave.open(audio, 'rb') as source:
        if source.getframerate() != SAMPLE_RATE or source.getnchannels() != 1 or source.getsampwidth() != 2:
            raise ValueError('Expected 16 kHz mono PCM16 WAV.')
        waveform = torch.frombuffer(bytearray(source.readframes(source.getnframes())), dtype=torch.int16)
        waveform = waveform.to(torch.float32).unsqueeze(0) / 32768
    bundle = torchaudio.pipelines.MMS_FA
    dictionary = bundle.get_dict()
    tokens, slots = targets_for_lines(lines, dictionary)
    # CPU is the portable default; CUDA when present. forced_align runs on CPU
    # after bounded inference, so unsupported accelerator alignment is avoided.
    device = 'cuda' if torch.cuda.is_available() else 'cpu'
    print('PROGRESS:loading-model', flush=True)
    model = bundle.get_model().to(device).eval()
    with torch.inference_mode():
        emission = emissions_for_audio(model, waveform, torch, device)
        print('PROGRESS:aligning', flush=True)
        targets = torch.tensor([tokens], dtype=torch.int64)
        path, scores = F.forced_align(emission, targets, blank=0)
        spans = F.merge_tokens(path[0], scores[0].exp())
    if [span.token for span in spans] != tokens:
        raise ValueError('CTC alignment did not preserve the transcript.')
    return word_times(lines, slots, spans, HOP / SAMPLE_RATE)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--audio', required=True)
    parser.add_argument('--lyrics', required=True)
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    with open(args.lyrics, encoding='utf-8') as source:
        lines = json.load(source)
    result = align(args.audio, lines)
    with open(args.output, 'w', encoding='utf-8') as output:
        json.dump(result, output, ensure_ascii=False)


if __name__ == '__main__':
    try:
        main()
    except Exception:
        # Never print the transcript, project paths, or a private traceback.
        print('MMS_FA alignment failed; check runtime, lyric alphabet and audio.', file=sys.stderr)
        sys.exit(1)
