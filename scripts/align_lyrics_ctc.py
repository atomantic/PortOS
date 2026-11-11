#!/usr/bin/env python3
"""MMS_FA emissions + one owned CTC Viterbi pass, with garbage between lyric lines.

Only this CLI invocation loads/downloads weights. The checkpoint's bytes must
match MODEL_SHA256 before torch.load(weights_only=True) sees them. Input is
ffmpeg's 16 kHz mono PCM and a JSON array of word arrays; output keeps those
exact word slots. Nothing here uses torchaudio's forced_align or its bundle
downloader, so the caller can pin patched torch/torchaudio releases.
"""
import argparse
import hashlib
import json
import os
import sys
import tempfile
import unicodedata
import urllib.request
import wave
from collections import namedtuple

SAMPLE_RATE = 16000
HOP = 320
RECEPTIVE_FIELD = 400
CHUNK_FRAMES = 1000  # 20 s; bound transformer attention memory on long songs.
CONTEXT_FRAMES = 50

# torchaudio.pipelines.MMS_FA as defined in torchaudio 2.11.1, owned here so
# the weights pass through the digest gate. The digest was taken from the
# bytes of S3 object version dZWoHyjLHoCxDn.KL1FPSlVCD3CPRtOL
# (Last-Modified 2023-05-16) on 2026-11-10, in two separate downloads, without
# deserializing them. A different file at this URL is rejected, never loaded.
MODEL_URL = 'https://dl.fbaipublicfiles.com/mms/torchaudio/ctc_alignment_mling_uroman/model.pt'
MODEL_SHA256 = '20ef12963ab4924bef49ac4fc7f58ad5da2ee43b2c11bc8c853c9b90ecdbc680'
MODEL_BYTES = 1262047414
MODEL_PARAMS = {
    'extractor_mode': 'layer_norm',
    'extractor_conv_layer_config': [(512, 10, 5)] + [(512, 3, 2)] * 4 + [(512, 2, 2)] * 2,
    'extractor_conv_bias': True,
    'encoder_embed_dim': 1024,
    'encoder_projection_dropout': 0.0,
    'encoder_pos_conv_kernel': 128,
    'encoder_pos_conv_groups': 16,
    'encoder_num_layers': 24,
    'encoder_num_heads': 16,
    'encoder_attention_dropout': 0.0,
    'encoder_ff_interm_features': 4096,
    'encoder_ff_interm_dropout': 0.1,
    'encoder_dropout': 0.0,
    'encoder_layer_norm_first': True,
    'encoder_layer_drop': 0.1,
    'aux_num_out': 28,
}
# The fairseq head has 31 outputs; MMS_FA drops its unused dictionary rows 1-3.
AUX_ROWS_REMOVED = (1, 2, 3)
# Blank first; '*' is the zero (log 1) column appended after log-softmax.
LABELS = ('-', 'a', 'i', 'e', 'n', 'o', 'u', 't', 's', 'r', 'm', 'k', 'l', 'd', 'g', 'h', 'y', 'b',
          'p', 'w', 'c', 'v', 'j', 'z', 'f', "'", 'q', 'x', '*')
DICTIONARY = {label: index for index, label in enumerate(LABELS)}
BLANK = 0

TokenSpan = namedtuple('TokenSpan', 'token start end')


class CheckpointRejected(Exception):
    """The weights file does not match the pinned digest; it was not deserialized."""


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


def forced_align(log_probs, targets, blank=BLANK):
    """Most likely CTC path of `targets` through (frames, classes) log-probabilities.

    Returns one token id per frame. Each target is emitted in order; a blank may
    separate any two and must separate a repeated label, as in CTC.
    """
    import numpy as np

    emissions = np.asarray(log_probs, dtype=np.float64)
    frames = emissions.shape[0]
    if not targets or blank in targets or max(targets) >= emissions.shape[1]:
        raise ValueError('CTC targets must be non-empty, non-blank emission classes.')
    states = np.full(2 * len(targets) + 1, blank, dtype=np.int64)
    states[1::2] = targets
    # Label i may skip the blank before it unless it repeats label i - 1.
    labels = np.asarray(targets)
    skip = np.zeros(len(states), dtype=bool)
    skip[3::2] = labels[1:] != labels[:-1]
    columns = np.arange(len(states))
    alpha = np.full(len(states), -np.inf)
    alpha[:2] = emissions[0, states[:2]]
    # 0 = stay, 1 = from the previous state, 2 = skipped a blank.
    back = np.zeros((frames, len(states)), dtype=np.int8)
    for t in range(1, frames):
        advance = np.concatenate(([-np.inf], alpha[:-1]))
        jump = np.where(skip, np.concatenate(([-np.inf, -np.inf], alpha[:-2])), -np.inf)
        candidates = np.stack((alpha, advance, jump))
        back[t] = candidates.argmax(axis=0)
        alpha = candidates[back[t], columns] + emissions[t, states]
    state = len(states) - 1 if alpha[-1] > alpha[-2] else len(states) - 2
    if not np.isfinite(alpha[state]):
        raise AudioTooShort()
    path = np.empty(frames, dtype=np.int64)
    for t in range(frames - 1, -1, -1):
        path[t] = states[state]
        # int(): NumPy 2 would keep `state` int8 and overflow past 127 states.
        state -= int(back[t, state])
    return path


def merge_tokens(path, blank=BLANK):
    """Collapse a frame path into non-blank runs; `end` is exclusive."""
    spans, start = [], 0
    for t in range(1, len(path) + 1):
        if t == len(path) or path[t] != path[start]:
            if path[start] != blank:
                spans.append(TokenSpan(int(path[start]), start, t))
            start = t
    return spans


def emissions_for_audio(model, waveform, torch, device):
    # Every inference crop starts on the encoder's global 320-sample grid.
    # Keep only owned frames, with 1 s of context on each side. Concatenation
    # preserves the song clock; alignment itself is never split into windows.
    frame_count = (waveform.shape[-1] - RECEPTIVE_FIELD) // HOP + 1
    if frame_count <= 0:
        raise AudioTooShort()
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


def _open_if_genuine(path, sha256):
    """An open handle to `path` when its exact bytes match; the caller loads this handle."""
    try:
        handle = open(path, 'rb')
    except OSError:
        return None
    digest = hashlib.sha256()
    for block in iter(lambda: handle.read(1 << 20), b''):
        digest.update(block)
    if digest.hexdigest() == sha256:
        handle.seek(0)
        return handle
    handle.close()
    return None


def _cache_if_genuine(source, model_dir, target, sha256, size, report=False):
    """Copy `source` into the private cache while hashing it; publish only genuine bytes."""
    os.makedirs(model_dir, exist_ok=True)
    fd, partial = tempfile.mkstemp(dir=model_dir, suffix='.partial')
    try:
        digest, received, reported = hashlib.sha256(), 0, -1
        with os.fdopen(fd, 'wb') as output, source:
            for block in iter(lambda: source.read(1 << 20), b''):
                received += len(block)
                if received > size:
                    return False
                digest.update(block)
                output.write(block)
                percent = received * 100 // size
                if report and percent != reported:
                    reported = percent
                    print(f'PROGRESS:downloading-model:{percent}', flush=True)
        if digest.hexdigest() != sha256:
            return False
        try:
            os.replace(partial, target)
        except OSError:
            pass  # Windows: a concurrent publisher may hold the target open; the caller re-verifies it.
        return True
    finally:
        if os.path.exists(partial):
            os.remove(partial)


def open_verified_checkpoint(model_dir, legacy=(), *, url=MODEL_URL, sha256=MODEL_SHA256, size=MODEL_BYTES,
                             fetch=urllib.request.urlopen):
    """Return a handle to genuine checkpoint bytes in the private cache. Nothing is deserialized.

    A genuine legacy file (another tool's shared cache) is copied in rather than
    loaded in place; otherwise the file is downloaded. A download that fails
    the digest is discarded and raises CheckpointRejected.
    """
    target = os.path.join(model_dir, f'mms_fa-{sha256[:16]}.pt')
    handle = _open_if_genuine(target, sha256)
    if handle:
        return handle
    for path in legacy:
        try:
            source = open(path, 'rb')
        except OSError:
            continue
        if _cache_if_genuine(source, model_dir, target, sha256, size):
            break
    else:
        if not _cache_if_genuine(fetch(url, timeout=60), model_dir, target, sha256, size, report=True):
            raise CheckpointRejected('MMS_FA checkpoint does not match the pinned digest.')
    handle = _open_if_genuine(target, sha256)
    if not handle:
        raise CheckpointRejected('MMS_FA checkpoint changed after it was cached.')
    return handle


def load_mms_fa(handle, torch, torchaudio):
    with handle:
        state = torch.load(handle, map_location='cpu', weights_only=True)
    for key in ('aux.weight', 'aux.bias'):
        state[key] = torch.stack([row for index, row in enumerate(state[key]) if index not in AUX_ROWS_REMOVED])
    model = torchaudio.models.wav2vec2_model(**MODEL_PARAMS)
    model.load_state_dict(state)
    return model.eval()


def mms_fa_emitter(model, torch):
    # torchaudio's MMS_FA wrapper: per-crop waveform layer norm, log-softmax,
    # then a zero star column so '*' can absorb anything.
    def emit(crop):
        logits, _ = model(torch.nn.functional.layer_norm(crop, crop.shape))
        log_probs = torch.nn.functional.log_softmax(logits, dim=-1)
        star = torch.zeros((*log_probs.shape[:-1], 1), dtype=log_probs.dtype, device=log_probs.device)
        return torch.cat((log_probs, star), dim=-1), None
    return emit


def align(audio, lines, model_dir):
    import torch
    import torchaudio

    with wave.open(audio, 'rb') as source:
        if source.getframerate() != SAMPLE_RATE or source.getnchannels() != 1 or source.getsampwidth() != 2:
            raise ValueError('Expected 16 kHz mono PCM16 WAV.')
        waveform = torch.frombuffer(bytearray(source.readframes(source.getnframes())), dtype=torch.int16)
        waveform = waveform.to(torch.float32).unsqueeze(0) / 32768
    tokens, slots = targets_for_lines(lines, DICTIONARY)
    # CPU is the portable default; CUDA when present. The Viterbi pass runs on
    # CPU after bounded inference.
    device = 'cuda' if torch.cuda.is_available() else 'cpu'
    print('PROGRESS:loading-model', flush=True)
    # Earlier releases cached this file through torch.hub; reuse it only if genuine.
    legacy = os.path.join(torch.hub.get_dir(), 'checkpoints', 'model.pt')
    model = load_mms_fa(open_verified_checkpoint(model_dir, (legacy,)), torch, torchaudio).to(device)
    with torch.inference_mode():
        emission = emissions_for_audio(mms_fa_emitter(model, torch), waveform, torch, device)
    print('PROGRESS:aligning', flush=True)
    spans = merge_tokens(forced_align(emission[0].numpy(), tokens))
    if [span.token for span in spans] != tokens:
        raise ValueError('CTC alignment did not preserve the transcript.')
    return word_times(lines, slots, spans, HOP / SAMPLE_RATE)


class AudioTooShort(ValueError):
    """The audio window cannot contain the requested CTC alignment."""


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--audio', required=True)
    parser.add_argument('--lyrics', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--model-dir', required=True)
    args = parser.parse_args()
    with open(args.lyrics, encoding='utf-8') as source:
        lines = json.load(source)
    result = align(args.audio, lines, args.model_dir)
    with open(args.output, 'w', encoding='utf-8') as output:
        json.dump(result, output, ensure_ascii=False)


def cli():
    try:
        main()
    except CheckpointRejected:
        print('ERROR:checkpoint-rejected', flush=True)
        print('MMS_FA checkpoint failed its integrity check and was not loaded.', file=sys.stderr)
        sys.exit(1)
    except AudioTooShort:
        print('ERROR:audio-too-short', flush=True)
        sys.exit(1)
    except Exception:
        # Never print the transcript, project paths, or a private traceback.
        print('MMS_FA alignment failed; check runtime, lyric alphabet and audio.', file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    cli()
