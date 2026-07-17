// Code-agent delegation voice tools: dispatch an autonomous coding agent (runs
// in an isolated worktree, opens a PR) and check the status of in-flight
// dispatched tasks. Heavy collaborators (cos.js, providers.js, apps.js) are
// imported lazily inside execute() to keep this module's load graph light.

import { getVoiceConfig } from '../config.js';

// Code-agent delegation — software-engineering requests and explicit
// "have <agent> …" phrasing. The ambiguous verbs (implement/debug/rewrite/
// patch) require a following code-domain object within ~40 chars, so
// "implement my morning routine" / "debug my relationship" / "add a feature
// to my calendar" do NOT match; `refactor` stays standalone (rarely non-code
// in speech). A false positive only OFFERS the tool to the LLM (which still
// has to choose it), and the tool is a no-op unless codeAgent.enabled
// (pipeline.js strips it from the spec list when off).
export const CODE_INTENT_RE = /\b(?:have (?:claude|codex|antigravity|gemini|the agent|an agent)\b|dispatch (?:a |an )?(?:coding |code )?agent|spin up an agent|code (?:it )?up|open a pr|pull request|refactor|(?:implement|debug|rewrite|patch)\b[^.!?\n]{0,40}\b(?:bug|tests?|function|method|build|lint|type ?error|error|code|file|module|endpoint|route|component|class|api|schema|migration|script|flag|regression|handler|parser|service|hook|query|registry|config)\b|fix (?:the |a |an |my )?(?:bug|test|tests|failing|function|method|build|lint|type|error|code|file|module|endpoint|route|component)|write (?:a |the |some )?(?:unit |integration )?tests?|add (?:a |an |the )?(?:flag|function|method|endpoint|route|test|migration)\b|(?:how(?:'s| is| are)?|status of|progress on|what(?:'s| is)? happening (?:with|on)|where (?:are|is) (?:we|it|that|the))\b[^.!?\n]{0,40}\b(?:coding (?:task|agent|job)|code agent|dispatched (?:task|job|agent)|pull request|the agent|the pr|that pr|my pr|the task)\b|\bis (?:the |that |my )?(?:coding |code )?(?:agent|task) (?:still |yet )?(?:running|going|working|done|finished))/i;

export const CODE_TOOLS = [
  {
    name: 'dispatch_code_agent',
    description:
      'Hand a software-engineering task to an autonomous coding agent that works in an isolated git worktree and opens a pull request for review. Use when the user asks you to write, fix, refactor, debug, or test CODE — e.g. "fix the failing test in X", "add a --dry-run flag to the backup script", "refactor the widget registry". Do NOT use for capturing notes/ideas (that is brain_capture) or for clicking/navigating the UI. The work runs in the background and the user is told when it finishes — do not wait for it. State the task in the user\'s own words with enough detail to act on it. When the user names a managed app to work in ("…in BookLoom", "fix the bug in the finance tracker"), pass that name as `app`; omit `app` for tasks on PortOS itself. The coding agent and model come from the user\'s configured default; never put a provider or model in this call.',
    parameters: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description: 'The coding task to perform, phrased as a clear, self-contained instruction (file/feature names, the desired outcome). The agent reads this verbatim as its prompt.',
        },
        app: {
          type: 'string',
          description: 'Optional managed-app target ("BookLoom", "finance tracker"). Server fuzzy-matches against the user\'s configured apps; omit to run against PortOS itself.',
        },
      },
      required: ['task'],
    },
    execute: async ({ task, app } = {}) => {
      const text = typeof task === 'string' ? task.trim() : '';
      if (!text) {
        return { ok: false, error: 'task is required', summary: "I didn't catch what you want the coding agent to do." };
      }
      const appPhrase = typeof app === 'string' ? app.trim() : '';

      // Backstop for the palette path — pipeline.js already strips this tool
      // from the LLM's spec list when codeAgent is disabled, but the command
      // palette dispatches by id regardless, so re-check here.
      const cfg = await getVoiceConfig();
      const codeAgent = cfg?.llm?.codeAgent || {};
      if (!codeAgent.enabled) {
        return { ok: false, error: 'code-agent disabled', summary: 'Coding-agent dispatch is off — turn it on under Settings, Voice, Coding agent.' };
      }

      // Reject an explicit-but-unknown app rather than silently falling
      // through to the PortOS workspace — that's the whole point of asking.
      let resolvedAppId = null;
      let resolvedAppName = null;
      if (appPhrase) {
        const { getActiveApps } = await import('../../apps.js');
        const { resolveAppByPhrase } = await import('../../../lib/appResolver.js');
        const apps = await getActiveApps().catch(() => []);
        const match = resolveAppByPhrase(appPhrase, apps);
        if (!match) {
          const names = (apps || []).map((a) => a?.name).filter(Boolean);
          const hint = names.length ? ` Try one of: ${names.slice(0, 4).join(', ')}.` : '';
          return {
            ok: false,
            error: `unknown app "${appPhrase}"`,
            summary: `I don't see a managed app called ${appPhrase}.${hint}`,
          };
        }
        resolvedAppId = match.id;
        resolvedAppName = match.name || match.id;
      }

      // Dynamic import: cos.js is a large module with its own import graph;
      // importing it lazily keeps tools.js load-time light and dodges any
      // cos → voice cycle.
      const { addTask, reviveBlockedTask, isRunning } = await import('../../cos.js');
      const provider = typeof codeAgent.provider === 'string' ? codeAgent.provider.trim() : '';
      const model = typeof codeAgent.model === 'string' ? codeAgent.model.trim() : '';

      // Resolve a code-capable provider. A coding agent must run a CLI/TUI
      // provider (Claude Code, Codex, Antigravity CLI, …); an API backend (LM Studio
      // / Ollama / OpenAI-compatible) can't, and the spawner would otherwise
      // fall through to the Claude CLI spawn config with a non-Claude model name
      // (buildCliSpawnConfig defaults to claude). Validate BOTH the inherited
      // system default AND an explicit pin — the Voice settings UI only lists
      // CLI/TUI providers for the code agent, but a hand-edited config can still
      // pin an API one. When the effective provider isn't code-capable,
      // substitute the first enabled CLI/TUI provider, or fail with actionable
      // copy if none exists. A pin that doesn't resolve to a known provider is
      // left as-is (the spawner surfaces the unknown-provider error).
      const { getActiveProvider, getAllProviders, getProviderById } = await import('../../providers.js');
      const isCodeCapable = (p) => p?.type === 'cli' || p?.type === 'tui';
      const candidate = provider
        ? await getProviderById(provider).catch(() => null)
        : await getActiveProvider().catch(() => null);
      const needsSwap = provider
        ? (candidate != null && !isCodeCapable(candidate)) // known pin that's API-only
        : !isCodeCapable(candidate);                        // default (incl. none) not capable
      let resolvedProvider = provider;
      let substituted = false;
      if (needsSwap) {
        const { providers = [] } = await getAllProviders().catch(() => ({ providers: [] }));
        const codeProvider = providers.find((p) => p?.enabled && isCodeCapable(p));
        if (!codeProvider) {
          return {
            ok: false,
            error: 'no code-capable provider',
            summary: "Your AI provider can't run a coding agent. Enable a CLI provider like Claude Code, Codex, or Antigravity under Settings, AI Providers, then try again.",
          };
        }
        resolvedProvider = codeProvider.id;
        substituted = true;
      }

      const created = await addTask({
        description: text,
        priority: 'HIGH',
        position: 'top',
        voiceDispatch: true,
        ...(resolvedAppId ? { app: resolvedAppId } : {}),
        // The promise of this tool (and the changelog / spoken copy) is
        // isolated work that opens a PR and never touches the user's working
        // tree. spawnAgentForTask only honors that when the task explicitly
        // opts in — without these flags it runs in the shared workspace and
        // auto-merges. Set both so the dispatched agent always works in a
        // worktree and surfaces a PR for review.
        useWorktree: true,
        openPR: true,
        // Pin the configured (or substituted code-capable) provider. Omitting
        // it lets the CoS spawner inherit the system default — only done when
        // that default is itself code-capable (see resolution above). A pinned
        // model belongs to a specific provider, so drop it when we substituted
        // a different provider than the (empty) configured one.
        ...(resolvedProvider ? { provider: resolvedProvider } : {}),
        ...(model && !substituted ? { model } : {}),
      }, 'user');

      // addTask auto-spawns user tasks, but only while the CoS runner is up.
      // isRunning() is a synchronous daemon-state check. Surface a stopped
      // runner on BOTH paths so a re-issue of an already-queued task isn't
      // falsely reassuring when nothing is actually running it.
      const running = isRunning();
      const stoppedNote = ' — but the Chief-of-Staff runner is stopped, so start it to run it';

      const appSuffix = resolvedAppName ? ` in ${resolvedAppName}` : '';

      if (created?.duplicate) {
        // A blocked twin means "already queued" would be a lie — it will never
        // run on its own. A repeated voice dispatch is an explicit retry, so
        // revive it with a fresh retry budget (#2614).
        if (created.status === 'blocked') {
          await reviveBlockedTask(created.id, {}, 'user');
          return {
            ok: true,
            taskId: created.id,
            revived: true,
            app: resolvedAppId,
            summary: `That coding task${appSuffix} previously failed and was blocked — I restarted it${running ? '.' : stoppedNote + '.'}`,
          };
        }
        return {
          ok: true,
          taskId: created.id,
          duplicate: true,
          app: resolvedAppId,
          summary: `That coding task${appSuffix} is already queued${running ? ', so I left it as is.' : `${stoppedNote}.`}`,
        };
      }

      const summary = running
        ? `Queued a coding task${appSuffix} — I'll let you know when it's done.`
        : `Queued the coding task${appSuffix}${stoppedNote}.`;
      return { ok: true, taskId: created?.id, running, app: resolvedAppId, summary };
    },
  },

  {
    name: 'code_agent_status',
    description:
      "Report the status of in-flight coding tasks the user dispatched by voice (via dispatch_code_agent). Use when the user asks how a coding agent / dispatched task is doing — e.g. \"how's that coding task going?\", \"is the agent still running?\", \"status of the PR\", \"what's happening with the refactor?\". Reads live agent state and reports phase + elapsed per running task. The completion announcement covers the done case proactively; this tool is for mid-task check-ins. Returns an empty-but-ok result when nothing is running — speak the summary verbatim.",
    parameters: {
      type: 'object',
      properties: {},
    },
    execute: async () => {
      const { loadState } = await import('../../cosState.js');
      const { getAllTasks } = await import('../../cos.js');
      const { isTruthyMeta } = await import('../../agentState.js');

      const state = await loadState();
      const runningAgents = Object.values(state?.agents || {}).filter((a) => a?.status === 'running');
      if (runningAgents.length === 0) {
        return { ok: true, count: 0, agents: [], summary: 'No coding tasks are running right now.' };
      }

      // Read TASKS.md once and index by id, not getTaskById in a loop — that
      // re-reads both task files per call.
      const { user, cos } = await getAllTasks();
      const tasksById = new Map();
      for (const t of user.tasks || []) tasksById.set(t.id, t);
      for (const t of cos.tasks || []) tasksById.set(t.id, t);

      const matched = [];
      for (const agent of runningAgents) {
        if (!agent?.taskId) continue;
        const task = tasksById.get(agent.taskId);
        if (!task) continue;
        if (!isTruthyMeta(task.metadata?.voiceDispatch)) continue;
        const startedAt = agent.startedAt ? Date.parse(agent.startedAt) : NaN;
        const elapsedMs = Number.isFinite(startedAt) ? Math.max(0, Date.now() - startedAt) : null;
        matched.push({
          taskId: task.id,
          agentId: agent.id,
          description: (task.description || '').split('\n')[0].trim(),
          phase: agent.metadata?.phase || 'working',
          app: agent.metadata?.taskAppName || agent.metadata?.taskApp || null,
          elapsedMs,
        });
      }

      if (matched.length === 0) {
        return { ok: true, count: 0, agents: [], summary: 'No coding tasks are running right now.' };
      }

      const phaseText = (phase) => (phase === 'initializing' ? 'spinning up' : 'working');
      const elapsedSpoken = (ms) => {
        if (!Number.isFinite(ms) || ms < 60_000) return 'less than a minute';
        const mins = Math.floor(ms / 60_000);
        if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'}`;
        const hours = Math.floor(mins / 60);
        const rem = mins % 60;
        const h = `${hours} hour${hours === 1 ? '' : 's'}`;
        return rem === 0 ? h : `${h} ${rem} minute${rem === 1 ? '' : 's'}`;
      };
      const clipDesc = (s) => (s.length > 80 ? `${s.slice(0, 77)}…` : s);

      let summary;
      if (matched.length === 1) {
        const a = matched[0];
        const appSuffix = a.app ? ` in ${a.app}` : '';
        const descPart = a.description ? `: ${clipDesc(a.description)}` : '';
        summary = `One coding task is ${phaseText(a.phase)}${appSuffix} — ${elapsedSpoken(a.elapsedMs)} in${descPart}.`;
      } else {
        const lines = matched.map((a) => {
          const appSuffix = a.app ? ` in ${a.app}` : '';
          const descPart = a.description ? ` "${clipDesc(a.description)}"` : '';
          return `${phaseText(a.phase)}${appSuffix}${descPart}, ${elapsedSpoken(a.elapsedMs)} elapsed`;
        });
        summary = `${matched.length} coding tasks are running: ${lines.join('; ')}.`;
      }

      return { ok: true, count: matched.length, agents: matched, summary };
    },
  },
];
