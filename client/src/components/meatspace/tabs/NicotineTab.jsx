import { useState, useMemo } from 'react';
import { Cigarette, Plus, Trash2, Pencil, Check, X, Settings } from 'lucide-react';
import { pluralize } from '../../../lib/textUtils';
import {
  getCustomNicotineProducts,
  getNicotineSummary,
  getDailyNicotine,
  logNicotine,
  removeNicotineEntry,
  updateNicotineEntry,
  addCustomNicotineProduct,
  updateCustomNicotineProduct,
  removeCustomNicotineProduct,
} from '../../../services/apiMeatspace.js';
import BrailleSpinner from '../../BrailleSpinner';
import LoadFailureNotice from '../LoadFailureNotice';
import ConfirmButtonPair from '../../ui/ConfirmButtonPair';
import { FormField } from '../../ui/FormField';
import NicotineChart from '../NicotineChart';
import NicotineHealthCorrelation from '../NicotineHealthCorrelation';
import { dayOfWeek } from '../constants';
import { localDateKey } from '../../../utils/formatters';
import DraftNumber from '../../ui/DraftNumber';
import useSubstanceLog from '../useSubstanceLog';

const nicotineLog = {
  getSummary: getNicotineSummary,
  entry: {
    read: getDailyNicotine,
    add: logNicotine,
    update: updateNicotineEntry,
    remove: removeNicotineEntry,
    emptyDraft: { product: '', mgPerUnit: '', count: 1 },
    canAdd: ({ mgPerUnit }) => Boolean(mgPerUnit),
    toPayload: ({ product, mgPerUnit }) => ({ product, mgPerUnit: parseFloat(mgPerUnit) }),
    fromRecord: item => ({ product: item.product || '', mgPerUnit: String(item.mgPerUnit || '') }),
    fromButton: ({ name, mgPerUnit }) => ({ product: name, mgPerUnit })
  },
  button: {
    read: getCustomNicotineProducts,
    add: addCustomNicotineProduct,
    update: (...args) => updateCustomNicotineProduct(...args),
    remove: removeCustomNicotineProduct,
    label: 'product',
    emptyDraft: { name: '', mgPerUnit: '' },
    toPayload: ({ name, mgPerUnit }) => ({ name, mgPerUnit: parseFloat(mgPerUnit) }),
    fromRecord: item => ({ name: item.name, mgPerUnit: String(item.mgPerUnit) }),
    validate: ({ name, mgPerUnit }) => {
      if (!name) return 'Name is required';
      const parsed = parseFloat(mgPerUnit);
      if (isNaN(parsed) || parsed < 0.1 || parsed > 100) return 'mg must be between 0.1 and 100';
      return null;
    }
  }
};

export default function NicotineTab() {
  const {
    summary, loading, loadFailed, logging, refreshKey, fetchData,
    totalDays, visibleEntries, remainingDays, loadMoreDays,
    chartView, setChartView, correlationData,
    entryForm: { product, mgPerUnit, count }, setEntryForm, editingKey, editForm, setEditForm,
    handleQuickAdd, handleCustomAdd, handleRemove, startEdit, cancelEdit, saveEdit,
    buttons: productButtons, buttonsFailed, fetchButtons, managingButtons, setManagingButtons,
    editingButtonIdx, buttonForm, setButtonForm, handleAddButton,
    startEditButton, saveEditButton, cancelEditButton, handleRemoveButton,
    isConfirming, requestDelete, cancelDelete, confirmDelete
  } = useSubstanceLog(nicotineLog);
  const today = useMemo(() => localDateKey(), []);
  const [date, setDate] = useState(today);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <BrailleSpinner text="Loading" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {loadFailed && (
        <LoadFailureNotice message="Could not load nicotine history." onRetry={fetchData} />
      )}
      {/* Compact Summary Stats Bar */}
      {summary && (
        <div className="flex flex-wrap items-center gap-x-6 gap-y-1 px-4 py-2 bg-port-card border border-port-border rounded-lg">
          <div className="flex items-center gap-1.5">
            <Cigarette size={14} className="text-gray-500" />
            <span className="text-xs text-gray-500">Today</span>
            <span className="text-sm font-bold text-white">{summary.today ?? 0}mg</span>
            <span className="text-xs text-gray-600">({summary.todayCount ?? 0})</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-gray-500">7d</span>
            <span className="text-sm font-semibold text-gray-300">{summary.avg7day ?? 0}mg/d</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-gray-500">30d</span>
            <span className="text-sm font-semibold text-gray-300">{summary.avg30day ?? 0}mg/d</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-gray-500">Week</span>
            <span className="text-sm font-semibold text-gray-300">{summary.weeklyTotal ?? 0}mg</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-gray-500">All-time</span>
            <span className="text-sm font-semibold text-gray-400">{summary.allTimeAvg ?? 0}mg/d</span>
          </div>
        </div>
      )}

      {/* Quick Add + Custom Entry — single card */}
      <div className="bg-port-card border border-port-border rounded-xl p-4">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-medium text-gray-400 uppercase tracking-wider">Log Nicotine</h2>
          {productButtons && <button
            type="button"
            aria-expanded={managingButtons}
            onClick={() => setManagingButtons(!managingButtons)}
            className={`flex items-center gap-1 px-2 py-1 text-xs rounded-lg transition-colors ${
              managingButtons ? 'bg-port-accent/20 text-port-accent' : 'text-gray-500 hover:text-gray-300'
            }`}
            title="Manage product buttons"
          >
            <Settings size={14} />
            {managingButtons ? 'Done' : 'Manage'}
          </button>}
        </div>

        {buttonsFailed && (
          <div className="mb-3">
            <LoadFailureNotice message="Could not load your quick-add product buttons." onRetry={fetchButtons} />
          </div>
        )}

        {productButtons && managingButtons ? (
          <div className="space-y-2">
            {productButtons.map((btn, idx) => (
              <div key={idx} className="flex items-center gap-2">
                {editingButtonIdx === idx ? (
                  <>
                    <input
                      type="text"
                      value={buttonForm.name}
                      onChange={e => setButtonForm({ ...buttonForm, name: e.target.value })}
                      className="flex-1 bg-port-bg border border-port-border rounded px-2 py-1.5 text-xs text-white"
                      placeholder="Name"
                      aria-label="Product button name"
                    />
                    <input
                      type="number"
                      value={buttonForm.mgPerUnit}
                      onChange={e => setButtonForm({ ...buttonForm, mgPerUnit: e.target.value })}
                      className="w-16 bg-port-bg border border-port-border rounded px-2 py-1.5 text-xs text-white"
                      placeholder="mg"
                      aria-label="Product button milligrams per unit"
                      step="0.1"
                    />
                    <button aria-label="Save" onClick={saveEditButton} className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center p-1.5 text-port-success hover:text-white"><Check size={14} /></button>
                    <button aria-label="Cancel" onClick={cancelEditButton} className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center p-1.5 text-gray-500 hover:text-white"><X size={14} /></button>
                  </>
                ) : (
                  <>
                    <span className="flex-1 text-xs text-gray-300">{btn.name}</span>
                    <span className="text-xs text-gray-500">{btn.mgPerUnit}mg</span>
                    <button aria-label={`Edit ${btn.name}`} onClick={() => startEditButton(idx)} className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center p-1.5 text-gray-600 hover:text-port-accent"><Pencil size={12} /></button>
                    {isConfirming(`btn:${idx}`) ? (
                      <ConfirmButtonPair
                        prompt="Remove?"
                        confirmText="Remove"
                        confirmIcon={Trash2}
                        ariaLabel={`Confirm remove product button ${btn.name}`}
                        onConfirm={() => confirmDelete(() => handleRemoveButton(idx))}
                        onCancel={cancelDelete}
                      />
                    ) : (
                      <button aria-label={`Delete ${btn.name}`} onClick={() => requestDelete(`btn:${idx}`)} className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center p-1.5 text-gray-600 hover:text-port-error"><Trash2 size={12} /></button>
                    )}
                  </>
                )}
              </div>
            ))}
            {editingButtonIdx === null && (
              <form onSubmit={handleAddButton} className="flex items-center gap-2 pt-2 border-t border-port-border/50">
                <input
                  type="text"
                  value={buttonForm.name}
                  onChange={e => setButtonForm({ ...buttonForm, name: e.target.value })}
                  className="flex-1 bg-port-bg border border-port-border rounded px-2 py-1.5 text-xs text-white placeholder-gray-600"
                  placeholder="New product name"
                  aria-label="New product button name"
                />
                <input
                  type="number"
                  value={buttonForm.mgPerUnit}
                  onChange={e => setButtonForm({ ...buttonForm, mgPerUnit: e.target.value })}
                  className="w-16 bg-port-bg border border-port-border rounded px-2 py-1.5 text-xs text-white placeholder-gray-600"
                  placeholder="mg"
                  aria-label="New product button milligrams per unit"
                  step="0.1"
                />
                <button type="submit" aria-label="Add product" className="pointer-coarse:min-h-11 pointer-coarse:min-w-11 px-3 py-1.5 bg-port-accent/10 text-port-accent rounded text-xs hover:bg-port-accent/20">
                  <Plus size={14} />
                </button>
              </form>
            )}
          </div>
        ) : (
          <>
            {/* Quick-add buttons */}
            <div className="flex flex-wrap gap-2 mb-3">
              {productButtons?.map((btn, idx) => (
                <button
                  key={idx}
                  onClick={() => handleQuickAdd(btn, date)}
                  disabled={logging}
                  className="flex items-center gap-1 px-3 py-2 min-h-[40px] text-xs bg-port-border/50 text-gray-300 rounded-lg hover:bg-port-accent/10 hover:text-port-accent transition-colors disabled:opacity-50"
                >
                  <Plus size={12} />
                  {btn.name}
                </button>
              ))}
            </div>

            {/* Custom entry + date — single row */}
            <form onSubmit={e => handleCustomAdd(e, date)} className="flex flex-wrap items-end gap-2 pt-2 border-t border-port-border/50">
              <FormField label="Product" className="flex-1 min-w-[100px]" labelClassName="block text-xs text-gray-500 mb-1">
                <input
                  type="text"
                  value={product}
                  onChange={e => setEntryForm(f => ({ ...f, product: e.target.value }))}
                  className="w-full bg-port-bg border border-port-border rounded px-2 py-1.5 text-xs text-white placeholder-gray-600"
                  placeholder="e.g. Stokes Pick"
                />
              </FormField>
              <FormField label="mg" className="w-16" labelClassName="block text-xs text-gray-500 mb-1">
                <input
                  type="number"
                  value={mgPerUnit}
                  onChange={e => setEntryForm(f => ({ ...f, mgPerUnit: e.target.value }))}
                  className="w-full bg-port-bg border border-port-border rounded px-2 py-1.5 text-xs text-white placeholder-gray-600"
                  placeholder="5"
                  step="0.1"
                  min="0.1"
                  required
                />
              </FormField>
              <DraftNumber integer value={count} onCommit={value => setEntryForm(f => ({ ...f, count: value }))} min={1}>
                {(field) => (
                  <FormField label="Qty" className="w-14" labelClassName="block text-xs text-gray-500 mb-1">
                    <input type="number" className="w-full bg-port-bg border border-port-border rounded px-2 py-1.5 text-xs text-white" {...field} />
                  </FormField>
                )}
              </DraftNumber>
              <FormField label="Date" labelClassName="block text-xs text-gray-500 mb-1">
                <input
                  type="date"
                  value={date}
                  onChange={e => setDate(e.target.value)}
                  className="bg-port-bg border border-port-border rounded px-2 py-1.5 text-xs text-white"
                />
              </FormField>
              {date !== today && (
                <button
                  type="button"
                  onClick={() => setDate(today)}
                  className="text-xs text-port-accent hover:underline py-1.5"
                >
                  Reset
                </button>
              )}
              <button
                type="submit"
                disabled={logging || !mgPerUnit}
                className="flex items-center gap-1 px-3 py-1.5 min-h-[32px] bg-port-accent text-white rounded-lg text-xs font-medium hover:bg-port-accent/80 disabled:opacity-50"
              >
                {logging ? <BrailleSpinner /> : <Plus size={12} />}
                Log
              </button>
            </form>
          </>
        )}
      </div>

      {/* Charts side by side */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <NicotineChart onRefreshKey={refreshKey} onViewChange={setChartView} />
        {correlationData && <NicotineHealthCorrelation data={correlationData} range={chartView} />}
      </div>

      {/* Entry History — table format */}
      {totalDays > 0 && (
        <div className="bg-port-card border border-port-border rounded-xl p-4">
          <h2 className="text-sm font-medium text-gray-400 uppercase tracking-wider mb-3">
            History ({pluralize(totalDays, 'day')})
          </h2>
          <div className="max-h-dvh-cap [--dvh-cap:70dvh] overflow-x-auto overflow-y-auto rounded-lg border border-port-border">
            <table className="w-full text-sm min-w-[500px]">
              <thead className="sticky top-0 bg-port-card z-10">
                <tr className="border-b border-port-border text-left text-xs text-gray-500 uppercase">
                  <th scope="col" className="px-3 py-2">Date</th>
                  <th scope="col" className="px-3 py-2">Product</th>
                  <th scope="col" className="px-3 py-2 text-right">mg/unit</th>
                  <th scope="col" className="px-3 py-2 text-right">Count</th>
                  <th scope="col" className="px-3 py-2 text-right">Total</th>
                  <th scope="col" className="px-3 py-2 text-right w-20">Actions</th>
                </tr>
              </thead>
              <tbody>
                {visibleEntries.map(entry =>
                  entry.nicotine?.items?.map((item, idx) => {
                    const key = `${entry.date}:${idx}`;
                    const isEditing = editingKey === key;
                    const itemTotal = Math.round(item.mgPerUnit * (item.count || 1) * 100) / 100;

                    return (
                      <tr
                        key={key}
                        className={`border-b border-port-border/50 hover:bg-port-border/20 ${
                          idx === 0 ? 'border-t border-port-border' : ''
                        }`}
                      >
                        <td className="px-3 py-1.5">
                          {isEditing ? (
                            <input
                              type="date"
                              value={editForm.date}
                              onChange={e => setEditForm({ ...editForm, date: e.target.value })}
                              aria-label="Entry date"
                              className="bg-port-bg border border-port-border rounded px-2 py-1 text-xs text-white"
                            />
                          ) : idx === 0 ? (
                            <div>
                              <span className="text-gray-500 text-xs w-7 inline-block">{dayOfWeek(entry.date)}</span>
                              <span className="text-gray-300 font-medium">{entry.date}</span>
                              <span className="ml-2 text-xs font-bold text-port-accent">
                                ({entry.nicotine.totalMg}mg)
                              </span>
                            </div>
                          ) : (
                            <span className="sr-only">{entry.date}</span>
                          )}
                        </td>
                        {isEditing ? (
                          <>
                            <td className="px-3 py-1.5">
                              <input
                                type="text"
                                value={editForm.product}
                                onChange={e => setEditForm({ ...editForm, product: e.target.value })}
                                aria-label="Entry product"
                                className="w-full px-2 py-1 bg-port-bg border border-port-border rounded text-xs text-white"
                              />
                            </td>
                            <td className="px-3 py-1.5">
                              <input
                                type="number"
                                value={editForm.mgPerUnit}
                                onChange={e => setEditForm({ ...editForm, mgPerUnit: e.target.value })}
                                aria-label="Entry milligrams per unit"
                                className="w-16 px-2 py-1 bg-port-bg border border-port-border rounded text-xs text-white text-right"
                                step="0.1"
                              />
                            </td>
                            <td className="px-3 py-1.5">
                              <input
                                type="number"
                                value={editForm.count}
                                onChange={e => setEditForm({ ...editForm, count: e.target.value })}
                                aria-label="Entry count"
                                className="w-14 px-2 py-1 bg-port-bg border border-port-border rounded text-xs text-white text-right"
                                min="1"
                              />
                            </td>
                            <td className="px-3 py-1.5 text-right text-gray-500 text-xs">
                              {Math.round(parseFloat(editForm.mgPerUnit || 0) * (parseInt(editForm.count, 10) || 1) * 100) / 100}mg
                            </td>
                            <td className="px-3 py-1.5 text-right">
                              <div className="flex items-center justify-end gap-2">
                                <button aria-label="Save" onClick={saveEdit} className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center p-1 text-port-success hover:text-port-success/80"><Check size={14} /></button>
                                <button aria-label="Cancel" onClick={cancelEdit} className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center p-1 text-gray-500 hover:text-gray-300"><X size={14} /></button>
                              </div>
                            </td>
                          </>
                        ) : (
                          <>
                            <td className="px-3 py-1.5 text-gray-400">{item.product || 'Unnamed'}</td>
                            <td className="px-3 py-1.5 text-right text-gray-300">{item.mgPerUnit}</td>
                            <td className="px-3 py-1.5 text-right text-gray-300">{item.count > 1 ? item.count : 1}</td>
                            <td className="px-3 py-1.5 text-right text-white font-medium">{itemTotal}mg</td>
                            <td className="px-3 py-1.5 text-right">
                              <div className="flex items-center justify-end gap-2">
                                <button aria-label={`Edit ${item.product || 'product'} entry for ${entry.date}`} onClick={() => startEdit(entry.date, idx, item)} className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center p-1 text-gray-600 hover:text-port-accent"><Pencil size={12} /></button>
                                {isConfirming(key) ? (
                                  <ConfirmButtonPair
                                    prompt="Remove?"
                                    confirmText="Remove"
                                    confirmIcon={Trash2}
                                    ariaLabel={`Confirm remove nicotine entry ${item.product || ''}`}
                                    onConfirm={() => confirmDelete(() => handleRemove(entry.date, idx, item.id))}
                                    onCancel={cancelDelete}
                                  />
                                ) : (
                                  <button aria-label={`Delete ${item.product || 'product'} entry for ${entry.date}`} onClick={() => requestDelete(key)} className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center p-1 text-gray-600 hover:text-port-error"><Trash2 size={12} /></button>
                                )}
                              </div>
                            </td>
                          </>
                        )}
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
          {remainingDays > 0 && (
            <button
              onClick={loadMoreDays}
              className="mt-3 w-full py-2 text-sm text-port-accent hover:text-port-accent/80 border border-port-border rounded-lg hover:bg-port-border/20 transition-colors"
            >
              Load More ({pluralize(remainingDays, 'day')} remaining)
            </button>
          )}
        </div>
      )}
    </div>
  );
}
