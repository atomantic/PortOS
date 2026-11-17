import { Link } from 'react-router';
import { CATALOG_BADGE_BY_ID } from '../../../lib/catalogTypes';
import { ingredientPath } from '../../../lib/creativeLibraries';
import { formatDateTime } from '../../../utils/formatters';

// Source scraps + "From the same source" siblings (#7617). Each source scrap's
// TITLE is the click-through to `/catalog?scrap=<id>` — every other extraction
// from that piece, one click, one shareable link (selection lives in the URL
// per client/src/AGENTS.md). The scrap's id is a fallback label only for a
// scrap whose title didn't come through (e.g. hard-deleted; `scrapTitle` is
// null via the route's LEFT JOIN). A scrap with no OTHER live extractions
// renders no "From the same source" stub — an empty list is not useful chrome.
export default function SourcesPanel({ sources, evidence }) {
  const list = Array.isArray(sources) ? sources : [];
  const evidenceList = Array.isArray(evidence)
    ? evidence.filter((item) => typeof item === 'string' && item.trim())
    : typeof evidence === 'string' && evidence.trim()
    ? evidence.split('\n').map((s) => s.trim()).filter(Boolean)
    : [];
  return (
    <section className="bg-port-card border border-port-border rounded-lg p-4">
      <h2 className="text-sm font-semibold text-white mb-2">Source scraps</h2>
      {list.length === 0 ? (
        <p className="text-xs text-gray-500">Created manually — no source scrap.</p>
      ) : (
        <ul className="space-y-3">
          {list.map((s, i) => {
            const siblings = Array.isArray(s.siblings) ? s.siblings : [];
            return (
              <li key={s.scrapId || i} className="text-xs text-gray-300">
                <div className="flex items-center justify-between gap-2">
                  {s.scrapId ? (
                    <Link to={`/catalog?scrap=${encodeURIComponent(s.scrapId)}`}
                      state={{ scrapTitle: s.scrapTitle || undefined }}
                      className="truncate hover:text-port-accent hover:underline"
                      title={s.scrapTitle || s.scrapId}>
                      {s.scrapTitle || s.scrapId}
                    </Link>
                  ) : (
                    <span className="font-mono truncate">(unknown source)</span>
                  )}
                  {s.extractedAt && <span className="text-gray-500 whitespace-nowrap">{formatDateTime(s.extractedAt)}</span>}
                </div>
                {siblings.length > 0 && (
                  <div className="mt-1.5 pl-2 border-l border-port-border">
                    <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-1">From the same source</div>
                    <div className="flex flex-wrap gap-1.5">
                      {siblings.map((sib) => {
                        const badge = CATALOG_BADGE_BY_ID[sib.type] || 'bg-gray-500/20 text-gray-300 border-gray-500/40';
                        return (
                          <Link key={sib.id} to={ingredientPath(sib)}
                            className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded border border-port-border bg-port-bg text-gray-200 hover:opacity-80">
                            <span className="truncate max-w-[12rem]">{sib.name || sib.id}</span>
                            <span className={`text-[9px] uppercase tracking-wider px-1 py-0.5 rounded border ${badge}`}>{sib.type}</span>
                          </Link>
                        );
                      })}
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {evidenceList.length > 0 && (
        <div className="mt-4 pt-3 border-t border-port-border">
          <h3 className="text-xs font-semibold text-gray-300 mb-2">Grounded evidence</h3>
          <ul className="space-y-1.5 text-xs text-gray-400">
            {evidenceList.map((item, idx) => (
              <li key={idx} className="italic pl-2 border-l border-port-border">
                “{item}”
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
