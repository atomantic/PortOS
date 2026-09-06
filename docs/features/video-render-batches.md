# Warm video render batches

In Video Gen, **Advanced → Renders in batch** selects 1–20 separate videos using
one prompt, model and set of conditioning inputs. **Generate** and **Add to queue**
show the requested count. The default is one render.

- Leave **Seed** blank, or click its dice button, for an independent random seed
  on every render.
- Enter a seed for consecutive seeds: a batch of three starting at `0` renders
  with `0`, `1`, and `2`. Seeds must remain within the unsigned 32-bit range;
  an overflowing batch is rejected before it is queued.
- A batch owns one local queue slot until it finishes or is canceled. Each
  finished video is saved to history with its actual seed. Canceling or failing
  a later render preserves the earlier finished videos.

Warm batching currently supports the **MiniMax H3 MLX** runtime. One Python
process loads its pipeline and adapters once, retains its model weights and
modulation cache, and reuses the request's prompt embeddings in memory. Each
video is rendered and saved before the next starts; decoded outputs are released
between renders. This reuse does not depend on the optional disk prompt cache.

Other runtimes, cloud providers and federated targets do not offer this control.
In particular, LTX's two-stage pipeline fuses an adapter into its transformer and
unloads components between stages; looping that pipeline with retained weights
would change subsequent renders. Support requires a runtime-specific contract,
not merely launching the existing command repeatedly.

Batches produce independent clips, so they cannot be combined with chained
chunks or a scene-delivery tag. Batch records carry additive `batchId`,
`batchIndex` (zero-based) and `batchSize` metadata. Their durations do not train
single-render ETA estimates because startup is shared across the batch.
