#!/usr/bin/env python3
"""Serve the pinned openjev entailment scorer on a loopback port.

Unlike `run_prompt_guard.py`, which classifies one item per process, this is a
long-lived sidecar: the Node service starts it on first use and reaps it after
an idle period. A 4B checkpoint costs far too much to load per request, and the
scorer is meant to answer dozens of closed-set questions per sweep.

It is deliberately a classifier, not an agent: it accepts no tools, fetches no
URLs, executes no repository code, and never emits the premise or hypothesis
text back in an error.

  POST /score   {"premise": str, "hypotheses": [str, ...], "head": str|None}
             -> {"schemaVersion": 1, "complete": true, "scores": [...]}
  GET  /health -> {"ready": bool, "model": str, "revision": str, "device": str}

`head` names a project-specific trained head under `--heads-dir` (see
`jev_head_kit.py`). It replaces the checkpoint's own classifier layer on a
FROZEN encoder, emits the same three labels in the same order, and is refused
outright when it was fit on a different model revision. Absent or null, the
stock zero-shot classifier answers exactly as it always has.
"""

import argparse
import json
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Lock

# This file's own directory, so the sibling import below resolves however the
# script was loaded. A normal `python <path>` spawn already puts it on the path;
# `runpy.run_path` (which the wire-contract test uses to drive this file with
# synthetic model doubles) does not.
sys.path.insert(0, str(Path(__file__).resolve().parent))

from jev_head_kit import HeadError, apply_head, load_head, pool_pair  # noqa: E402 - needs the sys.path line above.

# Mirrors of the bounds in server/lib/jev.js. Repeated rather than imported so
# this boundary still holds if the script is ever invoked directly.
MAX_PREMISE_CHARS = 32_000
MAX_HYPOTHESES = 32
MAX_HYPOTHESIS_CHARS = 512
MAX_BODY_BYTES = 256_000
LOOPBACK_HOSTS = ("127.0.0.1", "::1")

# The model's own label order, from the pinned config's `id2label`.
LABELS = ("contradiction", "entailment", "neutral")
# Used only when the checkpoint's config omits its own `nli_template`.
FALLBACK_TEMPLATE = "Premise: {premise}\nHypothesis: {hypothesis}"


class JevError(Exception):
    """A failure the Node service can map to a code without reading text."""

    def __init__(self, code: str, status: int = 400) -> None:
        super().__init__(code)
        self.code = code
        self.status = status


def validate_request(payload):
    """Validate a scoring request. Never returns partial input on failure."""
    if not isinstance(payload, dict):
        raise JevError("jev-request-invalid")
    premise = payload.get("premise")
    hypotheses = payload.get("hypotheses")
    head = payload.get("head")
    if head is not None and not isinstance(head, str):
        raise JevError("jev-request-invalid")
    if not isinstance(premise, str) or not premise.strip():
        raise JevError("jev-request-invalid")
    if len(premise) > MAX_PREMISE_CHARS:
        raise JevError("jev-premise-too-large")
    if not isinstance(hypotheses, list) or not 1 <= len(hypotheses) <= MAX_HYPOTHESES:
        raise JevError("jev-request-invalid")
    for hypothesis in hypotheses:
        if not isinstance(hypothesis, str) or not hypothesis.strip():
            raise JevError("jev-request-invalid")
        if len(hypothesis) > MAX_HYPOTHESIS_CHARS:
            raise JevError("jev-request-invalid")
    return premise, hypotheses, head or None


def load_state(model_dir: Path):
    """Load the pinned snapshot once. Imports happen only after path checks."""
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
    # MPS where the host has it, CPU otherwise. Reported on /health so an
    # operator can tell a slow CPU fallback from a healthy accelerated load.
    device = "mps" if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available() else "cpu"
    model.to(device)
    model.eval()

    config = model.config
    template = getattr(config, "nli_template", None)
    if not isinstance(template, str) or "{premise}" not in template or "{hypothesis}" not in template:
        template = FALLBACK_TEMPLATE

    # The label mapping is read from the checkpoint rather than assumed: a
    # re-trained head with a permuted id2label would otherwise silently turn
    # every entailment score into a contradiction score.
    id_to_label = getattr(config, "id2label", None) or {}
    label_index = {}
    for class_id, label in id_to_label.items():
        name = str(label).strip().lower()
        if name in LABELS:
            label_index[name] = int(class_id)
    if len(label_index) != len(LABELS):
        raise JevError("jev-response-invalid", status=500)

    return {
        "torch": torch,
        "tokenizer": tokenizer,
        "model": model,
        "device": device,
        "template": template,
        "labelIndex": label_index,
        "window": resolve_window(tokenizer, config),
    }


def resolve_window(tokenizer, config) -> int:
    """The largest token count one pair may occupy.

    Transformers uses a sentinel-sized `model_max_length` for tokenizers that
    declare none, which would read as "everything fits" — so an implausible
    value falls through to the text config's position count.
    """
    candidates = []
    for value in (getattr(tokenizer, "model_max_length", None),
                  getattr(getattr(config, "text_config", None), "max_position_embeddings", None),
                  getattr(config, "max_position_embeddings", None)):
        if isinstance(value, int) and 0 < value < 10_000_000:
            candidates.append(value)
    if not candidates:
        raise JevError("jev-response-invalid", status=500)
    return min(candidates)


def score_with_head(state, head, premise: str, hypotheses):
    """Score every pair through a trained head on the FROZEN encoder.

    Identical contract to `score_pairs` — same labels, same order, same
    response shape — so nothing on the Node side can tell which classifier
    answered except by having asked for one.
    """
    return [
        {"hypothesis": hypothesis, **apply_head(head, pool_pair(state, premise, hypothesis)[0])}
        for hypothesis in hypotheses
    ]


def score_pairs(state, premise: str, hypotheses):
    """One forward pass per premise/hypothesis pair, in request order."""
    torch = state["torch"]
    tokenizer = state["tokenizer"]
    model = state["model"]
    label_index = state["labelIndex"]
    scores = []
    with torch.inference_mode():
        for hypothesis in hypotheses:
            text = state["template"].format(premise=premise, hypothesis=hypothesis)
            token_ids = tokenizer.encode(text, add_special_tokens=True, truncation=False)
            # Never truncate and then return a verdict on the prefix: a
            # decision about the first half of a diff is not a decision about
            # the diff, and nothing downstream could tell the difference.
            if len(token_ids) > state["window"]:
                raise JevError("jev-premise-too-large")
            model_inputs = {
                "input_ids": torch.tensor([token_ids]),
                "attention_mask": torch.tensor([[1] * len(token_ids)]),
            }
            probabilities = torch.softmax(model(**model_inputs).logits[0], dim=-1)
            scores.append({
                "hypothesis": hypothesis,
                **{label: float(probabilities[label_index[label]].item()) for label in LABELS},
            })
    return scores


def make_handler(state, model_id: str, revision: str, heads_dir):
    lock = Lock()
    # Validated heads, keyed by slug. A head is a few thousand floats, the
    # revision gate has already run, and the alternative is re-reading and
    # re-validating the same file on every forward pass.
    head_cache = {}

    def resolve_head(slug):
        if slug is None:
            return None
        if heads_dir is None:
            raise HeadError("jev-head-not-found")
        if slug not in head_cache:
            head_cache[slug] = load_head(heads_dir, slug, revision=revision)
        return head_cache[slug]

    class JevHandler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *_args):
            """Silence the default access log — request lines are not ours to keep."""

        def _respond(self, status: int, payload: dict) -> None:
            body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _is_loopback(self) -> bool:
            # Defence in depth: the socket is bound to loopback already, so a
            # remote peer cannot normally arrive here at all.
            return str(self.client_address[0]).split("%")[0] in LOOPBACK_HOSTS

        def do_GET(self):  # noqa: N802 - BaseHTTPRequestHandler's naming
            if not self._is_loopback():
                self._respond(403, {"error": "jev-request-invalid"})
                return
            if self.path != "/health":
                self._respond(404, {"error": "jev-request-invalid"})
                return
            self._respond(200, {
                "ready": True,
                "model": model_id,
                "revision": revision,
                "device": state["device"],
            })

        def do_POST(self):  # noqa: N802 - BaseHTTPRequestHandler's naming
            if not self._is_loopback():
                self._respond(403, {"error": "jev-request-invalid"})
                return
            if self.path != "/score":
                self._respond(404, {"error": "jev-request-invalid"})
                return
            length = self.headers.get("Content-Length")
            if not str(length or "").isdigit() or int(length) > MAX_BODY_BYTES:
                self._respond(400, {"error": "jev-request-invalid"})
                return
            raw = self.rfile.read(int(length))
            try:
                premise, hypotheses, head_slug = validate_request(json.loads(raw.decode("utf-8")))
                # One model, one accelerator queue: serialize so two concurrent
                # callers cannot interleave forward passes on the same weights.
                with lock:
                    head = resolve_head(head_slug)
                    scores = (score_with_head(state, head, premise, hypotheses) if head
                              else score_pairs(state, premise, hypotheses))
            except HeadError as error:
                # A head failure is the operator's to fix and must never fall
                # back to the stock classifier: they asked for the head that
                # their adoption decision was measured on, and silently
                # answering with a different one would make that measurement a
                # lie. Reported as its own code, not as a scoring failure.
                self._respond(400, {"error": error.code})
                return
            except JevError as error:
                self._respond(error.status, {"error": error.code})
                return
            except Exception:  # noqa: BLE001 - must fail closed without leaking input or paths.
                self._respond(500, {"error": "jev-response-invalid"})
                return
            self._respond(200, {"schemaVersion": 1, "complete": True, "scores": scores})

    return JevHandler


def main() -> int:
    parser = argparse.ArgumentParser(description="Serve openjev entailment scoring locally and offline.")
    parser.add_argument("--model-dir", required=True)
    parser.add_argument("--port", required=True, type=int)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--model-id", default="openjev")
    parser.add_argument("--revision", default="")
    # Optional: the directory holding adopted project-specific heads. A request
    # names a head by SLUG, never by path, and the slug is resolved inside this
    # directory — so an install that passes no heads directory has no way to
    # reach one, whatever a caller asks for.
    parser.add_argument("--heads-dir", default=None)
    args = parser.parse_args()

    if args.host not in LOOPBACK_HOSTS:
        raise ValueError("host must be loopback")
    if not 1 <= args.port <= 65535:
        raise ValueError("port is out of range")
    model_dir = Path(args.model_dir)
    if not model_dir.is_dir():
        raise ValueError("model snapshot is unavailable")

    # Deliberately NOT checked for existence here. The directory is created the
    # first time a head is saved, which may be long after this process started —
    # latching "no heads directory" at start-up would make a head adopted later
    # unreachable until the next cold start. `load_head` reports
    # `jev-head-not-found` when the file is absent, which is the same answer.
    heads_dir = Path(args.heads_dir) if args.heads_dir else None

    state = load_state(model_dir)
    server = ThreadingHTTPServer(
        (args.host, args.port),
        make_handler(state, args.model_id, args.revision, heads_dir),
    )
    # The single readiness signal the Node service waits on before polling
    # /health. Nothing else is ever written to stdout.
    sys.stdout.write(json.dumps({"ready": True, "port": args.port, "device": state["device"]}) + "\n")
    sys.stdout.flush()
    server.serve_forever()
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        raise SystemExit(0)
    except Exception:  # noqa: BLE001 - CLI boundary must fail closed without leaking input or paths.
        print("jev failed to start; verify the dedicated runtime and pinned model snapshot.", file=sys.stderr)
        raise SystemExit(1)
