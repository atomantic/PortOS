// UI-driving voice tools: navigate, list interactables, read page text, and the
// DOM-mutating click/fill/select/check actions. `ui_navigate` is intentionally
// always-on (left out of TOOL_GROUPS) so "take me to X" works on any turn; the
// rest gate on UI_INTENT_RE. ui_click runs a destructive-action confirm gate.

import { resolveNavCommand } from '../../../lib/navManifest.js';
import { isDestructiveLabel, buildPending } from '../confirmGate.js';
import { UI_KINDS, findUiElement } from './shared.js';

// Loose on purpose — false positives are cheap (one extra tool), false
// negatives are expensive (LLM guesses wrong or can't act).
export const UI_INTENT_RE = /\b(click|press|tap|hit|open|go to|take me|show me|navigate|select|pick|switch|choose|tab|button|dropdown|field|input|fill|enter|type|write|check|uncheck|toggle|link|option|on (?:this|the) page|what(?:'s)? (?:on|here|does (?:this|the page))|read (?:this|the page|me (?:this|the page|what))|read (?:it )?(?:aloud|out))\b/i;
// Strong form-fill signal: when the user is clearly directing content INTO
// a specific field, brain_capture/daily_log_append must be suppressed even
// if capture verbs appear inside the value (e.g. "fill description with
// 'remember to buy milk'"). Matches a UI-fill verb within ~60 chars of a
// form-field word in either order — "fill the description with X", "type X
// in the body", "set the title to X", "put Y in description".
export const UI_FILL_INTENT_RE = /\b(?:fill|type|enter|put|write|set)\b[^.!?\n]{0,60}?\b(?:description|name|title|subject|body|content|field|input|textarea|form|label|placeholder|caption)\b/i;

export const UI_TOOLS = [
  {
    name: 'ui_navigate',
    description:
      'Navigate the UI to a page. Use for "take me to X" / "open X" / "go to X" — including the Daily Log when the user just wants to VIEW it without writing. ' +
      'Pass `page` as a short name the user would say: tasks, agents, gsd, briefing, calendar, goals, brain, meatspace, memory, messages, settings, shell, instances, wiki, character, health, body, alcohol, daily log, journal, etc. ' +
      'Server resolves fuzzy — "chief of staff tasks", "cos tasks", "task page" all map to tasks. If no match, the error lists valid names. ' +
      'Only prefer daily_log_open over this tool when the user clearly wants to write/dictate ("start", "new", "entry", "make", "dictate"); plain "open my daily log" or "go to the daily log" should use ui_navigate.',
    parameters: {
      type: 'object',
      properties: {
        page: {
          type: 'string',
          description: 'Short page name the user said (e.g. "tasks", "calendar"). Server fuzzy-matches.',
        },
        path: {
          type: 'string',
          description: 'Explicit route path starting with / (e.g. "/cos/tasks"). Only when page doesn\'t fit.',
        },
      },
    },
    execute: async ({ page, path } = {}, ctx = {}) => {
      let target = null;
      let resolvedKey = null;
      if (page && typeof page === 'string') {
        const hit = resolveNavCommand(page);
        if (hit) { target = hit.path; resolvedKey = hit.matched; }
      }
      if (!target && path && typeof path === 'string' && path.startsWith('/')) target = path;
      if (!target) {
        const suggestions = ['tasks', 'agents', 'gsd', 'briefing', 'calendar', 'goals', 'brain', 'meatspace', 'messages', 'settings', 'shell', 'instances'];
        return {
          ok: false,
          error: `Unknown page "${page || path || ''}"`,
          suggestions,
          summary: `I don't know that page. Try: ${suggestions.slice(0, 6).join(', ')}.`,
        };
      }
      ctx.sideEffects?.push({ type: 'navigate', path: target });
      return { ok: true, path: target, summary: `Opened ${resolvedKey || target}.` };
    },
  },

  {
    name: 'ui_list_interactables',
    description: 'List interactive elements on the current page. Fallback when the per-turn UI summary isn\'t enough.',
    parameters: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: UI_KINDS, description: 'Optional kind filter.' },
      },
    },
    execute: async ({ kind } = {}, ctx = {}) => {
      const ui = ctx.state?.ui;
      if (!ui || !Array.isArray(ui.elements)) {
        return { ok: false, error: 'No UI index available. The user may not have the voice widget loaded.' };
      }
      const items = kind ? ui.elements.filter((e) => e.kind === kind) : ui.elements;
      return {
        ok: true,
        path: ui.path,
        title: ui.title,
        count: items.length,
        items: items.slice(0, 100),
        summary: `${items.length} interactive element${items.length === 1 ? '' : 's'} on ${ui.title || ui.path || 'this page'}.`,
      };
    },
  },

  {
    name: 'ui_read',
    description:
      'Read back the visible text on the current page. Use when the user asks "what does this say?", "read this aloud", "what\'s on the page?", "read me the page". ' +
      'Returns the user-visible textual content of the main content area (excluding nav rails, asides, and the voice widget itself). ' +
      'Output is capped at ~8 KB; longer pages are tail-trimmed on a word boundary with an ellipsis. ' +
      'Default behavior (summarize=false): read the returned `content` verbatim — do NOT summarize. ' +
      'When the user asks for a summary instead ("what is this page about?", "summarize this page"), pass summarize=true and produce a short summary of `content` rather than reading it verbatim.',
    parameters: {
      type: 'object',
      properties: {
        summarize: {
          type: 'boolean',
          description: 'If true, the LLM may summarize before reading aloud (use when the user asks "what is this page about?" rather than "read this to me"). Default false — speak `content` verbatim.',
        },
      },
    },
    execute: async ({ summarize = false } = {}, ctx = {}) => {
      const ui = ctx?.state?.ui;
      // The client no longer ships the visible-text blob with every index —
      // it sets `textOnDemand` and we fetch it lazily here, only when ui_read
      // actually runs. Resolution order:
      //   1. Eager/legacy text already on the snapshot (older client, or a
      //      prior ui_read in this turn cached it) → use it directly.
      //   2. textOnDemand client → request it now via ctx.requestUiText().
      //   3. Neither (very old / no widget) → "no text available".
      let text = typeof ui?.text === 'string' && ui.text.trim() ? ui.text : null;
      if (!text && ui?.textOnDemand && typeof ctx?.requestUiText === 'function') {
        const fetched = await ctx.requestUiText();
        if (typeof fetched === 'string' && fetched.trim()) text = fetched;
      }
      if (!text) {
        return {
          ok: false,
          error: 'No page text available',
          summary: "I can't see the page content right now — make sure the voice widget is loaded and try again.",
        };
      }
      return {
        ok: true,
        path: ui?.path,
        title: ui?.title,
        content: text,
        chars: text.length,
        summarize: !!summarize,
        // Keep `summary` short so the LLM message history isn't doubled — the
        // full body lives in `content`.
        summary: `Read page "${ui?.title || ui?.path || 'current page'}" (${text.length} chars).`,
      };
    },
  },

  {
    name: 'ui_click',
    description: 'Click a tab, button, or link on the current page by visible label. "Select Memory tab" → label="Memory", kind="tab".',
    parameters: {
      type: 'object',
      properties: {
        label: { type: 'string', description: 'Visible label.' },
        kind: { type: 'string', enum: ['tab', 'button', 'link'], description: 'Optional kind hint.' },
      },
      required: ['label'],
    },
    execute: async ({ label, kind } = {}, ctx = {}) => {
      const hit = findUiElement(ctx, label, kind);
      if (!hit.entry) return hit.err;
      // Destructive-action confirmation gate. If the resolved label looks
      // destructive (delete/remove/discard/reset/clear), stash a pending
      // record on the per-session state and ask the LLM to prompt the user
      // for spoken confirmation. The next user turn is intercepted by
      // pipeline.js → resolvePending() which either re-issues the click or
      // cancels. Skip if the caller already confirmed (re-issue path).
      if (ctx.state && !ctx.confirmed && isDestructiveLabel(hit.entry.label)) {
        ctx.state.pendingDestructive = buildPending({
          tool: 'ui_click',
          args: { label: hit.entry.label, kind: hit.entry.kind },
          target: { ref: hit.entry.ref, label: hit.entry.label, kind: hit.entry.kind },
        });
        return {
          ok: true,
          confirmation_required: true,
          label: hit.entry.label,
          kind: hit.entry.kind,
          summary: `That looks destructive — confirm by saying "yes" or "confirm" to ${hit.entry.label}, or "cancel" to skip.`,
        };
      }
      ctx.sideEffects?.push({ type: 'ui:click', target: { ref: hit.entry.ref, label: hit.entry.label } });
      return { ok: true, label: hit.entry.label, kind: hit.entry.kind, summary: `Clicked ${hit.entry.label}.` };
    },
  },

  {
    name: 'ui_fill',
    description: 'Type text into an input or textarea by its label. Use ui_select for dropdowns, ui_check for checkboxes.',
    parameters: {
      type: 'object',
      properties: {
        label: { type: 'string', description: 'Visible label of the input.' },
        value: { type: 'string', description: 'Text to fill in.' },
      },
      required: ['label', 'value'],
    },
    execute: async ({ label, value } = {}, ctx = {}) => {
      const hit = findUiElement(ctx, label, ['input', 'textarea']);
      if (!hit.entry) return hit.err;
      ctx.sideEffects?.push({ type: 'ui:fill', target: { ref: hit.entry.ref, label: hit.entry.label }, value: String(value ?? '') });
      return { ok: true, label: hit.entry.label, summary: `Filled ${hit.entry.label}.` };
    },
  },

  {
    name: 'ui_select',
    description: 'Pick an option from a <select> dropdown by label. "Set status to Active" → label="Status", option="Active".',
    parameters: {
      type: 'object',
      properties: {
        label: { type: 'string', description: 'Visible label of the select.' },
        option: { type: 'string', description: 'Option text or value.' },
      },
      required: ['label', 'option'],
    },
    execute: async ({ label, option } = {}, ctx = {}) => {
      const hit = findUiElement(ctx, label, 'select');
      if (!hit.entry) return hit.err;
      ctx.sideEffects?.push({ type: 'ui:select', target: { ref: hit.entry.ref, label: hit.entry.label }, option: String(option) });
      return { ok: true, label: hit.entry.label, option, summary: `Selected ${option} on ${hit.entry.label}.` };
    },
  },

  {
    name: 'ui_check',
    description: 'Toggle a checkbox or radio by label. checked=true to check, false to uncheck.',
    parameters: {
      type: 'object',
      properties: {
        label: { type: 'string', description: 'Visible label.' },
        checked: { type: 'boolean', description: 'Desired state.' },
      },
      required: ['label', 'checked'],
    },
    execute: async ({ label, checked } = {}, ctx = {}) => {
      const hit = findUiElement(ctx, label, ['checkbox', 'radio']);
      if (!hit.entry) return hit.err;
      ctx.sideEffects?.push({ type: 'ui:check', target: { ref: hit.entry.ref, label: hit.entry.label }, checked: !!checked });
      return { ok: true, label: hit.entry.label, checked: !!checked, summary: `${checked ? 'Checked' : 'Unchecked'} ${hit.entry.label}.` };
    },
  },
];
