// Workspace-context voice/palette tool (#2035): switch the active project
// workspace — snapshot the workspace you're leaving, then reconcile the named
// project's saved context (git branch, in-repo shell sessions, scoped tasks).
// Reuses the workspaceContext service the Workspace Contexts page already
// drives (snapshotOnRepoSwitch + restoreContext); it never checks out branches
// or spawns shells — that stays a manual user action.

// Workspace/project switching intent — "switch workspace to X", "switch to the
// X project", "restore my BookLoom context", "take me back to PortOS project".
// The workspace/project(-context) token is required within ~40 chars so a plain
// "switch to the tasks page" (a ui_navigate turn) does NOT match.
export const WORKSPACE_INTENT_RE = /\b(?:switch|change|move|jump|flip|go|take me|get me|back)\b[^.!?\n]{0,40}\b(?:workspace|project(?:\s+context)?)\b|\brestore\b[^.!?\n]{0,40}\b(?:workspace|context)\b|\bworkspace\s+context\b/i;

export const WORKSPACE_TOOLS = [
  {
    name: 'workspace_switch',
    description:
      'Switch your active project workspace: first save a snapshot of the workspace you are leaving, then restore the named project\'s saved context — its git branch, the shell sessions rooted in its repo, and the tasks scoped to it. Use when the user says "switch workspace to BookLoom", "switch to the finance tracker project", "take me back to the PortOS workspace", or "restore my BookLoom context". Restoring only REPORTS which saved shell sessions are still live to re-attach and whether the saved git branch is still checked out — it never checks out branches or spawns shells for the user (that stays a manual action). Name the target project as `workspace`.',
    parameters: {
      type: 'object',
      properties: {
        workspace: {
          type: 'string',
          description: 'The project/app to switch to ("BookLoom", "finance tracker", "PortOS"). Server fuzzy-matches against the user\'s managed apps.',
        },
      },
      required: ['workspace'],
    },
    execute: async ({ workspace } = {}) => {
      const phrase = typeof workspace === 'string' ? workspace.trim() : '';
      if (!phrase) {
        return { ok: false, error: 'workspace is required', summary: "I didn't catch which workspace to switch to." };
      }

      const { getActiveApps } = await import('../../apps.js');
      const { resolveAppByPhrase } = await import('../../../lib/appResolver.js');
      const { snapshotOnRepoSwitch, restoreContext } = await import('../../workspaceContext.js');

      const apps = await getActiveApps().catch(() => []);
      const match = resolveAppByPhrase(phrase, apps);
      if (!match) {
        const names = (apps || []).map((a) => a?.name).filter(Boolean);
        const hint = names.length ? ` Try one of: ${names.slice(0, 4).join(', ')}.` : '';
        return {
          ok: false,
          error: `unknown workspace "${phrase}"`,
          summary: `I don't see a project called ${phrase}.${hint}`,
        };
      }

      // Snapshot the workspace we're leaving (silent, no-op if none or same),
      // then reconcile the target's saved context against what's live now.
      // Both are defensive — a failure to snapshot must not block the switch.
      const snapshot = await snapshotOnRepoSwitch(match.id).catch(() => null);
      const restore = await restoreContext(match.id).catch(() => null);

      const reattach = restore?.restorable?.shellSessions?.length || 0;
      const hadSaved = !!restore?.saved;
      const savedNote = snapshot?.appId ? ` Saved your ${snapshot.appId} context first.` : '';
      const restoreNote = hadSaved
        ? ` Restored ${reattach} live shell session${reattach === 1 ? '' : 's'}.`
        : ' No saved context there yet, so nothing to restore.';

      return {
        ok: true,
        workspace: match.id,
        workspaceName: match.name || match.id,
        snapshotted: snapshot?.appId || null,
        reattachable: reattach,
        summary: `Switched to ${match.name || match.id}.${savedNote}${restoreNote}`,
      };
    },
  },
];
