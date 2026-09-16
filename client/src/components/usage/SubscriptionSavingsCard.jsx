import { useState, useMemo } from 'react';
import { PiggyBank, Save } from 'lucide-react';
import * as api from '../../services/api';
import Pill from '../ui/Pill';
import BrailleSpinner from '../BrailleSpinner';
import { formatUsd } from '../../utils/formatters';
import { useAsyncAction } from '../../hooks/useAsyncAction';

export const savingsTone = (savings) => (savings >= 0 ? 'text-port-success' : 'text-port-error');

const NO_FAMILIES = [];

// The three derived figures per plan, defined ONCE so the mobile cards, the
// desktop table and the Subscriptions page can't drift into showing different
// things (the first two already had: mobile was missing the totals row).
export const rowCells = (row) => [
  { key: 'period', label: 'This period', value: row.configured ? formatUsd(row.periodCost) : null },
  { key: 'api', label: 'Est. API cost', value: formatUsd(row.apiCost) },
  {
    key: 'savings',
    label: 'Savings',
    value: row.configured ? formatUsd(row.savings, { signed: true }) : null,
    tone: row.configured ? savingsTone(row.savings) : undefined,
    suffix: row.configured && row.multiplier != null ? `${row.multiplier}×` : null
  }
];

const totalCells = (totals) => [
  { key: 'period', label: 'This period', value: formatUsd(totals.periodCost) },
  { key: 'api', label: 'Est. API cost', value: formatUsd(totals.apiCost) },
  {
    key: 'savings',
    label: 'Savings',
    value: formatUsd(totals.savings, { signed: true }),
    tone: savingsTone(totals.savings),
    suffix: totals.savingsPercent != null ? `${totals.savingsPercent}%` : null
  }
];

// The draft map holds ONLY edited rows, so a period change (which refetches and
// hands down fresh `savings`) can't clobber a price the user is mid-way through
// typing, and an unedited row always renders the persisted value.
const displayValue = (drafts, row) =>
  (row.family in drafts ? drafts[row.family] : (row.monthlyCost > 0 ? String(row.monthlyCost) : ''));

/**
 * Parse an input string to the patch value the API expects: a positive number,
 * or `null` to CLEAR the plan. Empty and 0 both mean "I don't pay for this",
 * which must be sent (as null) rather than omitted — omitting it would leave
 * the old price in place. Returns `undefined` for unparseable input so the row
 * is skipped instead of silently clearing a price the user fat-fingered.
 */
export function parseCostInput(raw) {
  const trimmed = String(raw ?? '').trim();
  if (trimmed === '') return null;
  const value = Number(trimmed.replace(/^\$/, ''));
  if (!Number.isFinite(value) || value < 0) return undefined;
  return value > 0 ? Math.round(value * 100) / 100 : null;
}

/**
 * The rows whose price actually changed, as an API patch. Unchanged rows are
 * omitted so a save never rewrites a price the user didn't touch.
 */
export function buildCostPatch(drafts, families) {
  const stored = new Map(families.map((f) => [f.family, f.monthlyCost > 0 ? f.monthlyCost : null]));
  const patch = {};
  for (const [family, raw] of Object.entries(drafts)) {
    if (!stored.has(family)) continue;
    const next = parseCostInput(raw);
    if (next === undefined) continue;
    if (next !== stored.get(family)) patch[family] = next;
  }
  return patch;
}

export function CostInput({ row, value, onChange, idPrefix }) {
  return (
    <div className="flex items-center gap-1">
      <span className="text-gray-500 text-xs">$</span>
      <input
        id={`${idPrefix}-subscription-cost-${row.family}`}
        type="number"
        inputMode="decimal"
        min="0"
        step="1"
        placeholder="0"
        value={value}
        onChange={(e) => onChange(row.family, e.target.value)}
        className="w-20 bg-port-bg border border-port-border rounded px-2 py-1 text-sm text-white outline-none focus:border-port-accent"
        aria-label={`Monthly cost for ${row.label}`}
      />
      <span className="text-gray-500 text-xs">/mo</span>
    </div>
  );
}

export const NotPriced = () => <span className="text-gray-600">not priced</span>;

export function CellValue({ cell }) {
  return (
    <>
      <span className={cell.tone}>{cell.value ?? <NotPriced />}</span>
      {cell.suffix && <span className="text-[10px] text-gray-500 ml-1">{cell.suffix}</span>}
    </>
  );
}

/**
 * Per-family subscription pricing plus the savings those plans produced against
 * the cost report's API-rate estimate for the same window.
 *
 * `savings` is the `subscriptionSavings` block from GET /api/usage — it already
 * carries every family the editor should offer (including unpriced ones), so
 * this component never fetches the family list separately. `onSaved` refetches
 * the report and resolves once the new figures are in hand, so the button stays
 * busy until the rows on screen reflect the price that was just saved.
 */
export default function SubscriptionSavingsCard({ savings, onSaved }) {
  const [drafts, setDrafts] = useState({});
  // A stable empty array, not a fresh `|| []` per render: it is both the guard
  // for a payload that carries no `families` (an older peer's report) and the
  // memo dependency below, which would otherwise recompute on every render.
  const families = savings?.families ?? NO_FAMILIES;

  const patch = useMemo(() => buildCostPatch(drafts, families), [drafts, families]);
  const dirty = Object.keys(patch).length > 0;

  const [save, saving] = useAsyncAction(async () => {
    await api.updateSubscriptionCosts(patch, { silent: true });
    await onSaved?.();
    // Cleared only after the refetch lands: dropping the drafts first would
    // flash the pre-save prices back onto the rows in between.
    setDrafts({});
  }, { errorMessage: 'Failed to save subscription costs' });

  if (!savings) return null;

  const onChange = (family, value) => setDrafts((prev) => ({ ...prev, [family]: value }));
  const { totals, range } = savings;
  const windowLabel = range?.start
    ? `${range.start} → ${range.end} (${range.days} day${range.days === 1 ? '' : 's'})`
    : 'no usage recorded yet';

  return (
    <div className="bg-port-card border border-port-border rounded-xl p-3 sm:p-4 space-y-3">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
        <div>
          <h3 className="text-sm font-medium text-gray-400 flex items-center gap-2">
            <PiggyBank size={16} className="text-port-accent" />
            Subscription vs. API Cost
          </h3>
          <p className="text-[10px] sm:text-xs text-gray-500 mt-0.5">
            What your quota plans cost over {windowLabel}, against what the same usage would have cost at API rates.
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {dirty && (
            <button
              type="button"
              onClick={save}
              disabled={saving}
              className="inline-flex items-center gap-1.5 rounded-lg border border-port-accent px-3 py-1.5 text-sm text-white hover:bg-port-accent/20 disabled:opacity-50"
            >
              {saving ? <BrailleSpinner /> : <Save size={14} />} Save costs
            </button>
          )}
          {savings.configured && (
            <div className="text-right">
              <div className={`text-xl font-bold ${savingsTone(totals.savings)}`}>
                {formatUsd(totals.savings, { signed: true })}
              </div>
              <div className="text-[10px] text-gray-500">
                {totals.savings >= 0 ? 'saved' : 'over API cost'}
                {totals.multiplier != null && ` · ${totals.multiplier}×`}
              </div>
            </div>
          )}
        </div>
      </div>

      {families.length === 0 && (
        <p className="text-sm text-gray-500">
          No provider families to price — enable a Claude/Codex/Antigravity/Grok provider to record its plan cost.
        </p>
      )}

      {families.length > 0 && (
        <>
          {/* Mobile: one card per plan, so the numbers never need a sideways scroll. */}
          <div className="block sm:hidden space-y-2">
            {families.map((row) => (
              <div key={row.family} className="bg-port-bg border border-port-border rounded-lg p-3 space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <label htmlFor={`mobile-subscription-cost-${row.family}`} className="text-sm font-medium text-white truncate">
                    {row.label}
                    {!row.enabled && <Pill tone="context" size="xs" className="ml-2">disabled</Pill>}
                  </label>
                  <CostInput row={row} value={displayValue(drafts, row)} onChange={onChange} idPrefix="mobile" />
                </div>
                <div className="grid grid-cols-3 gap-2 text-[11px] text-white">
                  {rowCells(row).map((cell) => (
                    <div key={cell.key}>
                      <span className="text-gray-500 block">{cell.label}</span>
                      <CellValue cell={cell} />
                    </div>
                  ))}
                </div>
              </div>
            ))}
            {savings.configured && (
              <div className="bg-port-bg border border-port-border rounded-lg p-3 space-y-2">
                <div className="flex items-center justify-between text-sm font-semibold text-white">
                  <span>Total</span>
                  <span className="text-gray-400 font-normal text-xs">{formatUsd(totals.monthlyCost, { trimWhole: true })}/mo</span>
                </div>
                <div className="grid grid-cols-3 gap-2 text-[11px] text-white">
                  {totalCells(totals).map((cell) => (
                    <div key={cell.key}>
                      <span className="text-gray-500 block">{cell.label}</span>
                      <CellValue cell={cell} />
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Desktop: table */}
          <div className="hidden sm:block overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-gray-500 border-b border-port-border">
                  <th className="py-2 pr-2 font-medium">Subscription</th>
                  <th className="py-2 px-2 font-medium">Cost</th>
                  {rowCells(families[0]).map((cell) => (
                    <th key={cell.key} className="py-2 px-2 font-medium text-right">{cell.label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {families.map((row) => (
                  <tr key={row.family} className="border-t border-port-border text-white">
                    <td className="py-2 pr-2">
                      <label htmlFor={`desktop-subscription-cost-${row.family}`} className="font-medium cursor-pointer">
                        {row.label}
                      </label>
                      {!row.enabled && <Pill tone="context" size="xs" className="ml-2">disabled</Pill>}
                    </td>
                    <td className="py-2 px-2">
                      <CostInput row={row} value={displayValue(drafts, row)} onChange={onChange} idPrefix="desktop" />
                    </td>
                    {rowCells(row).map((cell) => (
                      <td key={cell.key} className="py-2 px-2 text-right text-gray-300">
                        <CellValue cell={cell} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
              {savings.configured && (
                <tfoot>
                  <tr className="border-t border-port-border font-semibold text-white">
                    <td className="py-2 pr-2">Total</td>
                    <td className="py-2 px-2 text-gray-400 font-normal">
                      {formatUsd(totals.monthlyCost, { trimWhole: true })}/mo
                    </td>
                    {totalCells(totals).map((cell) => (
                      <td key={cell.key} className="py-2 px-2 text-right">
                        <CellValue cell={cell} />
                      </td>
                    ))}
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        </>
      )}

      <p className="text-[10px] sm:text-xs text-gray-500">
        Enter what each plan costs you per month (annual plans: divide by 12). A plan&rsquo;s cost is prorated across the
        selected report window, so both sides of the comparison cover the same days.
        {savings.unmatchedApiCost > 0 && (
          <>
            {' '}<span className="text-gray-400">{formatUsd(savings.unmatchedApiCost)}</span> of estimated API cost came from
            usage no subscription covers (pay-as-you-go API providers or pre-breakdown legacy rows) and is excluded from savings.
          </>
        )}
        {' '}Savings inherit the estimate&rsquo;s accuracy — rows marked Estimated above understate real usage.
      </p>
    </div>
  );
}
