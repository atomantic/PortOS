"""Checks of the production CTC transcript, timebase, Viterbi and checkpoint gate.

Nothing here downloads a model or imports torch. The Viterbi cases need numpy
and are skipped without it; scripts/align_lyrics_ctc.test.js runs them with a
numpy-capable interpreter when one exists.
"""
import hashlib
import io
import itertools
import math
import os
import random
import tempfile
import unittest
from types import SimpleNamespace
from align_lyrics_ctc import (targets_for_lines, word_times, emissions_for_audio, forced_align, merge_tokens,
                              open_verified_checkpoint, load_mms_fa, CheckpointRejected, DICTIONARY, HOP,
                              RECEPTIVE_FIELD, AUX_ROWS_REMOVED)

try:
    import numpy
except ImportError:
    numpy = None


class Tensor:
    def __init__(self, start, frames):
        self.start, self.frames = start, frames
        self.shape = (1, frames)

    def __getitem__(self, key):
        crop = key[1]
        return Tensor(self.start + crop.start, crop.stop - crop.start)

    def to(self, device):
        return self

    def cpu(self):
        return self


class CtcContract(unittest.TestCase):
    def test_garbage_and_slots_preserve_punctuation_accents_repeated_letters_and_occurrences(self):
        dictionary = {char: i for i, char in enumerate('-*abcdefghijklmnopqrstuvwxyz')}
        lines = [['Hello,', 'café!'], ['Hello,'], []]
        targets, slots = targets_for_lines(lines, dictionary)
        self.assertEqual([i for i, token in enumerate(targets) if token == dictionary['*']], [0, 10, 16])
        self.assertEqual([word for _, _, word in slots], ['Hello,', 'café!', 'Hello,'])
        spans = [SimpleNamespace(start=i * 3, end=i * 3 + 2) for i in range(len(targets))]
        result = word_times(lines, slots, spans, 0.02)
        self.assertEqual(result[0][0], {'w': 'Hello,', 'startSec': 0.06, 'endSec': 0.34})
        self.assertEqual(result[1][0]['startSec'], 0.66)
        self.assertEqual(result[2], [])
        with self.assertRaises(ValueError):
            targets_for_lines([['123']], dictionary)

    def test_emission_chunks_keep_every_global_frame_once_across_context_seams(self):
        frames = 2055
        waveform = Tensor(0, (frames - 1) * HOP + RECEPTIVE_FIELD)
        def model(crop):
            self.assertEqual(crop.start % HOP, 0)
            return Tensor(crop.start // HOP, (crop.frames - RECEPTIVE_FIELD) // HOP + 1), None
        class Torch:
            @staticmethod
            def cat(chunks, dim):
                return [chunk.start + i for chunk in chunks for i in range(chunk.frames)]
        self.assertEqual(emissions_for_audio(model, waveform, Torch, 'cpu'), list(range(frames)))


def collapse(path, blank=0):
    return [token for i, token in enumerate(path) if token != blank and (i == 0 or path[i - 1] != token)]


@unittest.skipIf(numpy is None, 'numpy is required by the production Viterbi')
class Viterbi(unittest.TestCase):
    def test_matches_an_exhaustive_search_over_every_ctc_path(self):
        rng = random.Random(7)
        for targets in ([1, 2, 2], [3, 1, 3], [2], [1, 1, 1]):
            frames = 2 * len(targets) + 2
            for _ in range(4):
                emissions = [[math.log(rng.random() + 1e-3) for _ in range(4)] for _ in range(frames)]
                score = lambda path: sum(emissions[t][token] for t, token in enumerate(path))
                best = max(score(path) for path in itertools.product(range(4), repeat=frames)
                           if collapse(path) == targets)
                path = [int(token) for token in forced_align(emissions, targets)]
                self.assertEqual(collapse(path), targets)
                self.assertAlmostEqual(score(path), best, places=9)

    def test_refuses_a_transcript_longer_than_the_audio(self):
        # A repeated label needs a blank between its two frames.
        with self.assertRaises(ValueError):
            forced_align([[0.0, 0.0]] * 2, [1, 1])
        with self.assertRaises(ValueError):
            forced_align([[0.0, 0.0]] * 4, [0, 1])

    def test_word_slots_keep_frame_exact_song_clock(self):
        lines = [['oh'], ['no', 'no']]
        tokens, slots = targets_for_lines(lines, DICTIONARY)
        # Frame owners: * o o h * * n - o - n o * *  (- is blank).
        owners = [DICTIONARY['*'], DICTIONARY['o'], DICTIONARY['o'], DICTIONARY['h'], DICTIONARY['*'], DICTIONARY['*'],
                  DICTIONARY['n'], 0, DICTIONARY['o'], 0, DICTIONARY['n'], DICTIONARY['o'], DICTIONARY['*'],
                  DICTIONARY['*']]
        emissions = [[0.0 if c == owner else -20.0 for c in range(len(DICTIONARY))] for owner in owners]
        spans = merge_tokens(forced_align(emissions, tokens))
        self.assertEqual([span.token for span in spans], tokens)
        self.assertEqual(word_times(lines, slots, spans, 0.02), [
            [{'w': 'oh', 'startSec': 0.02, 'endSec': 0.08}],
            [{'w': 'no', 'startSec': 0.12, 'endSec': 0.18}, {'w': 'no', 'startSec': 0.2, 'endSec': 0.24}],
        ])


class Response(io.BytesIO):
    def __exit__(self, *args):
        self.close()


class CheckpointGate(unittest.TestCase):
    genuine = b'genuine checkpoint bytes'
    pin = {'sha256': hashlib.sha256(genuine).hexdigest(), 'size': len(genuine), 'url': 'https://example.com/m.pt'}

    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.models = os.path.join(self.dir.name, 'models')
        self.target = os.path.join(self.models, f"mms_fa-{self.pin['sha256'][:16]}.pt")
        self.fetches = []

    def tearDown(self):
        self.dir.cleanup()

    def fetch(self, body):
        def fetch(url, timeout):
            self.fetches.append(url)
            return Response(body)
        return fetch

    def write(self, path, body):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, 'wb') as output:
            output.write(body)

    def test_substituted_cache_and_download_are_rejected_before_any_load(self):
        legacy = os.path.join(self.dir.name, 'hub', 'model.pt')
        self.write(self.target, b'tampered checkpoint bytes')
        self.write(legacy, b'some other model.pt bytes')
        for body in (b'substituted payload here', self.genuine + b'!', self.genuine[:-1]):
            with self.assertRaises(CheckpointRejected):
                open_verified_checkpoint(self.models, (legacy,), fetch=self.fetch(body), **self.pin)
        self.assertEqual(sorted(os.listdir(self.models)), [os.path.basename(self.target)])
        with open(self.target, 'rb') as source:
            self.assertEqual(source.read(), b'tampered checkpoint bytes')

    def test_genuine_bytes_replace_a_corrupt_cache_and_are_then_reused(self):
        self.write(self.target, b'truncated')
        with open_verified_checkpoint(self.models, fetch=self.fetch(self.genuine), **self.pin) as handle:
            self.assertEqual(handle.read(), self.genuine)
        with open_verified_checkpoint(self.models, fetch=self.fetch(b'unused'), **self.pin) as handle:
            self.assertEqual(handle.read(), self.genuine)
        self.assertEqual(len(self.fetches), 1)

    def test_a_genuine_shared_legacy_cache_is_copied_in_without_downloading(self):
        legacy = os.path.join(self.dir.name, 'hub', 'model.pt')
        self.write(legacy, self.genuine)
        with open_verified_checkpoint(self.models, (legacy,), fetch=self.fetch(b''), **self.pin) as handle:
            self.assertEqual(handle.name, self.target)
            self.assertEqual(handle.read(), self.genuine)
        self.assertEqual(self.fetches, [])
        self.assertEqual(os.listdir(self.models), [os.path.basename(self.target)])

    def test_only_the_verified_handle_is_deserialized_with_weights_only(self):
        self.write(self.target, self.genuine)
        loads = []
        rows = [f'row{i}' for i in range(31)]
        model = SimpleNamespace(load_state_dict=lambda state: loads.append(('state', state)), eval=lambda: 'model')
        torch = SimpleNamespace(
            load=lambda handle, **options: loads.append((handle.read(), options)) or {'aux.weight': rows, 'aux.bias': rows},
            stack=list)
        torchaudio = SimpleNamespace(models=SimpleNamespace(wav2vec2_model=lambda **params: model))
        handle = open_verified_checkpoint(self.models, fetch=self.fetch(b''), **self.pin)
        self.assertEqual(load_mms_fa(handle, torch, torchaudio), 'model')
        self.assertTrue(handle.closed)
        self.assertEqual(loads[0], (self.genuine, {'map_location': 'cpu', 'weights_only': True}))
        kept = [row for i, row in enumerate(rows) if i not in AUX_ROWS_REMOVED]
        self.assertEqual(loads[1], ('state', {'aux.weight': kept, 'aux.bias': kept}))
        self.assertEqual(len(kept), 28)


if __name__ == '__main__':
    unittest.main()
