import { openExternalUrl } from '../../../utils/openExternalUrl.js';
import { isHttpUrl } from '../../../utils/urlNormalize.js';
import { memo } from 'react';
import { Link } from 'react-router';
import { ChevronDown, ChevronRight, CircleDot, ExternalLink, MessageSquare, User } from 'lucide-react';
import Pill from '../../ui/Pill';
import { useThemeContext } from '../../ThemeContext';
import ScopeAdherenceCheck from '../ScopeAdherenceCheck';
import { chipColors } from '../../../lib/chipContrast';
import { timeAgo } from '../../../utils/formatters';
import AddToThreadButton from '../../threads/AddToThreadButton';
import RunActionButton from './RunActionButton';
import { ACTION_ORDER, ISSUE_ACTIONS, RUN_STATUS_LABEL } from './useIssueRuns';

// Compact, content-width row buttons (right-aligned, wrap on narrow rows); touch
// devices get a taller 36px target instead of full-width 44px slabs.
const ISSUE_ACTION_BUTTON = 'px-2.5 py-1 min-h-7 pointer-coarse:min-h-9 rounded-md text-xs';


// Row background tint for the two claim-state labels. Uses the theme's
// warning/error tokens (alpha-tinted so every theme keeps its own palette
// rather than a hardcoded color), blocked taking precedence over in-progress.
function issueRowTint(issue) {
  const names = new Set(issue.labels.map(l => l.name));
  if (names.has('blocked')) return 'bg-port-error/10';
  if (names.has('in-progress')) return 'bg-port-warning/10';
  return 'bg-port-card';
}

/**
 * Label chips carry the forge's own color, which is arbitrary per-repo data —
 * so it can't be a Tailwind class (those must be literal strings in source).
 * Render it as a tinted chip via inline style: a low-alpha wash of the label's
 * own color for the background, and `chipContrast` for the text/border, which
 * keeps the hue but moves its lightness until it clears WCAG AA on the ACTIVE
 * theme mode. Verbatim label color only ever worked on night themes — GitHub's
 * pale defaults (`plan` #fef2c0, `effort:*` #c5def5) rendered as ~1.1:1 on the
 * day themes, i.e. invisible.
 *
 * A label with no color — or a color we can't parse — gets no inline style, so
 * the chip keeps its own neutral look (the `muted` Pill tone on a row chip).
 */
function LabelChip({ label }) {
  const { theme } = useThemeContext();
  const style = chipColors(label.color, theme?.mode);
  return (
    <Pill
      size="xs"
      tone={style ? 'bare' : 'muted'}
      title={label.description || undefined}
      style={style}
    >
      {label.name}
    </Pill>
  );
}

export default memo(function IssueRow({
  issue, appId, appName, forge, forgeLabel, isOpen, toggleExpanded, claimStatus, replanStatus, handleRun, invalidReviewOverride
}) {
  const statuses = { claim: claimStatus, replan: replanStatus };

  return (
    <div className={`${issueRowTint(issue)} @container`}>
      <div className="flex flex-col @min-[40rem]:flex-row @min-[40rem]:items-start gap-2 @min-[40rem]:gap-3 p-3">
        <div className="flex items-start gap-2 flex-1 min-w-0">
          <button
            onClick={() => toggleExpanded(issue.number)}
            aria-expanded={isOpen}
            aria-label={`${isOpen ? 'Collapse' : 'Expand'} description for issue ${issue.number}`}
            className="pointer-coarse:min-h-11 pointer-coarse:min-w-11 flex text-gray-500 hover:text-white transition-colors mt-0.5 shrink-0"
          >
            {isOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
          </button>

          <div className="flex-1 min-w-0">
            <div className="flex items-start gap-2">
              <CircleDot size={14} className="text-port-success shrink-0 mt-0.5" />
              <span className="text-xs font-mono text-gray-500 shrink-0 mt-0.5">#{issue.number}</span>
              <button
                onClick={() => toggleExpanded(issue.number)}
                aria-expanded={isOpen}
                className="text-sm font-medium text-white text-left hover:text-port-accent transition-colors break-words flex-1 min-w-0"
              >
                {issue.title || '(no title)'}
              </button>
            </div>

            {issue.labels.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-1.5">
                {issue.labels.map(l => <LabelChip key={l.name} label={l} />)}
              </div>
            )}

            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1.5 text-xs text-gray-500">
              {issue.author && <span>opened by {issue.author}</span>}
              {issue.updatedAt && <span>updated {timeAgo(issue.updatedAt)}</span>}
              {issue.milestone && <span className="text-cyan-400">{issue.milestone}</span>}
              {issue.commentCount > 0 && (
                <span className="flex items-center gap-1">
                  <MessageSquare size={12} /> {issue.commentCount} comment{issue.commentCount === 1 ? '' : 's'}
                </span>
              )}
              {issue.assignees.length > 0 ? (
                <span className="flex items-center gap-1 text-gray-300">
                  <User size={12} /> {issue.assignees.join(', ')}
                </span>
              ) : (
                <span className="italic">unassigned</span>
              )}
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-end gap-1.5 shrink-0 @min-[40rem]:max-w-[45%]">
          {ACTION_ORDER.map(action => {
            const spec = ISSUE_ACTIONS[action];
            const state = statuses[action];
            const Icon = spec.icon;
            // A launched run swaps its button for a link to the agent
            // queue: the run is no longer this row's to start, and the
            // one thing the user wants next is to watch it.
            if (state && state !== 'queuing') {
              return (
                <Link
                  key={action}
                  to="/cos/agents"
                  aria-label={`${spec.label} #${issue.number}: ${RUN_STATUS_LABEL[state] || 'Queued — view'}`}
                  className={`${ISSUE_ACTION_BUTTON} bg-port-success/20 text-port-success hover:bg-port-success/30 border border-port-border flex items-center gap-1.5 whitespace-nowrap transition-colors`}
                >
                  <Icon size={14} /> {spec.label} · {RUN_STATUS_LABEL[state] || 'Queued — view'}
                </Link>
              );
            }
            return (
              <RunActionButton
                key={action}
                onClick={() => handleRun(issue, action)}
                busy={state === 'queuing'}
                disabled={action === 'claim' && invalidReviewOverride}
                title={spec.title(issue.number, appName)}
                icon={Icon}
                className={`${ISSUE_ACTION_BUTTON} ${spec.tone} border border-port-border`}
              >
                {spec.label}
              </RunActionButton>
            );
          })}
          {(issue.url || issue.html_url) && (
            <AddToThreadButton
              refItem={{
                kind: forge === 'gitlab' ? 'gitlab.issue' : 'github.issue',
                id: issue.url || issue.html_url,
                label: `#${issue.number} ${issue.title || ''}`.trim()
              }}
              buttonText="Thread"
              className={`${ISSUE_ACTION_BUTTON} bg-port-bg text-gray-300 hover:text-white border border-port-border flex items-center gap-1.5 transition-colors`}
            />
          )}
          {isHttpUrl(issue.url) && (
            <a
              href={issue.url}
              target="_blank"
              rel="noopener noreferrer"
              role="button"
              aria-label={`Open issue ${issue.number} on ${forgeLabel}`}
              title={`Open issue ${issue.number} on ${forgeLabel}`}
              onKeyDown={(e) => {
                if (e.key === ' ' || e.key === 'Spacebar') {
                  e.preventDefault();
                  openExternalUrl(issue.url);
                }
              }}
              className={`${ISSUE_ACTION_BUTTON} inline-flex items-center gap-1.5 border border-port-border bg-port-bg text-gray-300 hover:text-white hover:border-port-accent/40 hover:bg-port-border/40 transition-colors`}
            >
              <ExternalLink size={14} />
              <span>{forgeLabel}</span>
            </a>
          )}
        </div>
      </div>

      {isOpen && (
        <div className="px-3 pb-3 sm:pl-10">
          {issue.body?.trim() ? (
            <pre className="text-xs text-gray-300 whitespace-pre-wrap break-words font-sans bg-port-bg border border-port-border rounded-lg p-3 max-h-96 overflow-auto">
              {issue.body}
            </pre>
          ) : (
            <p className="text-xs text-gray-500 italic">No description.</p>
          )}
          {/* Advisory only, and only under an expanded row: the
              reader has the description in front of them, so the
              clause the scorer cites is something they can check. */}
          <ScopeAdherenceCheck
            appId={appId}
            kind="issue"
            title={issue.title || ''}
            body={issue.body || ''}
          />
        </div>
      )}
    </div>
  );
});
