import { useState } from 'react';
import { Check, Link2, LogIn } from 'lucide-react';
import PublishCard from './PublishCard.jsx';
import { crossLinkBackfill, crossLinksEnabled } from '../../../../server/lib/musicVideoCrossLinks.js';

const LABELS = { youtube: 'YouTube description', suno: 'Suno caption', x: 'X reply', stackerNews: 'Stacker News comment', facebook: 'Facebook comment' };
const ACTION = { youtube: 'Fill edit', suno: 'Fill edit', x: 'Fill reply', stackerNews: 'Fill comment', facebook: 'Fill comment' };
const btn = 'flex items-center gap-1 border border-port-border disabled:opacity-50 rounded px-2 py-1.5 text-xs min-h-[44px] sm:min-h-0';

/** One posted platform: the links it lacks, a Fill that opens its edit in the PortOS Browser, and Saved. */
function BackfillRow({ row, publishing }) {
  const [busy, setBusy] = useState(null);
  const [filled, setFilled] = useState(null);
  const [error, setError] = useState(null);
  const label = LABELS[row.target];
  const fill = () => {
    setBusy('fill');
    setError(null);
    publishing.prepareCrossLinks(row.target)
      .then((res) => setFilled(res))
      .catch((err) => setError({ message: err?.message || 'Failed', login: err?.code === 'PUBLISH_LOGIN_REQUIRED' }))
      .finally(() => setBusy(null));
  };
  // Saved records the links this edit added (the ones listed when it was filled).
  const saved = () => {
    setBusy('saved');
    publishing.recordPost(row.target, { links: filled?.links || row.missing.map((l) => l.target) })
      .then((post) => { if (post) setFilled(null); })
      .finally(() => setBusy(null));
  };
  const done = !row.missing.length;
  return (
    <li className="rounded border border-port-border p-2 space-y-1.5 min-w-0">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="font-medium">{label}</div>
          <div className="text-[11px] text-port-text-muted break-words">
            {done ? 'Links every other post' : `Add ${row.missing.map((l) => l.label).join(', ')}`}
          </div>
        </div>
        {!done && (
          <div className="flex flex-wrap gap-1.5">
            <button type="button" onClick={fill} disabled={!!busy} className={`${btn} bg-port-accent/20 text-port-accent border-transparent`}>
              {busy === 'fill' ? 'Filling…' : (filled ? 'Fill again' : ACTION[row.target])}
            </button>
            <button type="button" onClick={saved} disabled={!!busy} aria-label={`Mark the ${label} links saved`} className={btn}>
              <Check size={12} /> {busy === 'saved' ? 'Saving…' : 'Saved'}
            </button>
          </div>
        )}
      </div>
      {!done && <pre className="whitespace-pre-wrap break-all text-[11px] bg-port-bg rounded p-1.5">{row.text}</pre>}
      {error && <div role="alert" className="text-[11px] text-port-error flex items-center gap-1">{error.login && <LogIn size={11} />}{error.message}</div>}
      {filled && (
        <div className="space-y-1">
          {filled.screenshot && <img src={filled.screenshot} alt={`${label} with the links filled in`} className="w-full rounded border border-port-border" />}
          {filled.summary?.leftForYou?.length > 0 && (
            <p className="text-[11px] text-port-text-muted whitespace-pre-wrap">Left for you in the PortOS Browser: {filled.summary.leftForYou.join(' · ')}. Then press Saved here.</p>
          )}
        </div>
      )}
    </li>
  );
}

/**
 * Cross-links between the release's posts: new drafts list the posts already
 * made (a switch), and a post that went up before the others can take their
 * links afterwards. Fill opens its edit form, or a reply/comment under it, in
 * the PortOS Browser with the links added; the director saves it there and
 * presses Saved here. PortOS never saves, posts or deletes on a platform.
 */
export default function PublishCrossLinksPanel({ project, publishing }) {
  const kit = project?.publishKit || {};
  if (!kit.builtAt || !publishing?.prepareCrossLinks) return null;
  const rows = crossLinkBackfill(kit);
  const enabled = crossLinksEnabled(kit);
  const pending = rows.filter((r) => r.missing.length).length;
  return (
    <PublishCard projectId={project.id} cardId="cross-links" label="Cross-links" icon={Link2}
      summary={pending ? `${pending} post${pending === 1 ? '' : 's'} missing links` : ''} defaultOpen={pending > 0}>
      <label htmlFor={`mv-cross-links-${project.id}`} className="flex items-center gap-1.5 min-h-[44px] sm:min-h-0">
        <input id={`mv-cross-links-${project.id}`} type="checkbox" checked={enabled} onChange={(e) => publishing.setCrossLinks(e.target.checked)} />
        New drafts link the posts already made (YouTube, Suno, X, Stacker News, Substack)
      </label>
      {rows.length ? (
        <ul className="space-y-2">{rows.map((row) => <BackfillRow key={row.target} row={row} publishing={publishing} />)}</ul>
      ) : (
        <p className="text-port-text-muted">Once YouTube, Suno, X or Stacker News is posted, this lists the links each one still lacks.</p>
      )}
    </PublishCard>
  );
}
