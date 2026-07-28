# Unreleased Changes

## Added

- **Malware scans now leave a durable, reviewable report trail.** Git-link scans save an owned markdown artifact, surface it from the completed agent summary and Review Hub, and mark repositories with an explicit `DANGEROUS` verdict using a skull danger treatment on the Git links card.
- **Slashdo-free TUI agent PRs now complete their lifecycle.** Codex, Antigravity, OpenCode, and lean Claude agents hand committed work back to PortOS so it can generate a non-empty PR description, run configured reviewers, and merge after the selected gates pass instead of leaving an ownerless PR open.

## Agent workspaces

- **[issue-3180] Agents no longer run in the PortOS folder when your app's repository path is wrong** — picking an app as the workspace (in a CoS task, or Settings → Providers → Run Prompt) and asking the agent to create a file could put the file in the PortOS directory instead of your app. If the app's Repository Path was empty, mistyped, or pointed somewhere that no longer exists, PortOS quietly fell back to its own folder and said nothing, so the run looked like it had worked. Now PortOS names the directory it chose for every run and in the CoS task log; a run whose workspace doesn't exist stops with a message telling you which path to fix; and a CoS task whose app has no usable Repository Path is blocked before the agent starts, rather than turned loose in the PortOS checkout. A path saved as `~/Projects/MyApp` is also accepted. Troubleshooting steps — including why `PORTOS_WORKSPACE_ROOTS` is unrelated to this — are in `docs/TROUBLESHOOTING.md`.
- **[issue-3193] OpenCode agents now run in the app you selected, not the PortOS folder** — even with a correct Repository Path, agents on an OpenCode provider wrote their files into the PortOS directory and reported the PortOS path as their working folder. OpenCode decides where it is by reading an environment variable that describes the folder PortOS itself was started in, rather than the folder it was actually handed, so the workspace you picked was quietly ignored — only on OpenCode, which is why Codex, Claude Code, and Gemini looked fine. PortOS now sets that variable to the real working directory everywhere it starts an agent, a provider run, a TUI session, or a terminal. Troubleshooting steps for telling this apart from a mistyped Repository Path are in `docs/TROUBLESHOOTING.md`.
- **[issue-3180] Agent terminals on Windows get a working environment** — the environment filter for agent shell sessions was written for macOS/Linux and dropped variables Windows needs, including `Path` itself (Windows spells it mixed-case, which the filter didn't match), plus `SystemRoot`, `ComSpec`, `TEMP`, and the per-user `APPDATA` folders where the coding CLIs keep their configuration and credentials. Windows sessions now keep those while still withholding API keys and tokens.
## Image generation

- **[issue-3186] Agy CLI is now an opt-in image-generation backend.** Users can enable Antigravity in Image Gen settings, select an installed or custom model, and send text-to-image work through its `generate_image` tool with queue progress, cancellation, gallery metadata, cleaner options, and CoS tool registration. Each render runs in an isolated scratch directory and only a signature-verified directed image is imported; image-edit surfaces continue to use an edit-capable backend.
## Game

- **[issue-3177] Added a Game studio for assembling managed-app asset bundles.** Create a Game workspace, bind reusable Sprite records and Music tracks, compile an immutable versioned manifest with SHA-256 asset references, and request persisted AI feedback with any configured provider, model, and supported effort. The new `/game/:id` workspace is reachable from Create, Cmd+K, and voice navigation.

## Quota burn

- **[issue-3179] Quota-burn no longer spends window budget on runs that never happened** — a scheduled quota-burn run counted against the family's per-window dispatch cap as soon as it was considered, even when it was subsequently skipped and no agent was ever started. Those phantom dispatches ate the budget, so a family configured for e.g. 5 burns per reset window could fire far fewer — and a family capped at 1 could never fire at all, because the skipped run consumed the only slot before the next gate re-read it. A burn is now counted once its agent has actually run, and a burn that is queued or in progress holds its slot in the meantime, so the cap stays accurate without letting a second app or a repeated "Run" overshoot it.

## Fixed

- **CoS agent PRs no longer open with TUI startup noise as their description.** A PR that PortOS opened for a Codex/Antigravity/OpenCode agent led with the session's own lifecycle log — `📟 TUI session started: … (codex …)`, `💡 Open the Shell tab…`, `📟 Prompt pasted…` — before getting to what the agent actually did. The PR description now starts at the agent's completion summary and drops PortOS's status lines, along with the trailing `## Branch` / `## PR` section that only repeats what the PR page already shows.
- **Review Hub success-rate alerts now require recent runs.** Low lifetime rates for task types that have been idle no longer appear as current health anomalies; alerts are shown only after enough runs occur in the rolling 30-day performance window.
- **Malware scan reports now open inside PortOS.** Scan links from Brain, the Review Hub, and completed CoS agents render the markdown in a mobile-friendly PortOS page instead of navigating a Home Screen install to the raw `.md` API response. Brain Links also has a Scan Reports filter, so clean and caution results are just as discoverable as dangerous findings.
- **Branch reconciler no longer hands long-lived shared branches to the coordinator agent.** `gh-pages` (the GitHub Pages publishing branch) is now protected alongside `main`/`master`/`dev`/`develop`/`release`, so the scheduled `branch-reconcile` task never tries to "open a PR" merging it into the default branch (which would break the published site). The reconciler now reuses the single canonical `PROTECTED_BRANCHES` set in `server/lib/gitArgs.js` instead of its own narrower list, so it also picks up `dev`/`develop` protection.

## Changed

- **Chief of Staff feedback now captures why an agent helped or missed the mark.** Add detail to positive, negative, or neutral ratings so future CoS learning has the context needed to improve.

- **Branch reconciler prioritizes recognized work branches.** The in-flight set handed to the coordinator agent is now ordered by branch prefix — `claim/`, `cos/`, `next/`, `feature/`, `fix/`, and other conventional prefixes are reconciled ahead of unrecognized/ad-hoc branches — so a bounded run spends its budget on real deliverables first. Both `/` and `-` separators match.

## AI providers

- **[issue-3194] Ask and image captioning now work on a local OpenCode provider.** If you pointed Ask Yourself or vision captioning at an OpenCode provider backed by Ollama, the run failed with the model reported as "not valid" — OpenCode has to be told which local models exist before it will accept one, and only the agent and Run Prompt paths were doing that. Every path that starts a coding CLI now declares them the same way, so the model you picked is accepted wherever you use it.

## Internal

- **[issue-3194] Consolidated the AI-CLI child-environment composition.** Eight spawn sites each rebuilt the same environment tuple by hand (provider env vars, the OpenCode declared-models map, the working-directory pin, the nested-session strip, and the pm2 guard shim for agents), so every environment-level fix had to sweep all eight and a missed site failed silently. A single `buildCliChildEnv` helper now owns it, preserving each site's original precedence, and a discovery-based test fails when a new spawn site composes the environment by hand instead.
