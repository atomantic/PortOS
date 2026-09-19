#!/usr/bin/env python3
"""Shared frozen-encoder pooling and trained-head application for jev.

Imported by BOTH `run_jev.py` (which applies an adopted head at inference) and
`train_jev_head.py` (which fits one). They must agree exactly on two things or
a head silently scores a different vector space than it was fit on:

  * how a (premise, hypothesis) pair is pooled into one vector, and
  * how a head's layers map that vector onto the checkpoint's three labels.

Both live here, once. The Node-side contract they mirror is
`server/lib/jevHead.js`; the constants below are repeated rather than imported
so this boundary still holds if either script is invoked directly.

Nothing here reaches the network, reads a repository, or executes model code:
`trust_remote_code` is never set, and a head is plain JSON validated before a
single number of it is used.
"""

import json
import math
import re
from pathlib import Path

# Mirrors of server/lib/jevHead.js.
HEAD_SCHEMA_VERSION = 1
POOLING = "last-token"
ARCHITECTURES = ("linear", "mlp1")
MAX_PARAMS = 2_000_000
MAX_HIDDEN = 256
# Mirrors JEV_LABELS in server/lib/jev.js, in the checkpoint's id2label order.
LABELS = ("contradiction", "entailment", "neutral")
# A head is addressed by slug, never by path: the sidecar resolves it inside a
# directory the Node service owns, so a request cannot name a file elsewhere.
SLUG = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")


class HeadError(Exception):
    """A head failure the Node service can map to a code without reading text."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


def pool_pair(state, premise: str, hypothesis: str):
    """Encode one pair and return `(pooled_vector, stock_logits)`.

    The pooled vector is the LAST token's final hidden state. openjev's 4B NLI
    checkpoint is a causal decoder, so that is the only position which has
    attended to the whole pair — a mean over the sequence would dilute the
    hypothesis, which is the half that varies.

    The checkpoint's own classifier logits come out of the same forward pass.
    The trainer needs both (the head's input, and the stock baseline it has to
    beat), and paying for two passes to collect them would double the cost of
    the one step that dominates a training run.
    """
    torch = state["torch"]
    tokenizer = state["tokenizer"]
    model = state["model"]
    text = state["template"].format(premise=premise, hypothesis=hypothesis)
    token_ids = tokenizer.encode(text, add_special_tokens=True, truncation=False)
    # Same refusal as `score_pairs`: a verdict on a truncated prefix is not a
    # verdict on the pair, and nothing downstream could tell the difference.
    if len(token_ids) > state["window"]:
        raise HeadError("jev-premise-too-large")
    device = state.get("device", "cpu")
    model_inputs = {
        "input_ids": torch.tensor([token_ids]).to(device),
        "attention_mask": torch.tensor([[1] * len(token_ids)]).to(device),
    }
    with torch.inference_mode():
        output = model(**model_inputs, output_hidden_states=True)
    pooled = output.hidden_states[-1][0, -1, :].to("cpu").float().tolist()
    logits = output.logits[0].to("cpu").float().tolist()
    return pooled, logits


def validate_head(raw, *, revision: str):
    """Validate a head artifact's shape, size and encoder revision.

    Mirrors `parseJevHead` + `isHeadCompatible` in server/lib/jevHead.js. The
    revision check is not a nicety: the head's inputs are hidden states from one
    specific checkpoint, so applying it across a different one produces
    confident numbers with nothing anywhere to signal they are meaningless.
    """
    if not isinstance(raw, dict):
        raise HeadError("jev-head-invalid")
    if raw.get("schemaVersion") != HEAD_SCHEMA_VERSION:
        raise HeadError("jev-head-invalid")
    if raw.get("pooling") != POOLING:
        raise HeadError("jev-head-invalid")
    if raw.get("architecture") not in ARCHITECTURES:
        raise HeadError("jev-head-invalid")
    if list(raw.get("labels") or []) != list(LABELS):
        raise HeadError("jev-head-invalid")
    base = raw.get("baseModel")
    if not isinstance(base, dict) or base.get("revision") != revision:
        raise HeadError("jev-head-revision-mismatch")

    layers = raw.get("layers")
    hidden_size = raw.get("hiddenSize")
    if not isinstance(layers, list) or not 1 <= len(layers) <= 2:
        raise HeadError("jev-head-invalid")
    if not isinstance(hidden_size, int) or hidden_size < 1:
        raise HeadError("jev-head-invalid")

    params = 0
    expected_input = hidden_size
    for position, layer in enumerate(layers):
        if not isinstance(layer, dict):
            raise HeadError("jev-head-invalid")
        weight = layer.get("weight")
        bias = layer.get("bias")
        if not isinstance(weight, list) or not weight or not isinstance(bias, list):
            raise HeadError("jev-head-invalid")
        if len(bias) != len(weight):
            raise HeadError("jev-head-invalid")
        for row in weight:
            if not isinstance(row, list) or len(row) != expected_input:
                raise HeadError("jev-head-invalid")
            if not all(isinstance(cell, (int, float)) and math.isfinite(cell) for cell in row):
                raise HeadError("jev-head-invalid")
            params += len(row)
        if not all(isinstance(cell, (int, float)) and math.isfinite(cell) for cell in bias):
            raise HeadError("jev-head-invalid")
        params += len(bias)
        expected_input = len(weight)
        if position == 0 and len(layers) == 2 and len(weight) > MAX_HIDDEN:
            raise HeadError("jev-head-invalid")
    if expected_input != len(LABELS):
        raise HeadError("jev-head-invalid")
    if params > MAX_PARAMS:
        raise HeadError("jev-head-too-large")
    return raw


def load_head(heads_dir, slug: str, *, revision: str):
    """Read and validate `<heads_dir>/<slug>.json`.

    `slug` is matched against a fixed charset BEFORE it touches the filesystem,
    and the resolved path is required to stay inside `heads_dir` — the sidecar
    accepts a head name from a local caller, and a name is not a path.
    """
    if not isinstance(slug, str) or not SLUG.match(slug):
        raise HeadError("jev-head-invalid")
    root = Path(heads_dir).resolve()
    path = (root / f"{slug}.json").resolve()
    if path.parent != root or not path.is_file():
        raise HeadError("jev-head-not-found")
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        raise HeadError("jev-head-unreadable")
    return validate_head(raw, revision=revision)


def apply_head(head, pooled):
    """Run a validated head over one pooled vector, returning label probabilities.

    Plain Python arithmetic, not a torch graph: the head is at most a couple of
    thousand multiply-accumulates per pair on top of a 4B forward pass, and
    keeping it here means the applied maths is the same code an operator can
    read next to the weights they are being asked to adopt.
    """
    activations = list(pooled)
    layers = head["layers"]
    for position, layer in enumerate(layers):
        weight = layer["weight"]
        bias = layer["bias"]
        activations = [
            sum(cell * value for cell, value in zip(row, activations)) + offset
            for row, offset in zip(weight, bias)
        ]
        # ReLU between layers only. The final layer emits logits, which the
        # softmax below turns into the same distribution the stock classifier
        # head produces — so everything downstream is unchanged.
        if position < len(layers) - 1:
            activations = [value if value > 0 else 0.0 for value in activations]
    ceiling = max(activations)
    exponentiated = [math.exp(value - ceiling) for value in activations]
    total = sum(exponentiated)
    return {label: value / total for label, value in zip(LABELS, exponentiated)}
