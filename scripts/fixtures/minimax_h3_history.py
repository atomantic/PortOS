"""Weight-free native MLX fixture. Run with the H3 venv and pinned checkout.

python scripts/fixtures/minimax_h3_history.py --runtime-dir <cached-mlx-checkout>
Exercises real pinned packing/schedulers and MLX tensors, with tiny deterministic
VAEs/DiT. This establishes the adapter contract, never motion/render fidelity.
"""

import argparse
import json
import shutil
import subprocess
import sys
import tempfile
import wave
from pathlib import Path
from types import SimpleNamespace as NS

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from _minimax_h3_mlx_history import PIN, history_layout, read_history_media, render_history, verify_history_backend
from _minimax_h3_common import validate_h3_history_args
from _runner_common import register_source_namespace


def check_tensors():
    import mlx.core as mx
    import numpy as np
    from minimax_h3_mlx.packing import _temporal_position_grid
    from minimax_h3_mlx.scheduler import MiniMaxH3Scheduler

    seen = []
    cfg = NS(clip_length=17, token_drop=3, spatial_compression_ratio=16,
             latent_channels=1, latents_mean=[0.0], latents_std=[1.0])
    ac = NS(sampling_rate=32000, hop_length=800, latent_channels=1, latents_mean=[0.0], latents_std=[1.0])
    def encode_video(pixels):
        assert pixels.shape == (1, 17, 32, 32, 3)
        return mx.concatenate([mx.full((1, 5, 2, 2, 1), 7.0), mx.full((1, 5, 2, 2, 1), -100.0)], axis=-1)
    def encode_audio(samples):
        assert samples.shape == (2, 1, 22667)
        return mx.full((2, 1, 29), 3.0), None
    def dit(video, audio, embeds, table, assignment, tags, positions, vi, ai, ti, **_):
        row_times = np.array(table)[np.array(assignment)]
        vi, ai = np.array(vi), np.array(ai)
        assert np.all(row_times[vi[:5]] == 1.0)
        assert np.all(row_times[ai[:58]] == 1.0)
        assert np.all(row_times[vi[5:]] < 1.0)
        assert np.all(row_times[ai[58:]] < 1.0)
        video_array, audio_array = np.array(video.astype(mx.float32)), np.array(audio.astype(mx.float32))
        assert np.all(video_array[0, :5] == 7.0)
        assert np.all(audio_array[0, :58] == 3.0)
        seen.append((video_array, audio_array))
        return mx.ones(video.shape), mx.ones(audio.shape)
    dit.config = NS(patch_size=(1, 2, 2))
    def schedules(steps):
        result = [MiniMaxH3Scheduler(shift=s) for s in (12.0, 3.0)]
        for item in result: item.set_timesteps(steps)
        return result
    decoded = []
    def decode_video(rows, frames, height, width):
        assert rows.shape == (37, 4)
        assert (frames, height, width) == (37, 2, 2)
        decoded.append('video')
        return np.zeros((124, 32, 32, 3), dtype=np.uint8)
    def decode_audio(rows, frames):
        assert rows.shape == (414, 1) and frames == 207
        decoded.append('audio')
        return np.zeros((2, 165600), dtype=np.float32)
    pipe = NS(video_vae=NS(config=cfg, _encode_clip=encode_video), audio_vae=NS(config=ac, encode=encode_audio),
              dit=dit, text_encoder=NS(encode=lambda prompt, images: (mx.ones((1, 2, 1)), [1, 1])),
              _build_schedules=schedules, _ensure_cache=lambda *_: None, _cache=None,
              _decode_video=decode_video, _decode_audio=decode_audio)
    args = NS(prompt='A moving example', num_frames=124, height=32, width=32, steps=3)
    result = render_history(pipe, args, (np.zeros((17, 32, 32, 3), dtype=np.uint8), np.zeros((2, 22667), dtype=np.float32)), 42)
    assert len(seen) == 2 and decoded == ['video', 'audio']
    assert not np.array_equal(seen[0][0][:, 5:], seen[1][0][:, 5:])
    assert result.video.shape[0] == 124 and result.audio.shape[0] == 2
    layout = history_layout([1, 1], 37, 2, 2, 207, (1, 2, 2))
    positions = np.array(layout.position_ids)
    vi, ai = np.array(layout.video_indices), np.array(layout.audio_indices)
    assert layout.num_condition_video_rows == 5 and layout.num_condition_audio_rows == 58
    np.testing.assert_array_equal(positions[vi[:5], 0], np.array([2, 11 / 3, 31 / 3, 17, 71 / 3], dtype=np.float32))
    np.testing.assert_array_equal(positions[vi[5:], 0], _temporal_position_grid(37, 2 + 85 / 3).astype(np.float32))
    np.testing.assert_array_equal(positions[ai[:58], 0], np.tile(2 + np.arange(29), 2).astype(np.float32))
    np.testing.assert_array_equal(positions[ai[58:], 0], np.tile(2 + 85 / 3 + np.arange(207), 2).astype(np.float32))


def check_media():
    import numpy as np

    ffmpeg = shutil.which('ffmpeg')
    assert ffmpeg, 'ffmpeg is required for the media fixture'
    with tempfile.TemporaryDirectory(prefix='h3-history-fixture-') as folder:
        root = Path(folder)
        wav, source = root / 'sound.wav', root / 'source.mkv'
        values = ((np.arange(96000) % 30000) - 15000).astype('<i2')
        audio = np.stack([values, -values], axis=-1)
        with wave.open(str(wav), 'wb') as handle:
            handle.setnchannels(2)
            handle.setsampwidth(2)
            handle.setframerate(32000)
            handle.writeframes(audio.tobytes())
        frames = np.broadcast_to(np.arange(72, dtype=np.uint8)[:, None, None, None], (72, 32, 32, 3)).copy()
        subprocess.run([ffmpeg, '-v', 'error', '-nostdin', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', '32x32',
                        '-r', '24', '-i', 'pipe:0', '-i', str(wav), '-c:v', 'ffv1', '-c:a', 'pcm_s16le', str(source)],
                       input=frames.tobytes(), capture_output=True, check=True)
        original = source.read_bytes()
        args = NS(source_video=str(source), history_end_frame=41, history_frames=17, width=32, height=32, output=str(root / 'next.mp4'))
        interval = validate_h3_history_args(args, supported=True)
        video, waveform = read_history_media(args, interval, ffmpeg)
        np.testing.assert_array_equal(video, frames[24:41])
        np.testing.assert_array_equal(waveform, audio[32000:54667].T.astype(np.float32) / 32768)
        # The timeline belongs to the video, not to audio sample zero. Use
        # nonzero global timestamps and independent audio starts in both
        # directions; these would return full-length but wrong audio before.
        shifted = root / 'shifted.mkv'
        for delay, expected_start in [(0.25, 24000), (-0.25, 40000)]:
            subprocess.run([ffmpeg, '-v', 'error', '-nostdin', '-y', '-i', str(source),
                            '-itsoffset', str(delay), '-i', str(wav), '-map', '0:v:0', '-map', '1:a:0',
                            '-c', 'copy', '-output_ts_offset', '2', str(shifted)],
                           capture_output=True, check=True)
            shifted_args = NS(**(vars(args) | {'source_video': str(shifted)}))
            shifted_video, shifted_audio = read_history_media(shifted_args, interval, ffmpeg)
            np.testing.assert_array_equal(shifted_video, frames[24:41])
            np.testing.assert_array_equal(shifted_audio,
                                          audio[expected_start:expected_start + 22667].T.astype(np.float32) / 32768)
        # A delayed stream still has enough samples when counted from its own
        # start, but it cannot cover the selected video's first quarter second.
        subprocess.run([ffmpeg, '-v', 'error', '-nostdin', '-y', '-i', str(source),
                        '-itsoffset', '1.25', '-i', str(wav), '-map', '0:v:0', '-map', '1:a:0',
                        '-c', 'copy', '-output_ts_offset', '2', str(shifted)],
                       capture_output=True, check=True)
        try:
            read_history_media(shifted_args, interval, ffmpeg)
            raise AssertionError('incomplete timestamp coverage accepted')
        except RuntimeError as exc:
            assert 'exact selected interval' in str(exc)
        # A missing interior span is also incomplete coverage, even when
        # the file's audio begins early enough and extends past the interval.
        subprocess.run([ffmpeg, '-v', 'error', '-nostdin', '-y', '-i', str(source),
                        '-map', '0:v:0', '-map', '0:a:0', '-c:v', 'copy', '-c:a', 'pcm_s16le',
                        '-af', 'asetpts=PTS+gte(T\\,1.25)*0.25/TB', str(shifted)],
                       capture_output=True, check=True)
        try:
            read_history_media(shifted_args, interval, ffmpeg)
            raise AssertionError('interior audio timestamp gap accepted')
        except RuntimeError as exc:
            assert 'exact selected interval' in str(exc)
        shifted.unlink()
        args.history_end_frame = 100
        try:
            read_history_media(args, validate_h3_history_args(args, supported=True), ffmpeg)
            raise AssertionError('short source accepted')
        except RuntimeError:
            pass
        assert source.read_bytes() == original
        assert sorted(p.name for p in root.iterdir()) == ['sound.wav', 'source.mkv']


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--runtime-dir', required=True, type=Path)
    args = parser.parse_args()
    verify_history_backend(args.runtime_dir, PIN)
    register_source_namespace('minimax_h3_mlx', args.runtime_dir / 'minimax_h3_mlx')
    check_tensors()
    check_media()
    print(json.dumps({'ok': True, 'pin': PIN, 'tensorFixture': 'passed', 'mediaFixture': 'passed',
                      'pairedRender': 'unavailable', 'automaticCapability': False}))
