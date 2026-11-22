# Autonomous job reliability

Three local primitives keep unattended scheduled jobs quiet and recoverable (no LLM call is made by any of them):

- **Preflight** (`autonomousJobs/preflight.js`): before a scheduled fire reserves capacity or builds a task, a pinned provider must exist, be enabled and hold its API key; an `appId` must resolve to a repo path on disk; a shell command must pass `validateCommand`; a script handler must be registered. A failure sets `lastStatus: 'blocked_config'` (with `lastStatusReason`), advances the schedule like a gate skip and raises one incident. The verdict clears on the next healthy run. Manual "Run now" is unaffected.
- **Incidents** (`autonomousJobs/incidents.js`, rules in `lib/autonomousJobIncidents.js`): failures normalize to a signature (timestamps, durations, ids and counters stripped, secrets redacted) and persist machine-locally in `data/cos/autonomous-job-incidents.json`. The first failure of a `(jobId, signature)` notifies; identical repeats count silently until the 6h reminder cooldown; a new signature alerts at once; a successful run resolves open incidents; an acknowledged incident stays quiet until a new signature appears. `JobCard` shows the badge and an Acknowledge action.
- **Unreachable retry ladder** (`cosJobScheduler.js`): a spawn that fails with a network/DNS error never started an agent, so no model was reached. It retries at 5m → 15m → 30m instead of waiting a full period, never past the job's next natural fire, with the alert withheld until the ladder is exhausted. The step (`unreachableRetryStep`) resets on any recorded run.

The incident routes are listed in the [Chief of Staff API table](./chief-of-staff.md#api-endpoints).
