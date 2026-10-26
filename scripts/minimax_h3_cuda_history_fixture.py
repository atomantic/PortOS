"""Weight-free fixture: real pinned modular blocks, schedulers, tensors and PyAV."""

import sys
import tempfile
from fractions import Fraction
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

import av
import numpy as np
import torch

sys.path.insert(0, sys.argv[1])
import minimax_h3_cuda_history as history
from diffusers import MiniMaxH3Scheduler
from _minimax_h3_common import validate_h3_history_args


history.assert_runtime_contract(SimpleNamespace(model_repo=history.CONTRACT["model"]["repo"],
                                               model_revision=history.CONTRACT["model"]["revision"]))

with tempfile.TemporaryDirectory() as temp:
    source = Path(temp) / "source.nut"
    samples = np.stack([np.arange(64000, dtype=np.float32) / 64000,
                        -np.arange(64000, dtype=np.float32) / 64000])
    with av.open(str(source), "w") as container:
        video_stream = container.add_stream("rawvideo", rate=24)
        video_stream.width = video_stream.height = 32
        video_stream.pix_fmt = "rgb24"
        audio_stream = container.add_stream("pcm_f32le", rate=32000)
        audio_stream.layout = "stereo"
        for index in range(48):
            frame = av.VideoFrame.from_ndarray(np.full((32, 32, 3), index, np.uint8), format="rgb24")
            frame.pts, frame.time_base = index + 48, Fraction(1, 24)
            for packet in video_stream.encode(frame):
                container.mux(packet)
        for packet in video_stream.encode(None):
            container.mux(packet)
        for index in range(0, 64000, 6400):
            frame = av.AudioFrame.from_ndarray(samples[:, index:index + 6400], format="fltp", layout="stereo")
            frame.sample_rate = 32000
            frame.pts, frame.time_base = index + 64000, Fraction(1, 32000)
            for packet in audio_stream.encode(frame):
                container.mux(packet)
        for packet in audio_stream.encode(None):
            container.mux(packet)

    args = SimpleNamespace(source_video=str(source), output=str(Path(temp) / "new.mp4"), history_frames=17,
                           history_end_frame=34, prompt="Keep moving.", height=32, width=32,
                           num_frames=124, steps=8, seed=42)
    interval = validate_h3_history_args(args, supported=True)
    frames, audio = history.decode_history(source, interval, 32, 32)
    assert frames[:, 0, 0, 0].tolist() == list(range(17, 34))
    np.testing.assert_array_equal(audio, samples[:, 22667:45333])
    args.history_end_frame = 60
    try:
        history.decode_history(source, validate_h3_history_args(args, supported=True), 32, 32)
    except RuntimeError as exc:
        assert "ends before" in str(exc)
    else:
        raise AssertionError("short source accepted")

    config = SimpleNamespace(clip_length=17, token_drop=3, latents_mean=[0] * 24, latents_std=[1] * 24)
    encoded_video = torch.arange(5, dtype=torch.float32).view(1, 1, 5, 1, 1).expand(1, 24, 5, 2, 2)
    encoded_audio = torch.arange(2 * 32 * 29, dtype=torch.float32).reshape(2, 32, 29)

    def sample(generator):
        assert generator.initial_seed() == 42
        return encoded_video

    def encode_video(pixels, **kwargs):
        assert config.token_drop == 0
        assert tuple(pixels.shape) == (1, 3, 17, 32, 32)
        return (SimpleNamespace(sample=sample),)

    def decode_video(latents, **kwargs):
        assert config.token_drop == 3
        assert tuple(latents.shape) == (1, 24, 37, 2, 2)
        return (torch.zeros(1, 3, 124, 32, 32),)

    def decode_audio(latents, **kwargs):
        assert tuple(latents.shape) == (2, 32, 207)
        return (torch.zeros(2, 1, 165600),)

    calls = []

    def forward(hidden_states, audio_hidden_states, encoder_hidden_states, timestep, timestep_indices,
                attention_kwargs, return_dict, position_ids=None, token_tags=None,
                video_indices=None, audio_indices=None, text_indices=None):
        # These assertions run on every native denoising iteration. A clean tag
        # without unchanged data, or preserved data with noisy timesteps, fails.
        assert torch.equal(hidden_states[0, :5], torch.arange(5).view(5, 1).expand(5, 96))
        expected_audio = encoded_audio.transpose(1, 2).reshape(-1, 32)
        assert torch.equal(audio_hidden_states[0, :58], expected_audio)
        row_times = timestep[timestep_indices]
        assert torch.all(row_times[video_indices[:5]] == 1)
        assert torch.all(row_times[audio_indices[:58]] == 1)
        assert video_indices[:5].tolist() == list(range(60, 65))
        assert audio_indices[:58].tolist() == list(range(2, 60))
        torch.testing.assert_close(position_ids[video_indices[:5], 0],
                                   torch.tensor([2, 2 + 5/3, 2 + 25/3, 17, 2 + 65/3], dtype=torch.float64))
        assert abs(float(position_ids[video_indices[5], 0]) - (2 + 85/3)) < 1e-12
        assert abs(float(position_ids[audio_indices[58], 0]) - (2 + 85/3)) < 1e-12
        assert torch.all(token_tags[video_indices] == 0) and torch.all(token_tags[audio_indices] == 2)
        calls.append(True)
        return torch.ones_like(hidden_states), torch.ones_like(audio_hidden_states)

    transformer = Mock(side_effect=forward)
    transformer.forward = forward
    pipe = SimpleNamespace(
        _execution_device=torch.device("cpu"), fps=24, min_duration=5, max_duration=15,
        canvas_multiple=32, vae_frames_per_chunk=17, vae_latents_per_chunk=5,
        vae_spatial_compression_ratio=16, vae_latent_channels=24, patch_size=(1, 2, 2),
        audio_channels=2, audio_latent_channels=32, audio_sampling_rate=32000,
        audio_tag=2, video_tag=0, text_tag=1, text_encoder_layer=50,
        text_encoder=SimpleNamespace(dtype=torch.bfloat16), processor=None,
        tokenizer=lambda text, **kw: {"input_ids": [1, 2]},
        pixel_mean=(0.485, 0.456, 0.406), pixel_std=(0.229, 0.224, 0.225), keyframe_encode_seed=42,
        vae=SimpleNamespace(config=config, encode=encode_video, decode=decode_video,
                            register_to_config=lambda **kw: config.__dict__.update(kw)),
        audio_vae=SimpleNamespace(config=SimpleNamespace(latents_mean=[0] * 32, latents_std=[1] * 32),
                                 encode=lambda *a, **kw: (SimpleNamespace(mode=lambda: encoded_audio),), decode=decode_audio),
        video_processor=SimpleNamespace(postprocess_video=lambda video, **kw: [list(range(video.shape[2]))]),
        scheduler=MiniMaxH3Scheduler(shift=12), audio_scheduler=MiniMaxH3Scheduler(shift=3), transformer=transformer,
    )
    with patch("diffusers.modular_pipelines.minimax_h3.encoders.get_qwen3vl_prompt_embeds",
               return_value=torch.zeros(1, 2, 5120)):
        result = history.run_history(pipe, args, frames, audio)
    assert len(calls) == 7
    assert len(result["videos"][0]) == 124 and result["audio"].shape == (1, 2, 165600)
    pipe.vae.encode = Mock(side_effect=RuntimeError("encoding failed"))
    try:
        history.encode_history(pipe, frames, audio)
    except RuntimeError:
        pass
    assert config.token_drop == 3

print("native CUDA history fixtures passed")
