import { useState, useEffect, useCallback, useMemo } from 'react';
import { Cigarette, Plus, Trash2, Pencil, Check, X, Settings } from 'lucide-react';
import toast from '../../ui/Toast';
import * as api from '../../../services/api';
import BrailleSpinner from '../../BrailleSpinner';
import NicotineChart from '../NicotineChart';
import NicotineHealthCorrelation from '../NicotineHealthCorrelation';
import { dayOfWeek, localDateStr } from '../constants';

const DAYS_PER_PAGE = 50;

export default function NicotineTab() {
  const [summary, setSummary] = useState(null);
  const [allEntries, setAllEntries] = useState(null);
  const [loading, setLoading] = useState(true);
  const [logging, setLogging] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [visibleDays, setVisibleDays] = useState(DAYS_PER_PAGE);

  // Custom product buttons
  const [productButtons, setProductButtons] = useState([]);
  const [managingButtons, setManagingButtons] = useState(false);
  const [editingButtonIdx, setEditingButtonIdx] = useState(null);
  const [buttonForm, setButtonForm] = useState({ name: '', mgPerUnit: '' });

  // Form state
  const today = useMemo(() => localDateStr(), []);
  const [product, setProduct] = useState('');
  const [mgPerUnit, setMgPerUnit] = useState('');
  const [count, setCount] = useState(1);
  const [date, setDate] = useState(today);
  // Inline edit state
  const [editingKey, setEditingKey] = useState(null);
  const [editForm, setEditForm] = useState({ product: '', mgPerUnit: '', count: 1 });

  // Correlation chart state
  const [chartView, setChartView] = useState('30d');
  const [correlationData, setCorrelationData] = useState(null);

  const fetchProductButtons = useCallback(async () => {
    const buttons = await api.getCustomNicotineProducts().catch(() => null);
    if (Array.isArray(buttons)) {
      setProductButtons(buttons);
    }
  }, []);

  const fetchData = useCallback(async () => {
    const [summaryData, entries] = await Promise.all([
      api.getNicotineSummary().catch(() => null),
      api.getDailyNicotine().catch(() => [])
    ]);
    setSummary(summaryData);
    setAllEntries(entries);
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchProductButtons();
  }, [fetchProductButtons]);

  useEffect(() => {
    fetchData();
  }, [fetchData, refreshKey]);

  // Fetch correlation data — memoize date range to avoid refetch on every render
  const { correlationFrom, correlationTo } = useMemo(() => {
    const days = { '7d': 7, '30d': 30, '90d': 90 }[chartView] || 30;
    const d = new Date();
    d.setDate(d.getDate() - days);
    return { correlationFrom: localDateStr(d), correlationTo: localDateStr() };
  }, [chartView]);

  useEffect(() => {
    api.getAppleHealthCorrelation(correlationFrom, correlationTo)
      .then(setCorrelationData)
      .catch(() => setCorrelationData(null));
  }, [correlationFrom, correlationTo]);

  const handleQuickAdd = async (prod) => {
    setLogging(true);
    await api.logNicotine({
      product: prod.name,
      mgPerUnit: prod.mgPerUnit,
      count: 1,
      date: date || undefined
    }).catch(() => null);
    setLogging(false);
    setRefreshKey(k => k + 1);
  };

  const handleCustomAdd = async (e) => {
    e.preventDefault();
    if (!mgPerUnit) return;
    setLogging(true);
    await api.logNicotine({
      product: product || '',
      mgPerUnit: parseFloat(mgPerUnit),
      count: count || 1,
      date: date || undefined
    }).catch(() => null);
    setLogging(false);
    setProduct('');
    setMgPerUnit('');
    setCount(1);
    setRefreshKey(k => k + 1);
  };

  const handleRemove = async (entryDate, index) => {
    await api.removeNicotineEntry(entryDate, index).catch(() => null);
    setRefreshKey(k => k + 1);
  };

  const startEdit = (entryDate, index, item) => {
    setEditingKey(`${entryDate}:${index}`);
    setEditForm({
      product: item.product || '',
      mgPerUnit: String(item.mgPerUnit || ''),
      count: item.count || 1,
      date: entryDate
    });
  };

  const cancelEdit = () => {
    setEditingKey(null);
  };

  const saveEdit = async () => {
    if (!editingKey) return;
    const [entryDate, indexStr] = editingKey.split(':');
    const index = parseInt(indexStr, 10);
    await api.updateNicotineEntry(entryDate, index, {
      product: editForm.product,
      mgPerUnit: parseFloat(editForm.mgPerUnit),
      count: parseInt(editForm.count, 10) || 1,
      date: editForm.date !== entryDate ? editForm.date : undefined
    }).catch(() => null);
    setEditingKey(null);
    setRefreshKey(k => k + 1);
  };

  // === Custom product button management ===

  const validateProductButton = (form) => {
    if (!form.name) return 'Name is required';
    const parsed = parseFloat(form.mgPerUnit);
    if (isNaN(parsed) || parsed < 0.1 || parsed > 100) return 'mg must be between 0.1 and 100';
    return null;
  };

  const handleAddButton = async (e) => {
    e.preventDefault();
    const error = validateProductButton(buttonForm);
    if (error) { toast.error(error); return; }
    const result = await api.addCustomNicotineProduct({ name: buttonForm.name, mgPerUnit: parseFloat(buttonForm.mgPerUnit) }).catch(() => null);
    if (!result) { toast.error('Failed to add product button'); return; }
    setButtonForm({ name: '', mgPerUnit: '' });
    fetchProductButtons();
  };

  const startEditButton = (idx) => {
    const btn = productButtons[idx];
    setEditingButtonIdx(idx);
    setButtonForm({ name: btn.name, mgPerUnit: String(btn.mgPerUnit) });
  };

  const saveEditButton = async () => {
    if (editingButtonIdx === null) return;
    const error = validateProductButton(buttonForm);
    if (error) { toast.error(error); return; }
    const result = await api.updateCustomNicotineProduct(editingButtonIdx, { name: buttonForm.name, mgPerUnit: parseFloat(buttonForm.mgPerUnit) }).catch(() => null);
    if (!result) { toast.error('Failed to update product button'); return; }
    setEditingButtonIdx(null);
    setButtonForm({ name: '', mgPerUnit: '' });
    fetchProductButtons();
  };

  const cancelEditButton = () => {
    setEditingButtonIdx(null);
    setButtonForm({ name: '', mgPerUnit: '' });
  };

  const handleRemoveButton = async (idx) => {
    await api.removeCustomNicotineProduct(idx).catch(() => null);
    fetchProductButtons();
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <BrailleSpinner text="Loading" />
      </div>
    );
  }

  const visibleEntries = allEntries?.slice(0, visibleDays) || [];
  const hasMore = allEntries?.length > visibleDays;

  return (
    <div className="space-y-4">
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
          <h3 className="text-sm font-medium text-gray-400 uppercase tracking-wider">Log Nicotine</h3>
          <button
            onClick={() => setManagingButtons(!managingButtons)}
            className={`flex items-center gap-1 px-2 py-1 text-xs rounded-lg transition-colors ${
              managingButtons ? 'bg-port-accent/20 text-port-accent' : 'text-gray-500 hover:text-gray-300'
            }`}
            title="Manage product buttons"
          >
            <Settings size={14} />
            {managingButtons ? 'Done' : 'Manage'}
          </button>
        </div>

        {managingButtons ? (
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
                    />
                    <input
                      type="number"
                      value={buttonForm.mgPerUnit}
                      onChange={e => setButtonForm({ ...buttonForm, mgPerUnit: e.target.value })}
                      className="w-16 bg-port-bg border border-port-border rounded px-2 py-1.5 text-xs text-white"
                      placeholder="mg"
                      step="0.1"
                    />
                    <button onClick={saveEditButton} className="p-1.5 text-port-success hover:text-white"><Check size={14} /></button>
                    <button onClick={cancelEditButton} className="p-1.5 text-gray-500 hover:text-white"><X size={14} /></button>
                  </>
                ) : (
                  <>
                    <span className="flex-1 text-xs text-gray-300">{btn.name}</span>
                    <span className="text-xs text-gray-500">{btn.mgPerUnit}mg</span>
                    <button onClick={() => startEditButton(idx)} className="p-1.5 text-gray-600 hover:text-port-accent"><Pencil size={12} /></button>
                    <button onClick={() => handleRemoveButton(idx)} className="p-1.5 text-gray-600 hover:text-port-error"><Trash2 size={12} /></button>
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
                />
                <input
                  type="number"
                  value={buttonForm.mgPerUnit}
                  onChange={e => setButtonForm({ ...buttonForm, mgPerUnit: e.target.value })}
                  className="w-16 bg-port-bg border border-port-border rounded px-2 py-1.5 text-xs text-white placeholder-gray-600"
                  placeholder="mg"
                  step="0.1"
                />
                <button type="submit" className="px-3 py-1.5 bg-port-accent/10 text-port-accent rounded text-xs hover:bg-port-accent/20">
                  <Plus size={14} />
                </button>
              </form>
            )}
          </div>
        ) : (
          <>
            {/* Quick-add buttons */}
            <div className="flex flex-wrap gap-2 mb-3">
              {productButtons.map((btn, idx) => (
                <button
                  key={idx}
                  onClick={() => handleQuickAdd(btn)}
                  disabled={logging}
                  className="flex items-center gap-1 px-3 py-2 min-h-[40px] text-xs bg-port-border/50 text-gray-300 rounded-lg hover:bg-port-accent/10 hover:text-port-accent transition-colors disabled:opacity-50"
                >
                  <Plus size={12} />
                  {btn.name}
                </button>
              ))}
            </div>

            {/* Custom entry + date — single row */}
            <form onSubmit={handleCustomAdd} className="flex flex-wrap items-end gap-2 pt-2 border-t border-port-border/50">
              <div className="flex-1 min-w-[100px]">
                <label className="block text-xs text-gray-500 mb-1">Product</label>
                <input
                  type="text"
                  value={product}
                  onChange={e => setProduct(e.target.value)}
                  className="w-full bg-port-bg border border-port-border rounded px-2 py-1.5 text-xs text-white placeholder-gray-600"
                  placeholder="e.g. Stokes Pick"
                />
              </div>
              <div className="w-16">
                <label className="block text-xs text-gray-500 mb-1">mg</label>
                <input
                  type="number"
                  value={mgPerUnit}
                  onChange={e => setMgPerUnit(e.target.value)}
                  className="w-full bg-port-bg border border-port-border rounded px-2 py-1.5 text-xs text-white placeholder-gray-600"
                  placeholder="5"
                  step="0.1"
                  min="0.1"
                  required
                />
              </div>
              <div className="w-14">
                <label className="block text-xs text-gray-500 mb-1">Qty</label>
                <input
                  type="number"
                  value={count}
                  onChange={e => setCount(parseInt(e.target.value, 10) || 1)}
                  className="w-full bg-port-bg border border-port-border rounded px-2 py-1.5 text-xs text-white"
                  min="1"
                />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Date</label>
                <input
                  type="date"
                  value={date}
                  onChange={e => setDate(e.target.value)}
                  className="bg-port-bg border border-port-border rounded px-2 py-1.5 text-xs text-white"
                />
              </div>
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
      {allEntries?.length > 0 && (
        <div className="bg-port-card border border-port-border rounded-xl p-4">
          <h3 className="text-sm font-medium text-gray-400 uppercase tracking-wider mb-3">
            History ({allEntries.length} days)
          </h3>
          <div className="max-h-[70vh] overflow-x-auto overflow-y-auto rounded-lg border border-port-border">
            <table className="w-full text-sm min-w-[500px]">
              <thead className="sticky top-0 bg-port-card z-10">
                <tr className="border-b border-port-border text-left text-xs text-gray-500 uppercase">
                  <th className="px-3 py-2">Date</th>
                  <th className="px-3 py-2">Product</th>
                  <th className="px-3 py-2 text-right">mg/unit</th>
                  <th className="px-3 py-2 text-right">Count</th>
                  <th className="px-3 py-2 text-right">Total</th>
                  <th className="px-3 py-2 text-right w-20">Actions</th>
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
                            <span className="text-gray-700">&nbsp;</span>
                          )}
                        </td>
                        {isEditing ? (
                          <>
                            <td className="px-3 py-1.5">
                              <input
                                type="text"
                                value={editForm.product}
                                onChange={e => setEditForm({ ...editForm, product: e.target.value })}
                                className="w-full px-2 py-1 bg-port-bg border border-port-border rounded text-xs text-white"
                              />
                            </td>
                            <td className="px-3 py-1.5">
                              <input
                                type="number"
                                value={editForm.mgPerUnit}
                                onChange={e => setEditForm({ ...editForm, mgPerUnit: e.target.value })}
                                className="w-16 px-2 py-1 bg-port-bg border border-port-border rounded text-xs text-white text-right"
                                step="0.1"
                              />
                            </td>
                            <td className="px-3 py-1.5">
                              <input
                                type="number"
                                value={editForm.count}
                                onChange={e => setEditForm({ ...editForm, count: e.target.value })}
                                className="w-14 px-2 py-1 bg-port-bg border border-port-border rounded text-xs text-white text-right"
                                min="1"
                              />
                            </td>
                            <td className="px-3 py-1.5 text-right text-gray-500 text-xs">
                              {Math.round(parseFloat(editForm.mgPerUnit || 0) * (parseInt(editForm.count, 10) || 1) * 100) / 100}mg
                            </td>
                            <td className="px-3 py-1.5 text-right">
                              <div className="flex items-center justify-end gap-1">
                                <button onClick={saveEdit} className="p-1 text-port-success hover:text-port-success/80"><Check size={14} /></button>
                                <button onClick={cancelEdit} className="p-1 text-gray-500 hover:text-gray-300"><X size={14} /></button>
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
                              <div className="flex items-center justify-end gap-1">
                                <button onClick={() => startEdit(entry.date, idx, item)} className="p-1 text-gray-600 hover:text-port-accent"><Pencil size={12} /></button>
                                <button onClick={() => handleRemove(entry.date, idx)} className="p-1 text-gray-600 hover:text-port-error"><Trash2 size={12} /></button>
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
          {hasMore && (
            <button
              onClick={() => setVisibleDays(v => v + DAYS_PER_PAGE)}
              className="mt-3 w-full py-2 text-sm text-port-accent hover:text-port-accent/80 border border-port-border rounded-lg hover:bg-port-border/20 transition-colors"
            >
              Load More ({allEntries.length - visibleDays} days remaining)
            </button>
          )}
        </div>
      )}
    </div>
  );
}
