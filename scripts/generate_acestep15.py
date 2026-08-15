#!/usr/bin/env python3
"""ACE-Step 1.5 music sidecar using PortOS' STAGE/RESULT protocol.

ACE-Step 1.5 is not compatible with the v1 ``ACEStepPipeline`` package. Its
fixed Hugging Face snapshot contains a DiT with custom Transformers code plus
the VAE, text encoder, and 5 Hz language model. The existing Music install flow
downloads that whole snapshot to the HF cache; this runner opens the cached
snapshot only, so generation never triggers an unannounced model download.
"""

import argparse
import json
import os
import shutil
import sys
import wave


MODEL_ID = "ACE-Step/Ace-Step1.5"
MODEL_VARIANT = "acestep-v15-turbo"


def stage(name, detail=""):
    print(f"STAGE:{name}" + (f":{detail}" if detail else ""), file=sys.stderr, flush=True)


def wav_duration_seconds(path):
    with wave.open(path, "rb") as audio:
        return audio.getnframes() / float(audio.getframerate() or 1)


def cached_checkpoint_dir(repo):
    from huggingface_hub import snapshot_download

    # Model installation is explicit in the Music UI. local_files_only keeps a
    # direct Generate click from silently downloading this multi-GB snapshot.
    return snapshot_download(repo_id=repo, local_files_only=True)


def main():
    parser = argparse.ArgumentParser(description="PortOS ACE-Step 1.5 runner")
    parser.add_argument("--model", default=MODEL_ID)
    parser.add_argument("--text", required=True)
    parser.add_argument("--lyrics", default="")
    parser.add_argument("--output", required=True)
    parser.add_argument("--duration", type=float, default=60.0)
    parser.add_argument("--runtime-dir", default="")
    args = parser.parse_args()

    text = args.text.strip()
    if not text:
        print("ERROR: --text is required", file=sys.stderr, flush=True)
        return 2
    if args.model != MODEL_ID:
        print(f"ERROR: ACE-Step 1.5 uses the fixed model {MODEL_ID}", file=sys.stderr, flush=True)
        return 2

    stage("resolve-model", args.model)
    try:
        checkpoint_dir = cached_checkpoint_dir(args.model)
    except Exception as exc:
        print(f"ERROR: ACE-Step 1.5 model weights are not installed: {exc}", file=sys.stderr, flush=True)
        return 1

    # AceStepHandler performs AutoModel.from_pretrained(...,
    # trust_remote_code=True) against <checkpoints>/acestep-v15-turbo. Point
    # its checkpoint resolver at the installed HF snapshot rather than copying
    # its multi-component tree into the virtualenv or a temporary directory.
    os.environ["ACESTEP_CHECKPOINTS_DIR"] = checkpoint_dir
    from acestep.handler import AceStepHandler
    from acestep.inference import GenerationConfig, GenerationParams, generate_music

    duration = max(1.0, min(float(args.duration or 60.0), 240.0))
    stage("load-model", MODEL_VARIANT)
    dit_handler = AceStepHandler()
    status, initialized = dit_handler.initialize_service(
        project_root="",
        config_path=MODEL_VARIANT,
        device="auto",
        offload_to_cpu=False,
    )
    if not initialized:
        print(f"ERROR: ACE-Step 1.5 could not initialize: {status}", file=sys.stderr, flush=True)
        return 1

    output_dir = os.path.dirname(os.path.abspath(args.output))
    os.makedirs(output_dir, exist_ok=True)
    lyrics = args.lyrics.strip() or "[Instrumental]"
    params = GenerationParams(
        task_type="text2music",
        caption=text,
        lyrics=lyrics,
        duration=duration,
        inference_steps=8,
        guidance_scale=1.0,
        thinking=False,
        seed=-1,
    )
    stage("generate", f"{duration:.1f}s")
    result = generate_music(
        dit_handler=dit_handler,
        llm_handler=None,
        params=params,
        config=GenerationConfig(batch_size=1, audio_format="wav"),
        save_dir=output_dir,
    )
    if not result.success or not result.audios:
        reason = getattr(result, "error", None) or getattr(result, "status_message", "unknown error")
        print(f"ERROR: ACE-Step 1.5 generation failed: {reason}", file=sys.stderr, flush=True)
        return 1

    produced = result.audios[0].get("path")
    if not produced or not os.path.isfile(produced):
        print("ERROR: ACE-Step 1.5 returned no audio file", file=sys.stderr, flush=True)
        return 1
    if os.path.abspath(produced) != os.path.abspath(args.output):
        shutil.move(produced, args.output)
    stage("encode-wav")
    print("RESULT:" + json.dumps({
        "output": args.output,
        "model": args.model,
        "durationSec": round(wav_duration_seconds(args.output), 3),
    }), flush=True)
    stage("done")
    return 0


if __name__ == "__main__":
    sys.exit(main())
