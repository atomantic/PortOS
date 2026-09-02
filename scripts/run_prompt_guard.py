#!/usr/bin/env python3
"""Run the pinned Prompt Guard classifier over one complete content item.

The Node service starts this helper only after it has resolved an exact cached
model snapshot. The helper is deliberately a classifier, not an agent: it does
not accept tools, fetch URLs, execute repository code, or emit the input text.

Input: one JSON object on stdin: {"text": "..."}
Output: one JSON object on stdout with ordered chunk verdicts.
"""

import argparse
import json
import sys
from pathlib import Path


MAX_INPUT_CHARS = 2_000_000
MAX_CHUNK_TOKENS = 510  # 512-token model window minus room for special tokens
CHUNK_OVERLAP = 64
MAX_CHUNKS = 100_000


def main() -> int:
    parser = argparse.ArgumentParser(description="Run Prompt Guard locally and offline.")
    parser.add_argument("--model-dir", required=True)
    args = parser.parse_args()

    model_dir = Path(args.model_dir)
    if not model_dir.is_dir():
        raise ValueError("model snapshot is unavailable")

    request = json.load(sys.stdin)
    text = request.get("text") if isinstance(request, dict) else None
    if not isinstance(text, str) or not text.strip():
        raise ValueError("text is missing")
    if len(text) > MAX_INPUT_CHARS:
        raise ValueError("text is too large")

    # Imports happen only after all input and path checks. The caller also sets
    # the offline flags; local_files_only and trust_remote_code are repeated
    # here so this boundary stays safe if the script is ever invoked directly.
    import torch
    from transformers import AutoModelForSequenceClassification, AutoTokenizer

    torch.set_num_threads(1)
    tokenizer = AutoTokenizer.from_pretrained(
        str(model_dir), local_files_only=True, trust_remote_code=False
    )
    model = AutoModelForSequenceClassification.from_pretrained(
        str(model_dir),
        local_files_only=True,
        trust_remote_code=False,
        use_safetensors=True,
    )
    model.to("cpu")
    model.eval()

    token_ids = tokenizer.encode(text, add_special_tokens=False)
    if not token_ids:
        raise ValueError("text has no model tokens")

    id_to_label = getattr(model.config, "id2label", {}) or {}
    step = max(1, MAX_CHUNK_TOKENS - CHUNK_OVERLAP)
    chunks = []
    start = 0
    index = 0
    with torch.inference_mode():
        while start < len(token_ids):
            if index >= MAX_CHUNKS:
                raise ValueError("text produced too many model windows")
            end = min(len(token_ids), start + MAX_CHUNK_TOKENS)
            encoded = tokenizer.prepare_for_model(
                token_ids[start:end],
                add_special_tokens=True,
                return_attention_mask=True,
                return_tensors="pt",
            )
            model_inputs = {
                key: value
                for key, value in encoded.items()
                if key in {"input_ids", "attention_mask", "token_type_ids"}
            }
            probabilities = torch.softmax(model(**model_inputs).logits[0], dim=-1)
            class_id = int(torch.argmax(probabilities).item())
            label = id_to_label.get(class_id, f"LABEL_{class_id}")
            chunks.append({
                "index": index,
                "label": str(label),
                "score": float(probabilities[class_id].item()),
                "tokenStart": start,
                "tokenEnd": end,
            })
            index += 1
            if end == len(token_ids):
                break
            start += step

    json.dump({"chunks": chunks}, sys.stdout, separators=(",", ":"))
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:  # noqa: BLE001 - CLI boundary must fail closed.
        print(f"Prompt Guard failed: {error}", file=sys.stderr)
        raise SystemExit(1)
