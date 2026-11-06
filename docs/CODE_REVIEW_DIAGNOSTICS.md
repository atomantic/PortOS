# Diagnosing CLI review deadlines

A timed-out review is inconclusive. Optional reviewer availability failures remain
non-blocking; required failures remain review-blocked. No timeout creates a verdict
or model attribution.

CLI reviews use a **30-minute inactivity window** by default. Any stdout or stderr
activity renews the window and the shared batch deadline. Active reasoning can
therefore run longer than 30 minutes, with no overall wall-clock cutoff. A stored
provider timeout other than the generic 300-second default, or an explicit
`timeoutMs`, selects a different silence window. The independent batch-call limit
still applies. API/local-runtime transport budgets retain their existing behavior.
This is a liveness policy: output demonstrates activity, not correctness or useful
progress. Only a validated final verdict can approve a review.

CLI reviews now carry `diagnostics.cli` in each batch's coverage record. Failures
also carry it at the top level and in reviewer health. Values are a closed phase
vocabulary, millisecond offsets and byte counts. Raw output, argv, prompts, paths,
credentials and account identifiers are excluded. Missing observations are null.

| Phase | Observation at settlement | Next diagnostic step |
| --- | --- | --- |
| `no-output` | Silence window elapsed without stdout or stderr | Check CLI startup and provider connectivity using the configured credential transport. Silence does not prove the provider received a request. |
| `output-open` | Output arrived, but no process exit was observed | Compare first/last activity with the deadline; inspect the private vendor transcript for a stalled response or CLI loop. Output can be startup logging, not a model answer. |
| `exit-drain` | Process exited, but its output pipes did not close | Investigate wrapper/descendant pipe ownership before blaming model latency. |
| `closed` | Process and pipes closed | Inspect the validated verdict or parse failure. Closing is not approval. |
| `spawn-failed` | The process boundary failed before close | Diagnose the launch failure. |

`spawnMs`, `firstOutputMs`, `lastOutputMs`, `exitMs` and `closeMs` are offsets from
process launch preparation. `elapsedMs` is time to settlement; `idleMs` is time since the last observed
output and `inactivityTimeoutMs` records the configured silence window. `parseMs` measures
the synchronous close-handler reduction, not model reasoning. `preparationMs`
measures the review service's imports, scratch creation and credential setup before
dispatch; `teardownMs` measures scratch removal. `stdoutBytes` and `stderrBytes`
count received bytes, without retaining their text in diagnostics. Grok also reports
observed `thoughtEvents`, `textEvents` and `endEvents`, without their contents; other
CLIs leave those counts unknown. Thought events establish reasoning-stream activity,
not a final answer or a validated verdict. These observations
do not establish time spent inside the remote provider. A killed child may close
later; timeout diagnostics deliberately describe the deadline, not the later close.

## Synthetic probe

Run only when explicitly investigating review availability. From the installation,
create a request with an ordinary synthetic diff, then pipe that request to
`node server/scripts/run-local-code-review.mjs`. Keep the response private and report
only validated outcome, phase, times and counts. This starts a real configured
provider call; it is never a boot check or automatic retry.

```js
// Save this generator outside the source checkout; pipe its stdout to the bridge.
const diff = Array.from({ length: 100 }, (_, i) =>
  `diff --git a/src/item${i}.js b/src/item${i}.js\n` +
  `--- a/src/item${i}.js\n+++ b/src/item${i}.js\n` +
  `@@ -1,3 +1,3 @@\n export function item${i}(value) {\n` +
  `-  return value || 'default';\n+  return value ?? 'default';\n }\n`
).join('');
process.stdout.write(JSON.stringify({
  backend: 'provider:grok-cli', model: 'grok-4.7', effort: 'medium',
  inheritDefaults: false, kind: 'claim-review', toolFree: true, diff,
}));
```

On 2026-11-06 one 19,450-byte synthetic probe used the pinned model/effort,
tool-free CLI recipe, scratch isolation and a 600-second deadline. It returned a
validated clean envelope: first output 649 ms, last output 10,990 ms, process exit
and pipe close 15,039 ms, stdout 11,244 bytes, stderr zero. This was a CLI-boundary
probe with a synthetic review prompt, not a historical failed review replay.
It demonstrates successful execution for that input only. It does not reproduce
or explain the prior 600-second failures in #15122. Preserve that issue until the activity-aware policy is verified against a long-running review. Do not increase the budget or enable tools to obtain a verdict.


A second, full-bridge one-file synthetic review on the same scratch-directory path
returned a validated clean verdict in 11,674 ms (first output 320 ms, last output
7,575 ms, stderr zero). A 28,135-byte branch review reached its 600-second deadline
with 185,883 stdout bytes, last output at 598,957 ms, no stderr and no process exit.
A subsequent private trace showed growing `thought` events and no `text` or `end`
events during its first minute. This establishes that the request reached Grok's
reasoning stream; a basic scratch-directory access failure is not supported by
these observations. It does not identify why the model takes so long on this
input or establish an internal vendor cause. Raw stream content stays private.
