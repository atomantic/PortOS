import { useRef, useState } from 'react';
import {
  Check, Copy, Frame, Image as ImageIcon, Images, Loader2, Play, ScrollText, SlidersHorizontal, Sparkles, Trash2, Type,
} from 'lucide-react';
import OverflowMenu from '../ui/OverflowMenu';
import InlineConfirmRow from '../ui/InlineConfirmRow';

export const NODE_ICONS = { text: Type, system: ScrollText, llm: Sparkles, references: Images, image: ImageIcon, panel: Frame };

const LONG_PRESS_MS = 500;
const headerButton = 'min-h-[44px] min-w-[44px] inline-flex items-center justify-center rounded-lg text-gray-400 hover:text-white hover:bg-port-border/60 disabled:opacity-40';
const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || '');

const STATUS_TEXT = { running: 'Running…', queued: 'Making frames…', failed: 'Failed', done: 'Done' };

/**
 * One recipe node: a header (type icon, title, Run, a sliders button that
 * flips the card to its settings face, a ••• menu) over the node's body.
 * The menu also opens on right-click / ctrl+click and on a phone long press;
 * with the card focused, ⌘D (ctrl+D) duplicates and Delete/Backspace asks to
 * delete.
 */
export default function RecipeNodeCard({
  node, status = 'idle', running = false, canRun = false, runLabel = 'Run', onRun, onDuplicate, onDelete,
  settings, children,
}) {
  const [face, setFace] = useState('body');
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const pressRef = useRef(null);
  const cardRef = useRef(null);
  const Icon = NODE_ICONS[node.type] || Type;
  const statusText = running ? STATUS_TEXT.running : STATUS_TEXT[status];

  const clearPress = () => {
    clearTimeout(pressRef.current?.timer);
    pressRef.current = null;
  };
  const onPointerDown = (event) => {
    if (event.pointerType !== 'touch') return;
    const start = { x: event.clientX, y: event.clientY };
    pressRef.current = { start, timer: setTimeout(() => { pressRef.current = null; setMenuOpen(true); }, LONG_PRESS_MS) };
  };
  const onPointerMove = (event) => {
    const press = pressRef.current;
    if (press && Math.hypot(event.clientX - press.start.x, event.clientY - press.start.y) > 10) clearPress();
  };
  const onKeyDown = (event) => {
    if (event.target !== cardRef.current) return;
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'd') {
      event.preventDefault();
      onDuplicate();
    } else if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      setConfirmDelete(true);
    }
  };

  return (
    <section
      ref={cardRef}
      tabIndex={0}
      aria-label={`${node.title} node`}
      data-node-id={node.id}
      onContextMenu={(event) => { event.preventDefault(); setMenuOpen(true); }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={clearPress}
      onPointerCancel={clearPress}
      onKeyDown={onKeyDown}
      className="rounded-xl border border-port-border bg-port-card focus:outline-hidden focus:ring-2 focus:ring-port-accent/60"
    >
      <header className="flex items-center gap-1 pl-3 pr-1 py-1 border-b border-port-border">
        <Icon size={16} className="shrink-0 text-port-accent" aria-hidden="true" />
        <h3 className="flex-1 min-w-0 truncate text-sm font-medium text-white">{node.title}</h3>
        {statusText && <span className={`text-[11px] ${status === 'failed' && !running ? 'text-port-error' : 'text-gray-400'}`} role="status">{statusText}</span>}
        {canRun && (
          <button type="button" onClick={onRun} disabled={running} className={headerButton} aria-label={`${runLabel}: ${node.title}`} title={runLabel}>
            {running ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <Play size={16} aria-hidden="true" />}
          </button>
        )}
        {settings && (
          <button type="button" onClick={() => setFace(face === 'settings' ? 'body' : 'settings')} aria-pressed={face === 'settings'}
            aria-label={`${node.title} settings`} title="Settings" className={headerButton}>
            <SlidersHorizontal size={16} aria-hidden="true" />
          </button>
        )}
        <OverflowMenu
          label={`${node.title} actions`}
          open={menuOpen}
          onOpenChange={setMenuOpen}
          className="[&>button]:border-0"
          items={[
            { id: 'duplicate', label: 'Duplicate', icon: Copy, shortcut: isMac ? '⌘D' : 'Ctrl+D', onSelect: onDuplicate },
            { id: 'delete', label: 'Delete', icon: Trash2, tone: 'danger', shortcut: '⌫', onSelect: () => setConfirmDelete(true) },
          ]}
        />
      </header>
      {confirmDelete && (
        <InlineConfirmRow variant="separator" autoFocus aria-label={`Delete ${node.title}`} question={`Delete ${node.title}? Its wires go with it.`}
          onConfirm={() => { setConfirmDelete(false); onDelete(); }} onCancel={() => setConfirmDelete(false)} />
      )}
      <div className="p-3 space-y-2">
        {face === 'settings' && settings ? (
          <>
            {settings}
            <button type="button" onClick={() => setFace('body')}
              className="min-h-[44px] w-full inline-flex items-center justify-center gap-1.5 rounded-lg bg-port-accent/20 border border-port-accent/50 text-sm text-white">
              <Check size={16} aria-hidden="true" /> Done
            </button>
          </>
        ) : children}
      </div>
    </section>
  );
}
