# Decision classifiers

**Models → Decision Classifiers** groups closed-set decision systems separately
from chat models. Each classifier has a shareable URL and remains discoverable
when disabled. The old `/models/llms/jev` URL redirects to
`/models/decision-classifiers/jev`; its command-palette identity remains stable.

## Jev

Jev retains installation, manual scoring, trained-head adoption, integration
switches, per-source policies and agreement counters. Its stored feature ID,
API endpoints and defaults are unchanged. Disabling Jev integrations does not
disable its explicit manual experiments. No migration is necessary.

Jev opens **Try a decision**, with input and evidence alongside each other on
wide screens. **Integrations**, **Results**, **Training**, and **Setup** have
shareable URLs under `/models/decision-classifiers/jev/`. Local view switches
retain drafts, the last score and active work; reloading does not persist text
drafts. Legacy `/models/llms/jev/:taskView` links redirect to the corresponding
view. Installation, scoring, training and adoption still require explicit actions.

## Laya-MLX

`/models/decision-classifiers/laya-mlx` offers native Apple Silicon experiments
using the 322M multilingual checkpoint. Windows and Intel hosts can discover it
but cannot install or run it; Jev remains a separate choice.

1. Install a native Apple Silicon Python 3.11+ on macOS 14+.
2. Click **Install Laya-MLX** to create a dedicated environment, install the
   pinned runtime, download approximately 650 MB of weights, and verify loading.
   Additional disk space is needed for runtime dependencies.
3. Enable experiments, supply a question, premise and 2–12 distinct options,
   then click **Run experiment**. Installation and enablement are separate.

The runtime Git revision and multilingual weight revision are pinned in
`server/lib/layaMlx.js`. Setup downloads only on an explicit action. Status
reads local installation metadata and file presence; it never loads a model.
Scoring runs offline, passes the premise through stdin, and releases the process
and model after each request. Only one experiment or installation can run at a
time. A request has a two-minute timeout and disconnect cancellation. Disable
blocks subsequent experiments; it does not cancel one already in flight.

The checkpoint has a 1,024-token combined budget, with a smaller question/options
budget. PortOS rejects over-budget input and option labels that upstream would
truncate, rather than classifying a partial premise. The UI reports normalized
choice probabilities, entropy confidence, winner/runner-up margin and total
elapsed time including process/model startup. These are not Jev entailment
probabilities or upstream warm-inference latency measurements. Ties always
abstain, including at a zero margin floor.

Laya is currently a **manual experiment adapter**. Selecting or enabling it does
not replace Jev for triage, issue replies, scope checks or any other automation.
Its thresholds need task-specific evaluation before production adoption; no
speed or accuracy superiority is claimed by this integration. Additional
classifiers can add their own panel/adapter and declared route without changing
Jev's persisted policy format or pretending all scoring semantics are identical.

## Storage and privacy

The enable flag uses the existing machine-local instance-feature store. Runtime,
model and installation marker live under `data/python/laya-mlx/`, in the existing
rebuildable Python-runtime asset tree; they are not native app records or new
JSON collections. No new database schema, seed, migration or federation payload
is introduced. The anchored `/python/laya-mlx/` backup exclusion covers this rebuildable
installation. Inputs/results are memory-only and never enter logs, counters,
files, issue reports or federation. Errors returned by the service are bounded
codes, not subprocess output or paths.

## Sources

- [Laya-MLX runtime and requirements](https://github.com/mizorewww/laya-mlx/tree/fc1df62828a3fedf4d8229fdac1cbd85f1cdf337)
- [Pinned publication provenance](https://github.com/mizorewww/laya-mlx/blob/fc1df62828a3fedf4d8229fdac1cbd85f1cdf337/benchmarks/results/hub-publication.json)
- [Multilingual checkpoint](https://huggingface.co/aac6fef/laya-multilingual-mlx/tree/ba40c87fcb357f1643d04d71323af9cdc3b9e591)
