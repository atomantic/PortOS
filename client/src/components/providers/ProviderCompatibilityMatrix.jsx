import { useMemo } from 'react';
import { Grid3x3 } from 'lucide-react';
import CollapsibleSection from '../ui/CollapsibleSection';
import { serviceReadinessCopy } from '../../lib/providerManagement';
import { pluralize } from '../../lib/textUtils';

/**
 * The compatibility matrix (#7567): harness rows × service columns. Rendered
 * from `GET /api/providers/catalog`: whether a pair is REACHABLE is
 * `compatibility[harnessId]`, the server's own `isCompatible`, never
 * re-derived here; whether a reachable pair is OFFERED reads the same three
 * server fields the compose popover reads (`harness.enabled`,
 * `service.enabled`, `service.readiness`), so a cell can only disagree with
 * compose by the catalog being stale.
 *
 * Three cell states:
 *   - **offered** — compatible, both sides on, service ready: a click opens
 *     the compose flow on that pair ("New preset", prefilled).
 *   - **blocked** — compatible, but a side is switched off or the service
 *     still needs a credential / endpoint. The reason is the cell's title and
 *     accessible name; nothing to click, the fix is on the other two views.
 *   - **incompatible** — the harness cannot reach that service at all.
 */

/** The pure verdict per cell, exported so the page test can pin it without rendering. */
export function matrixCellState(harness, service, compatibility) {
  if (!(compatibility?.[harness.id] || []).includes(service.slug)) return { state: 'incompatible', reason: null };
  if (harness.enabled === false) return { state: 'blocked', reason: `${harness.label} is switched off` };
  if (service.enabled === false) return { state: 'blocked', reason: `${service.label} is switched off` };
  if (service.readiness && service.readiness !== 'ready') {
    return { state: 'blocked', reason: `${service.label} ${serviceReadinessCopy(service.readiness).reason}` };
  }
  return { state: 'offered', reason: null };
}

const CELL_CLASS = {
  offered: 'bg-port-success/20 text-port-success hover:bg-port-success/30 cursor-pointer',
  blocked: 'bg-port-warning/15 text-port-warning',
  incompatible: 'text-gray-600',
};
const CELL_GLYPH = { offered: '●', blocked: '◐', incompatible: '—' };

/**
 * @param {object} props
 * @param {object[]} props.harnesses - catalog rows (`id`, `label`, `modes`, `enabled`).
 * @param {object[]} props.services - catalog rows (`slug`, `label`, `enabled`, `readiness`).
 * @param {Record<string,string[]>} props.compatibility - harness id → compatible service slugs.
 * @param {boolean} props.loading
 * @param {function} props.onCompose - `({ harnessId, method, serviceSlug }) => void` for an offered cell.
 */
export default function ProviderCompatibilityMatrix({ harnesses = [], services = [], compatibility = {}, loading = false, onCompose }) {
  // One pass over the product per catalog: the rows render from it and the
  // summary counts it, on a page that re-renders on a 20s poll.
  const rows = useMemo(() => harnesses.map((harness) => ({
    harness,
    cells: services.map((service) => ({ service, ...matrixCellState(harness, service, compatibility) })),
  })), [harnesses, services, compatibility]);
  const offered = useMemo(() => rows.reduce((count, row) => count + row.cells.filter((cell) => cell.state === 'offered').length, 0), [rows]);

  return (
    <CollapsibleSection
      id="compatibility-matrix"
      icon={Grid3x3}
      label="Compatibility matrix"
      summary={loading ? 'Loading…' : `${pluralize(offered, 'combination')} offered`}
      defaultOpen={false}
      size="md"
      className="bg-port-card border border-port-border rounded-xl px-4 py-2"
      bodyClassName="pb-2"
    >
      {services.length === 0 ? (
        <p className="text-xs text-gray-500">No services yet — add one on the Services view and every compatible harness lights up here.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="text-xs border-separate border-spacing-0 min-w-full" aria-label="Harness and service compatibility">
            <thead>
              <tr>
                <th scope="col" className="sticky left-0 bg-port-card text-left text-gray-500 font-normal pr-3 py-1">Harness</th>
                {services.map((service) => (
                  <th key={service.slug} scope="col" className="text-gray-400 font-medium px-2 py-1 whitespace-nowrap">
                    <span title={service.slug}>{service.label}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map(({ harness, cells }) => (
                <tr key={harness.id}>
                  <th scope="row" className="sticky left-0 bg-port-card text-left text-gray-300 font-medium pr-3 py-1 whitespace-nowrap">
                    {harness.label}{harness.enabled === false ? <span className="text-gray-600"> (off)</span> : null}
                  </th>
                  {cells.map(({ service, state, reason }) => {
                    const name = state === 'offered'
                      ? `New preset: ${harness.label} on ${service.label}`
                      : state === 'blocked' ? `${harness.label} on ${service.label}: ${reason}` : `${harness.label} cannot reach ${service.label}`;
                    return (
                      <td key={service.slug} className="px-1 py-0.5 text-center">
                        {state === 'offered' ? (
                          <button
                            type="button"
                            title={name}
                            aria-label={name}
                            onClick={() => onCompose({ harnessId: harness.id, method: harness.modes?.[0] || '', serviceSlug: service.slug })}
                            className={`inline-flex h-7 w-7 items-center justify-center rounded ${CELL_CLASS.offered}`}
                          >
                            {CELL_GLYPH.offered}
                          </button>
                        ) : (
                          <span
                            role="img"
                            title={name}
                            aria-label={name}
                            className={`inline-flex h-7 w-7 items-center justify-center rounded ${CELL_CLASS[state]}`}
                          >
                            {CELL_GLYPH[state]}
                          </span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-2 text-[11px] text-gray-500">● offered — click for a new preset · ◐ compatible but blocked (hover for why) · — not reachable</p>
        </div>
      )}
    </CollapsibleSection>
  );
}
