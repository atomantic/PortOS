#!/usr/bin/env python3
"""Fit a project-specific head on the FROZEN jev encoder, and score it honestly.

Run inside the dedicated `venv-jev` by `server/services/jevTraining.js`. Fully
offline: `HF_HUB_OFFLINE=1` is set by the caller, every load is
`local_files_only`, `trust_remote_code` is never set, and nothing here contacts
a provider or downloads a second model. The encoder is never updated — only the
small head on top of it is.

  --corpus <train.jsonl> --gold <gold.jsonl>   Route A: {"context","options","label"}
  --model-dir <pinned snapshot>                the SAME checkpoint the sidecar loads
  --out <head.json>                            the candidate artifact
  --cache-dir <dir>                            frozen-encoder outputs, per (pair, revision)

Writes ONE JSON line to stdout: the training report, carrying the trained
head's accuracy on the held-out gold set beside BOTH baselines it has to beat —
the checkpoint's own zero-shot classifier and the majority class. Whether the
head may be adopted is decided from those numbers on the Node side
(`headBeatsBaselines` in server/lib/jevHead.js); this script never promotes
anything and has no idea where an adopted head lives.

## Why the cache matters

The dominant cost is one 4B forward pass per (context, option) pair, and a
hyperparameter sweep re-uses every one of them. Cached by a hash of the pair
plus the encoder revision, a second run costs seconds instead of minutes — and
a cache from a different revision can never be read back, because the revision
is part of the key rather than a field beside it.
"""

import argparse
import hashlib
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

# This file's own directory, so the sibling import below resolves however the
# script was loaded — including under `runpy.run_path`, which does not put it on
# the path the way a normal `python <path>` spawn does.
sys.path.insert(0, str(Path(__file__).resolve().parent))

from jev_head_kit import HEAD_SCHEMA_VERSION, LABELS, MAX_HIDDEN, POOLING, pool_pair  # noqa: E402 - needs the sys.path line above.

ENTAILMENT = LABELS.index("entailment")
NEUTRAL = LABELS.index("neutral")


def read_corpus(path: Path):
    """Read Route A JSONL, dropping any row that is not a usable example."""
    rows = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            row = json.loads(line)
        except ValueError:
            continue
        options = row.get("options")
        label = row.get("label")
        context = row.get("context")
        if not isinstance(context, str) or not context.strip():
            continue
        if not isinstance(options, list) or len(options) < 2:
            continue
        if not all(isinstance(option, str) and option.strip() for option in options):
            continue
        if not isinstance(label, int) or not 0 <= label < len(options):
            continue
        rows.append({"context": context, "options": options, "label": label})
    return rows


def pair_key(revision: str, context: str, hypothesis: str) -> str:
    """Cache key for one encoded pair.

    The revision is part of the KEY, not a field stored beside it: a cache
    written against one checkpoint must be unreadable by another rather than
    readable-and-wrong.
    """
    digest = hashlib.sha256()
    for part in (revision, POOLING, context, hypothesis):
        digest.update(part.encode("utf-8"))
        digest.update(b"\x00")
    return digest.hexdigest()


def encode_corpus(state, rows, cache_dir: Path, revision: str, on_progress):
    """Embed every (context, option) pair once, reading and filling the cache.

    Returns a list parallel to `rows`, each entry holding one pooled vector and
    one stock-classifier logit vector per option.
    """
    cache_dir.mkdir(parents=True, exist_ok=True)
    encoded = []
    total = sum(len(row["options"]) for row in rows)
    done = 0
    for row in rows:
        pooled_options = []
        stock_options = []
        for hypothesis in row["options"]:
            path = cache_dir / f"{pair_key(revision, row['context'], hypothesis)}.json"
            cached = None
            if path.is_file():
                try:
                    cached = json.loads(path.read_text(encoding="utf-8"))
                except (OSError, ValueError):
                    cached = None
            if not isinstance(cached, dict) or "pooled" not in cached or "stock" not in cached:
                pooled, stock = pool_pair(state, row["context"], hypothesis)
                cached = {"pooled": pooled, "stock": stock}
                path.write_text(json.dumps(cached, separators=(",", ":")), encoding="utf-8")
            pooled_options.append(cached["pooled"])
            stock_options.append(cached["stock"])
            done += 1
            on_progress(done, total)
        encoded.append({"pooled": pooled_options, "stock": stock_options, "label": row["label"]})
    return encoded


def choose(scores_per_option):
    """Pick the option with the highest entailment probability."""
    return max(range(len(scores_per_option)), key=lambda index: scores_per_option[index])


def stock_accuracy(encoded, torch):
    """The checkpoint's OWN zero-shot accuracy on these examples.

    The first baseline, and the one that matters: it needs no corpus, no
    training run and no privacy argument, so a head that cannot beat it has
    bought nothing at a real cost.
    """
    if not encoded:
        return None
    correct = 0
    for example in encoded:
        probabilities = [
            torch.softmax(torch.tensor(logits), dim=-1)[ENTAILMENT].item()
            for logits in example["stock"]
        ]
        correct += int(choose(probabilities) == example["label"])
    return correct / len(encoded)


def majority_accuracy(encoded):
    """Accuracy of always predicting the most common gold label."""
    if not encoded:
        return None
    counts = {}
    for example in encoded:
        counts[example["label"]] = counts.get(example["label"], 0) + 1
    return max(counts.values()) / len(encoded)


def build_pair_dataset(encoded, torch):
    """Flatten examples into per-pair NLI rows.

    The chosen option becomes `entailment`; every other option becomes
    `neutral`, NOT `contradiction`. An option the maintainer did not take is
    unsupported by the change, not refuted by it — and training the third label
    on evidence that never meant refutation would teach the head to say
    "contradicts", which is the one verdict this feature reports that a human
    would go and argue with.
    """
    vectors = []
    targets = []
    for example in encoded:
        for index, pooled in enumerate(example["pooled"]):
            vectors.append(pooled)
            targets.append(ENTAILMENT if index == example["label"] else NEUTRAL)
    return torch.tensor(vectors, dtype=torch.float32), torch.tensor(targets, dtype=torch.long)


def fit_head(train_encoded, torch, *, architecture: str, hidden: int, epochs: int, seed: int):
    """Fit the head. The encoder is untouched — only these layers are trained."""
    torch.manual_seed(seed)
    features, targets = build_pair_dataset(train_encoded, torch)
    hidden_size = features.shape[1]
    modules = []
    if architecture == "mlp1":
        modules += [torch.nn.Linear(hidden_size, hidden), torch.nn.ReLU()]
        modules.append(torch.nn.Linear(hidden, len(LABELS)))
    else:
        modules.append(torch.nn.Linear(hidden_size, len(LABELS)))
    model = torch.nn.Sequential(*modules)

    # Class weights, because the flattened dataset is imbalanced BY
    # CONSTRUCTION: a k-option decision produces one entailment row per k-1
    # neutral ones, so an unweighted fit would learn to answer "neutral" and
    # score well doing it.
    counts = torch.bincount(targets, minlength=len(LABELS)).float()
    weights = torch.where(counts > 0, counts.sum() / (counts * (counts > 0).sum()), torch.zeros_like(counts))
    loss_fn = torch.nn.CrossEntropyLoss(weight=weights)
    # Weight decay, not early stopping: the gold split is the adoption
    # evidence, and touching it to decide when to stop would make the score it
    # reports a validation score the head was tuned against.
    optimizer = torch.optim.AdamW(model.parameters(), lr=1e-3, weight_decay=1e-2)
    for _ in range(epochs):
        optimizer.zero_grad()
        loss = loss_fn(model(features), targets)
        loss.backward()
        optimizer.step()
    return model, hidden_size, float(loss.item())


def head_accuracy(model, encoded, torch):
    """The trained head's accuracy, scored the way inference scores."""
    if not encoded:
        return None
    correct = 0
    with torch.inference_mode():
        for example in encoded:
            features = torch.tensor(example["pooled"], dtype=torch.float32)
            probabilities = torch.softmax(model(features), dim=-1)[:, ENTAILMENT].tolist()
            correct += int(choose(probabilities) == example["label"])
    return correct / len(encoded)


def serialize_layers(model, torch):
    """Row-major `[out][in]` weights plus biases, matching `apply_head`."""
    layers = []
    for module in model:
        if isinstance(module, torch.nn.Linear):
            layers.append({
                "weight": module.weight.detach().to("cpu").tolist(),
                "bias": module.bias.detach().to("cpu").tolist(),
            })
    return layers


def emit(payload):
    sys.stdout.write(json.dumps(payload, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def main() -> int:
    parser = argparse.ArgumentParser(description="Fit a project-specific head on the frozen jev encoder.")
    parser.add_argument("--model-dir", required=True)
    parser.add_argument("--corpus", required=True)
    parser.add_argument("--gold", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--cache-dir", required=True)
    parser.add_argument("--decision-id", required=True)
    parser.add_argument("--model-id", required=True)
    parser.add_argument("--repository", required=True)
    parser.add_argument("--revision", required=True)
    parser.add_argument("--corpus-hash", required=True)
    parser.add_argument("--corpus-sources", default="")
    parser.add_argument("--architecture", default="linear", choices=["linear", "mlp1"])
    parser.add_argument("--hidden", type=int, default=64)
    parser.add_argument("--epochs", type=int, default=400)
    parser.add_argument("--seed", type=int, default=17)
    args = parser.parse_args()

    if not 1 <= args.hidden <= MAX_HIDDEN:
        emit({"ok": False, "code": "jev-head-invalid"})
        return 1

    train_rows = read_corpus(Path(args.corpus))
    gold_rows = read_corpus(Path(args.gold))
    if not train_rows or not gold_rows:
        emit({"ok": False, "code": "jev-corpus-too-small"})
        return 1

    # The overlap refusal is enforced on the Node side before this runs
    # (`assertSplitDisjoint`), and AGAIN here on the files actually handed over:
    # a contaminated gold set reports a score that is partly memorization, and
    # that score is the only evidence the adoption gate reads.
    gold_keys = {pair_key(args.revision, row["context"], "\u0000".join(row["options"])) for row in gold_rows}
    train_keys = {pair_key(args.revision, row["context"], "\u0000".join(row["options"])) for row in train_rows}
    if gold_keys & train_keys:
        emit({"ok": False, "code": "jev-corpus-split-overlap"})
        return 1

    # Imported HERE, not at module scope: argument validation and the corpus
    # read above must fail in milliseconds, not after a multi-second torch
    # import that a malformed request never needed.
    import torch
    from transformers import AutoModelForSequenceClassification, AutoTokenizer

    torch.set_num_threads(1)
    model_dir = Path(args.model_dir)
    tokenizer = AutoTokenizer.from_pretrained(str(model_dir), local_files_only=True, trust_remote_code=False)
    encoder = AutoModelForSequenceClassification.from_pretrained(
        str(model_dir), local_files_only=True, trust_remote_code=False, use_safetensors=True,
    )
    device = "mps" if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available() else "cpu"
    encoder.to(device)
    encoder.eval()
    # FROZEN. The whole design rests on this: only the head below is fit.
    for parameter in encoder.parameters():
        parameter.requires_grad_(False)

    config = encoder.config
    template = getattr(config, "nli_template", None)
    if not isinstance(template, str) or "{premise}" not in template or "{hypothesis}" not in template:
        template = "Premise: {premise}\nHypothesis: {hypothesis}"
    window = min(
        value for value in (
            getattr(tokenizer, "model_max_length", None),
            getattr(getattr(config, "text_config", None), "max_position_embeddings", None),
            getattr(config, "max_position_embeddings", None),
        ) if isinstance(value, int) and 0 < value < 10_000_000
    )
    state = {
        "torch": torch, "tokenizer": tokenizer, "model": encoder,
        "device": device, "template": template, "window": window,
    }

    cache_dir = Path(args.cache_dir)
    # Progress on stderr, never stdout: stdout carries exactly one line, the
    # report, so the Node side parses it without scanning for it.
    def progress(done, total):
        if done == total or done % 25 == 0:
            print(f"encoded {done}/{total}", file=sys.stderr, flush=True)

    train_encoded = encode_corpus(state, train_rows, cache_dir, args.revision, progress)
    gold_encoded = encode_corpus(state, gold_rows, cache_dir, args.revision, progress)

    head_model, hidden_size, final_loss = fit_head(
        train_encoded, torch,
        architecture=args.architecture, hidden=args.hidden, epochs=args.epochs, seed=args.seed,
    )

    metrics = {
        "trained": head_accuracy(head_model, gold_encoded, torch),
        "stockZeroShot": stock_accuracy(gold_encoded, torch),
        "majorityClass": majority_accuracy(gold_encoded),
        "goldSize": len(gold_encoded),
        "trainSize": len(train_encoded),
    }

    head = {
        "schemaVersion": HEAD_SCHEMA_VERSION,
        "decisionId": args.decision_id,
        "architecture": args.architecture,
        "pooling": POOLING,
        "baseModel": {"id": args.model_id, "repository": args.repository, "revision": args.revision},
        "hiddenSize": hidden_size,
        "labels": list(LABELS),
        "layers": serialize_layers(head_model, torch),
        "metrics": metrics,
        "corpusHash": args.corpus_hash,
        "corpusSources": [part for part in args.corpus_sources.split(",") if part],
        "trainedAt": datetime.now(timezone.utc).isoformat(),
    }
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(head, separators=(",", ":")), encoding="utf-8")

    emit({"ok": True, "metrics": metrics, "finalLoss": final_loss, "device": device})
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        raise SystemExit(0)
    except Exception:  # noqa: BLE001 - CLI boundary must fail closed without leaking input or paths.
        emit({"ok": False, "code": "jev-head-training-failed"})
        raise SystemExit(1)
