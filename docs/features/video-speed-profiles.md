# Video speed profiles

A **speed profile** is a named, pre-validated sampler configuration a user picks
in Video Gen instead of hand-tuning Steps and CFG. Selecting one swaps the whole
schedule at once — stage-1 and stage-2 step counts, guidance, and runtime
acceleration levers such as TeaCache — for a documented wall-time saving.

Shipped today: **Fast** on `ltx25_mlx_q8` (LTX-2.5 MLX Q8), labelled
`~35-45% faster`.

That label is deliberately conservative and traceable to the only numbers this
repo can cite: the step schedule measured ~30-35% off wall time in the
`PORTOS_T2V_TWO_STAGE` experiment (~1.4-1.5x), and the pin documents ~1.2x for
TeaCache at its calibrated threshold — ~1.7-1.85x combined. It is deliberately
not "2x", which would outrun the evidence, and on a pin without the TeaCache
kwarg the cache half degrades away entirely. Raise it only against an A/B
measured on 2.5 itself.

## Why it exists

The pinned `ltx-2-mlx` two-stage pipeline has always accepted
`enable_teacache` / `teacache_thresh` on `generate_and_save`, and PortOS never
passed either — so every LTX T2V/I2V render left a real, upstream-calibrated
speed lever switched off. The step schedule itself was also only reachable
through the hidden `PORTOS_T2V_TWO_STAGE` env experiment, which fires on a
"plain default render" heuristic and cannot be seen, chosen, or recorded.

This feature promotes that schedule to a user-facing choice, adds the TeaCache
lever alongside it, and — the part that makes it honest — reports what the
runner *actually* managed to apply.

## The honesty contract

Three rules govern the whole feature.

**1. Quality is a no-op, not a variant.** `SPEED_PROFILE_DEFAULT_ID`
(`'quality'`) resolves to `null`. A default render builds byte-identical spawn
args to one from before this feature existed and stamps no extra history
fields. Absence and `'quality'` are the same request on the client, in the
route, and in the service.

**2. An incompatible request degrades — it never 400s and never half-applies.**
A knob that only makes a render faster must not reject a submitted job. When a
profile can't apply, the render proceeds at the model's own sampler and the
reason is logged. `speedProfileDeclineReason()` returns (rather than throws) one
of:

| Code | When |
| --- | --- |
| `SPEED_PROFILE_UNSUPPORTED` | the model declares no such profile — including a forked/custom entry, or one whose `repo`/`revision` moved off the validated pin |
| `SPEED_PROFILE_MODE_UNSUPPORTED` | the mode routes through a different pipeline (`fflf`, `extend`, `a2v`, `ic-*`) than the schedule was measured on |
| `SPEED_PROFILE_SAMPLER_LOCKED` | the model pins its own validated schedule, so a profile would be a second authority over the same dials |

The UI applies the same mode gate, so a profile the server would decline is
never offered — a picker entry that silently does nothing is exactly the dead
speed affordance this replaces.

**Chained renders decline as a unit.** A chain is one clip, but its chunks do
not all run in the request's mode: chunk 0 keeps it, and chunks 1+ re-enter as
`extend` on a window-continuity chain (the default) or `image` on a frame hop.
`extend` routes through `ExtendPipeline`, which no two-stage profile is
validated for — so applying the profile per chunk would render chunk 0 fast and
the rest at the model default, stitching a visible seam mid-clip and inflating
the chain ETA. `resolveVideoSpeedProfileForModes()` therefore applies the
profile to every chunk or to none, and the decision is made once and pushed
down rather than re-derived per chunk.

**3. An unavailable lever is reported, not assumed.** Two questions can only be
answered inside the render process: is the pinned pipeline new enough to accept
`enable_teacache`, and is the distilled adapter the schedule was measured with
actually inside the model pack? `scripts/generate_ltx2.py` probes both, emits a
`STATUS:` line for each one it can't apply, and finishes with a single
`SPEEDPROFILE:<json>` line naming the outcome:

```json
{"id":"fast","steps":8,"stage2Steps":3,"cfgScale":1.0,
 "teacache":false,"teacacheThresh":null,
 "adapter":"ltx-2.3-22b-distilled-lora-384.safetensors",
 "degraded":["teacache","adapter"]}
```

The render still happens at the profile's step schedule; it is just slower than
the label promises, and the user is told so rather than left with a stopwatch —
both live (a `STATUS:` line during the render) and after the fact (the lightbox
shows `Speed profile: fast — reduced: teacache unavailable`).

## Where each piece lives

| Concern | Location |
| --- | --- |
| The declarative table + all resolution logic | `server/lib/videoSpeedProfiles.js` |
| Attached to registry entries at load | `applyVideoSpeedProfiles` in `server/lib/mediaModels.js` |
| Durable on disk for existing installs | `scripts/migrations/295-video-speed-profiles.js` |
| Request field | `speedProfileId` in `LOCAL_ONLY_VIDEO_PARAMS` (`server/routes/videoGen.js`) |
| Applied to the render | `resolveVideoSpeedProfile` + `resolveVideoSampler` in `server/services/videoGen/local.js` |
| Runner levers + capability probe | `--speed-profile` / `--teacache` / `--require-adapter` in `scripts/generate_ltx2.py` |
| Outcome parsed back | `SPEEDPROFILE:` in `server/services/videoGen/generateVideoHelpers.js` |
| Picker | `client/src/components/videoGen/AdvancedParamsPanel.jsx` |

## Sampler precedence

`resolveVideoSampler()` is the single place this is decided, shared by the
render path and the chained-render ETA so the two cannot drift:

1. `model.samplerLocked` — the model's own validated schedule, over everything.
2. An applicable speed profile — drives steps **and** guidance together.
3. An explicit `steps` / `guidanceScale` from the request.
4. The model's registry defaults.

A profile outranking explicit values is deliberate, and mirrors `samplerLocked`:
the UI disables both inputs while a profile is active, and a direct API caller
that sends both gets the profile it asked for rather than a hybrid whose speed
claim would be false.

## ETA bucketing

`server/services/videoGen/eta.js` scopes its samples to the model **and** the
speed profile. Unlike mode and LoRAs — which that module deliberately leaves out
of the sample key — a profile moves the cost curve's *slope* rather than adding
variance around it (CFG 1.0 drops the negative branch entirely, stage 2 runs
fewer steps, TeaCache skips residuals). Pooling the buckets would systematically
over-estimate every fast render and under-estimate every quality one.

The cost is that the first renders on a newly-picked profile show no estimate at
all. That is the same contract a newly-added model already has, and this module
treats a confidently wrong number as strictly worse than none.

## Adding a profile

1. Add it to `VIDEO_SPEED_PROFILES` under the entry id, with `shippedRepo` and
   `shippedRevision` set to the weights the schedule was **measured** against.
   Both are guarded: a re-pointed entry keeps no profile.
2. Set `modes` to only the modes that route through the pipeline you measured.
3. Name any adapter the schedule depends on in `requiresAdapter`, so a pack
   without it degrades loudly instead of rendering slower than the label claims.
4. Nothing to regenerate for fresh installs: there is no `data.reference/media-models.json`
   seed (removed in #8443). `DEFAULT_REGISTRY` in `server/lib/mediaModels.js` runs the
   shipped entries through `applyVideoSpeedProfiles`, so a fresh install picks the new
   profile up from the table above. Extend migration 295's coverage only if you are
   shipping to an entry id it does not already reach, so existing installs get the profile
   written into their `data/media-models.json`.

`validateSpeedProfileTable()` / `sanitizeSpeedProfiles()` warn about and strip a
malformed profile at load, so a hand-edited `data/media-models.json` can never
offer a schedule that would spawn a broken render.
