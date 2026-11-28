"""Resident AuK MLX worker. One JSON request/response per line; models load on demand."""
import contextlib
import json
import os
import sys
import time
import types
import urllib.parse
from pathlib import Path

QWEN_AUDIO_SAMPLE_RATE = 16000


def _load_audio_16k(source, audio_start=0.0, audio_end=None):
    """Load a local audio file or 1-D ndarray as 16 kHz mono float32 for Qwen2.5-Omni."""
    import numpy as np

    start = max(0.0, float(audio_start or 0.0))
    end = None if audio_end is None else float(audio_end)
    if isinstance(source, np.ndarray):
        if source.ndim > 1:
            raise ValueError('Support only mono audio')
        start_idx = max(0, int(QWEN_AUDIO_SAMPLE_RATE * start))
        end_idx = None if end is None else max(start_idx, int(QWEN_AUDIO_SAMPLE_RATE * end))
        return np.ascontiguousarray(source[start_idx:end_idx], dtype=np.float32)
    if not isinstance(source, (str, os.PathLike)):
        raise ValueError('Unsupported audio reference type')
    path = os.fspath(source)
    lower = path.lower()
    if lower.startswith('file://'):
        parsed = urllib.parse.urlsplit(path)
        if parsed.netloc not in ('', 'localhost'):
            raise ValueError('AuK worker only supports local audio files')
        path = urllib.parse.unquote(parsed.path)
    elif lower.startswith(('http://', 'https://', 'ftp://', 'data:')):
        raise ValueError('AuK worker only supports local audio files')
    import soundfile as sf
    import soxr

    with sf.SoundFile(path) as handle:
        sr = handle.samplerate
        start_frame = min(max(0, int(round(start * sr))), len(handle))
        if start_frame:
            handle.seek(start_frame)
        frames = -1 if end is None else max(0, int(round((end - start) * sr)))
        wav = handle.read(frames=frames, dtype='float32', always_2d=True)
    mono = wav.mean(axis=1)
    if sr != QWEN_AUDIO_SAMPLE_RATE and mono.size:
        mono = soxr.resample(mono, sr, QWEN_AUDIO_SAMPLE_RATE, quality='VHQ')
    return np.ascontiguousarray(mono, dtype=np.float32)


def _process_mm_info(conversations, use_audio_in_video=True, **_kwargs):
    """Audio-only replacement for qwen_omni_utils.process_mm_info.

    AuK MLX only passes local reference WAVs alongside text prompts; owning
    this loader drops qwen-omni-utils, PyAV, librosa, numba, llvmlite,
    scikit-learn, scipy, and requests from requirements-auk-mlx.lock.txt.
    """
    del use_audio_in_video
    if not conversations:
        return None, None, None
    if isinstance(conversations[0], dict):
        conversations = [conversations]
    audios = []
    for conversation in conversations:
        for message in conversation:
            content = message.get('content') if isinstance(message, dict) else None
            if not isinstance(content, list):
                continue
            for element in content:
                if not isinstance(element, dict):
                    continue
                kind = element.get('type')
                if kind == 'audio':
                    source = element.get('audio')
                    if source is None:
                        source = element.get('audio_url')
                    if source is None:
                        raise ValueError('Missing audio reference')
                    audios.append(_load_audio_16k(source, element.get('audio_start', 0.0), element.get('audio_end')))
                elif kind in ('image', 'video'):
                    raise ValueError(f'AuK worker does not support {kind} inputs')
    return (audios or None), None, None


def install_audio_only_qwen_omni_utils():
    """Register the audio-only qwen_omni_utils shim so auk_mlx.infer needs no PyAV/librosa."""
    if 'qwen_omni_utils' in sys.modules:
        return sys.modules['qwen_omni_utils']
    module = types.ModuleType('qwen_omni_utils')
    module.process_mm_info = _process_mm_info
    sys.modules['qwen_omni_utils'] = module
    return module


def main():
    # Never fetch models during synthesis; installation is an explicit UI action.
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    root = Path(sys.argv[1])
    engine = None
    for line in sys.stdin:
        started = time.monotonic()
        try:
            request = json.loads(line)
            with contextlib.redirect_stdout(sys.stderr):
                install_audio_only_qwen_omni_utils()
                import soundfile as sf
                from auk_mlx.infer import AukMLX, GenerateOptions
                if engine is None:
                    engine = AukMLX(str(root / 'ckpts/mlx'),
                                    str(root / 'ckpts/AuK-Flash/config.yaml'),
                                    str(root / 'ckpts/Qwen2.5-Omni-3B'), bits=8)
                import numpy as np
                reference = request.get('referenceAudio')
                chunks = []
                intermediate = request['output'] + '.source.wav'
                generated_reference = request['output'] + '.reference.wav'
                try:
                    for segment in request['segments']:
                        text = json.dumps(segment['text'], ensure_ascii=False)
                        instruction = (f'Say the following with the same voice: {text}' if reference else
                                       f'Generate speech based on the following description: {json.dumps(request["instructions"], ensure_ascii=False)}. The content to speak is: {text}.')
                        opts = GenerateOptions(gen_seconds=segment['seconds'], seed=request['seed'])
                        audio, sr = engine.generate(instruction, audio_path=reference, opts=opts)
                        pitch = request.get('pitchSemitones', 0)
                        if pitch:
                            sf.write(intermediate, audio, sr)
                            audio, sr = engine.generate(
                                f'{"Raise" if pitch > 0 else "Lower"} the pitch by {abs(pitch)} semitones.',
                                audio_path=intermediate, opts=opts)
                        chunks.append(audio)
                        # Longer narration keeps one identity even without a preexisting profile.
                        if not reference and len(request['segments']) > 1:
                            sf.write(generated_reference, audio, sr)
                            reference = generated_reference
                    sf.write(request['output'], np.concatenate(chunks, axis=0), sr)
                finally:
                    Path(intermediate).unlink(missing_ok=True)
                    Path(generated_reference).unlink(missing_ok=True)
            elapsed = round((time.monotonic() - started) * 1000)
            print(json.dumps({'ok': True, 'latencyMs': elapsed, 'firstAudioMs': elapsed}), flush=True)
        except Exception as exc:
            # Keep prompts, local paths, and dependency diagnostics out of HTTP responses.
            print(json.dumps({'ok': False, 'error': type(exc).__name__}), flush=True)


if __name__ == '__main__':
    main()
