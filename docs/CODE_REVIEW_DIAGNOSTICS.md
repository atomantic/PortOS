# Diagnosing CLI review deadlines

A timed-out review is inconclusive. Optional reviewer availability failures remain
non-blocking; required failures remain review-blocked. No timeout creates a verdict
or model attribution. The remote review budget is unchanged.

CLI reviews now carry `diagnostics.cli` in each batch's coverage record. Failures
also carry it at the top level and in reviewer health. Values are a closed phase
vocabulary, millisecond offsets and byte counts. Raw output, argv, prompts, paths,
credentials and account identifiers are excluded. Missing observations are null.

| Phase | Observation at settlement | Next diagnostic step |
| --- | --- | --- |
| `no-output` | Deadline passed without stdout or stderr | Check CLI startup and provider connectivity using the configured credential transport. Silence does not prove the provider received a request. |
| `output-open` | Output arrived, but no process exit was observed | Compare first/last activity with the deadline; inspect the private vendor transcript for a stalled response or CLI loop. Output can be startup logging, not a model answer. |
| `exit-drain` | Process exited, but its output pipes did not close | Investigate wrapper/descendant pipe ownership before blaming model latency. |
| `closed` | Process and pipes closed | Inspect the validated verdict or parse failure. Closing is not approval. |
| `spawn-failed` | The process boundary failed before close | Diagnose the launch failure. |

`spawnMs`, `firstOutputMs`, `lastOutputMs`, `exitMs` and `closeMs` are offsets from
process launch preparation. `elapsedMs` is time to settlement. `parseMs` measures
the synchronous close-handler reduction, not model reasoning. `preparationMs`
measures the review service's imports, scratch creation and credential setup before
dispatch; `teardownMs` measures scratch removal. `stdoutBytes` and `stderrBytes`
count received bytes, without retaining their text in diagnostics. These observations
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
or explain the prior 600-second failures in #15122. Preserve that issue until a
failing run yields measured phase evidence and a proven fix or precise external
failure diagnosis. Do not increase the budget or enable tools to obtain a verdict.
