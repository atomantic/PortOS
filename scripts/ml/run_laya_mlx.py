"""PortOS's narrow Laya-MLX bridge. Scoring is offline; only setup downloads.

The upstream package owns inference and formatting. No upstream code is vendored.
Each experiment releases its process/model when complete, including on timeout.
"""
import contextlib
import json
from pathlib import Path
import sys


def score(agent, request):
    from laya_mlx.common import build_prefix, render_options, serialize_state

    question = {"type": "choice", "instructions": request["instructions"], "criteria": request["options"]}
    internal = agent._to_internal(question)
    # Upstream silently truncates state and question prefixes to its short token
    # budget. Reject instead: a decision about part of a premise is misleading.
    for option in render_options(internal):
        option_ids = agent.tok(" " + option.replace(agent.tok.mask_token, " "), add_special_tokens=False)["input_ids"]
        if len(option_ids) > 48:
            return {"code": "laya-context-too-long"}
    prefix, _ = build_prefix(agent.tok, internal, 1_000_000)
    state_ids = agent.tok(serialize_state(request["premise"]).replace(agent.tok.mask_token, " "),
                          add_special_tokens=False)["input_ids"]
    if len(prefix) > agent.cfg.get("head_max_len", 192) or len(prefix) + len(state_ids) + 1 > agent.cfg.get("max_len", 512):
        return {"code": "laya-context-too-long"}
    return agent.predict(request["premise"], {"decision": question})


def main():
    mode, model_dir = sys.argv[1:3]
    if mode == "download":
        from huggingface_hub import snapshot_download
        snapshot_download(repo_id=sys.argv[3], revision=sys.argv[4], local_dir=model_dir)
        return
    # Refuse a missing local path before load can interpret it as a Hub repo ID.
    if not Path(model_dir).is_dir():
        raise ValueError("Local model is missing")
    import laya_mlx
    with contextlib.redirect_stdout(sys.stderr):
        agent = laya_mlx.load(model_dir, dtype="float16")
        result = score(agent, json.load(sys.stdin)) if mode == "score" else {"ok": True}
    print(json.dumps(result, allow_nan=False))


if __name__ == "__main__":
    main()
