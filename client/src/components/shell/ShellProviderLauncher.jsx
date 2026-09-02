import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Bot, ChevronDown, Search, Terminal, AlertTriangle } from 'lucide-react';
import usePopoverPosition, { VIEWPORT_PADDING } from '../../hooks/usePopoverPosition.js';
import useClickOutside from '../../hooks/useClickOutside';
import useEscapeKey from '../../hooks/useEscapeKey';
import { tokenizeQuery, matchHaystack } from '../../lib/mediaSearch.js';
import { isLaunchableTuiProvider } from '../../utils/providers';

const PANEL_WIDTH = 384;

// How many entries the list needs before the filter box earns its row. A short
// list is faster to scan than to type into — and on a phone the box would cost
// a chunk of the panel plus an unwanted keyboard.
const FILTER_THRESHOLD = 6;

/**
 * The launchable set: enabled providers `isLaunchableTuiProvider` accepts,
 * sorted by name so the list is stable as providers are toggled on and off.
 * Each carries a prebuilt lowercase haystack so keystroke filtering is a plain
 * `includes` rather than a re-join per provider per keypress.
 */
export function launchableProviders(providers) {
  return (providers || [])
    .filter((p) => p?.enabled && isLaunchableTuiProvider(p))
    .sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id))
    // Match on everything the row shows — name, id, and the command line — so
    // typing `ollama`, `opencode`, or `agy` all find their providers.
    .map((p) => ({ ...p, haystack: `${p.name || ''} ${p.id} ${p.tuiCommandLine}`.toLowerCase() }));
}

/**
 * Dynamic "launch an AI CLI" menu for the Shell page.
 *
 * Replaces the hardcoded per-tool buttons (claude / codex / agy / grok …) that
 * couldn't scale past a handful and duplicated provider config in the client.
 * Every enabled TUI provider shows up here automatically, and picking one goes
 * through `shell:start { providerId }` — the server re-resolves the command AND
 * pairs it with the provider's `envVars`, so an Ollama-, MTPLX- or
 * Bedrock-backed provider reaches the backend it is configured for. Typing the
 * command line into the current shell instead would leave that env behind (and
 * those values are secret, so they can't cross the wire anyway).
 *
 * The panel is PORTALED and fixed-positioned via `usePopoverPosition` for the
 * same two reasons `ShellImageDrop` is: both host bars are `overflow-x-auto`
 * (which clips an in-flow absolute panel) and both scroll horizontally, so a
 * hardcoded offset would detach from the button. The hook also clamps and flips
 * into the viewport, which is what keeps a 14-row menu on screen when the
 * trigger sits near the bottom of a phone.
 *
 * @param {Object} props
 * @param {Array} props.providers - `GET /api/providers` records; may be empty
 *   until `onOpen` has loaded them.
 * @param {(providerId: string) => void} props.onLaunch
 * @param {() => void} [props.onOpen] - fired on each open so the host can load
 *   providers lazily; a Shell visit that never opens this menu pays nothing.
 * @param {boolean} [props.loading] - providers are in flight (first open).
 * @param {'below'|'above'} [props.placement] - preferred side; flips if there's no room
 */
export default function ShellProviderLauncher({ providers, onLaunch, onOpen, loading = false, placement = 'below' }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const containerRef = useRef(null);

  const launchable = launchableProviders(providers);
  const tokens = tokenizeQuery(query);
  const visible = tokens.length === 0
    ? launchable
    : launchable.filter((p) => matchHaystack(p.haystack, tokens));

  const { triggerRef, popoverRef, style } = usePopoverPosition({
    open,
    width: PANEL_WIDTH,
    position: placement === 'above' ? 'above' : 'below',
    // The panel's height changes as the list loads and as the filter narrows it,
    // and that height is what decides whether the preferred side still fits.
    contentDeps: [visible.length, loading],
  });

  const close = () => { setOpen(false); setQuery(''); };
  // The panel is portaled to <body>, so it is not a descendant of the trigger
  // container — a single-ref containment check would read every click inside
  // the panel (including typing in the filter) as an outside click.
  useClickOutside([containerRef, popoverRef], open, close);
  useEscapeKey(open, close);

  const toggle = () => {
    if (open) { close(); return; }
    setOpen(true);
    onOpen?.();
  };

  const handlePick = (providerId) => {
    close();
    onLaunch(providerId);
  };

  return (
    <div className="relative shrink-0" ref={containerRef}>
      <button
        ref={triggerRef}
        onClick={toggle}
        className="flex items-center gap-1.5 px-2.5 py-1.5 bg-port-card hover:bg-port-border text-gray-300 hover:text-white rounded text-xs transition-colors border border-port-border min-h-[40px] shrink-0"
        title="Launch an AI CLI from your enabled providers"
        aria-label="Launch an AI CLI"
        aria-expanded={open}
      >
        <Bot size={14} />
        <span className="hidden sm:inline">Launch AI</span>
        <ChevronDown size={12} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && createPortal(
        <div
          ref={popoverRef}
          className="fixed max-w-[calc(100vw-1rem)] max-h-dvh-cap [--dvh-cap:70dvh] overflow-y-auto overscroll-contain z-[100] bg-port-card border border-port-border rounded-lg shadow-xl"
          style={{
            left: style?.left ?? `${VIEWPORT_PADDING}px`,
            top: style?.top ?? `${VIEWPORT_PADDING}px`,
            width: style?.width ?? `${PANEL_WIDTH}px`,
            // Hidden until measured so the panel never flashes at the corner.
            visibility: style ? 'visible' : 'hidden',
          }}
        >
          {launchable.length >= FILTER_THRESHOLD && (
            // Sticky so the filter stays reachable while scrolling a long list.
            // Deliberately not autofocused — on a phone that pops the keyboard
            // over the very list the user opened the menu to look at.
            <div className="sticky top-0 flex items-center gap-2 px-3 py-2 bg-port-card border-b border-port-border">
              <Search size={14} className="text-gray-500 shrink-0" />
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Filter providers…"
                aria-label="Filter providers"
                className="w-full bg-transparent text-sm text-white placeholder-gray-500 focus:outline-none"
              />
            </div>
          )}

          {/* Deliberately NOT role="menu"/"menuitem": those roles promise arrow-key
              navigation and a typeahead this widget doesn't implement, and they'd
              also make the filter <input> an invalid child. It is a disclosure of
              plain buttons — Tab reaches every row natively — which is what the
              sibling `cd to app` dropdown on this page already is. */}
          <div role="group" aria-label="Enabled AI providers">
            {visible.map((provider) => (
              <button
                key={provider.id}
                onClick={() => handlePick(provider.id)}
                className="w-full text-left px-3 py-2 min-h-[44px] hover:bg-port-border transition-colors border-b border-port-border/50 last:border-b-0"
                title={provider.tuiCommandLine}
              >
                <div className="flex items-center gap-2">
                  <Terminal size={12} className="text-port-accent shrink-0" />
                  <span className="text-sm text-gray-200 truncate">{provider.name || provider.id}</span>
                  {/* The server already told us this provider can't run here (a
                      missing binary, an unset key). Still launchable — the user
                      may be fixing it in another tab — but flagged, so a shell
                      that instantly prints `command not found` isn't a surprise. */}
                  {provider.prerequisitesMet === false && (
                    <span className="flex items-center gap-1 text-[10px] text-port-warning shrink-0" title="Needs setup — see AI Providers">
                      <AlertTriangle size={10} />
                      setup
                    </span>
                  )}
                </div>
                <div className="text-[11px] font-mono text-gray-500 truncate">{provider.tuiCommandLine}</div>
              </button>
            ))}
          </div>

          {visible.length === 0 && (
            <div className="px-3 py-3 text-xs text-gray-500">
              {loading
                ? 'Loading providers…'
                : launchable.length === 0
                  ? 'No enabled TUI providers. Enable one on the AI Providers page.'
                  : 'No providers match that filter.'}
            </div>
          )}
        </div>,
        document.body
      )}
    </div>
  );
}
