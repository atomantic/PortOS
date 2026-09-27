"""Resident AuK MLX worker. One JSON request/response per line; models load on demand."""
import contextlib
import json
import os
import sys
import time
from pathlib import Path


def main():
    # Never fetch models during synthesis; installation is an explicit UI action.
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    root = Path(sys.argv[1])
    engine = None
    for line in sys.stdin:
        request = json.loads(line)
        started = time.monotonic()
        try:
            with contextlib.redirect_stdout(sys.stderr):
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
