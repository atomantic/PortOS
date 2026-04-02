import { useState, useEffect, useCallback, useMemo } from 'react';
import { Beer, Plus, Trash2, AlertTriangle, TrendingDown, TrendingUp, Pencil, Check, X, Settings } from 'lucide-react';
import toast from '../../ui/Toast';
import * as api from '../../../services/api';
import BrailleSpinner from '../../BrailleSpinner';
import AlcoholChart from '../AlcoholChart';
import AlcoholHrvCorrelation from '../AlcoholHrvCorrelation';
import StandardDrinkCalculator from '../StandardDrinkCalculator';
import { dayOfWeek, localDateStr } from '../constants';

const ML_PER_OZ = 29.5735;

const DEFAULT_DRINKS = [
  { name: 'Modelo Especial (12oz)', oz: 12, abv: 4.4 },
  { name: 'Nitro Guinness (14.9oz)', oz: 14.9, abv: 4.2 },
  { name: 'Old Fashioned (2oz)', oz: 2, abv: 40 },
  { name: 'Guinness 0 (14.9oz)', oz: 14.9, abv: 0.4 },
  { name: 'N/A Beer (12oz)', oz: 12, abv: 0.4 }
];

const toOz = (value, unit) => unit === 'ml' ? value / ML_PER_OZ : value;

const RISK_COLORS = {
  low: 'text-port-success',
  moderate: 'text-port-warning',
  high: 'text-port-error'
};

const RISK_BG = {
  low: 'bg-port-success/10 border-port-success/30',
  moderate: 'bg-port-warning/10 border-port-warning/30',
  high: 'bg-port-error/10 border-port-error/30'
};

const DAYS_PER_PAGE = 50;

function computeStdDrinks(oz, abv, count) {
  const pureOz = (oz || 0) * (count || 1) * ((abv || 0) / 100);
  return Math.round((pureOz / 0.6) * 100) / 100;
}

export default function AlcoholTab() {
  const [summary, setSummary] = useState(null);
  const [allEntries, setAllEntries] = useState(null);
  const [loading, setLoading] = useState(true);
  const [logging, setLogging] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [visibleDays, setVisibleDays] = useState(DAYS_PER_PAGE);

  // Custom drink buttons
  const [drinkButtons, setDrinkButtons] = useState(DEFAULT_DRINKS);
  const [managingButtons, setManagingButtons] = useState(false);
  const [editingButtonIdx, setEditingButtonIdx] = useState(null);
  const [buttonForm, setButtonForm] = useState({ name: '', oz: '', abv: '' });
  const [buttonVolumeUnit, setButtonVolumeUnit] = useState('oz');

  // Form state
  const [name, setName] = useState('');
  const [oz, setOz] = useState('');
  const [abv, setAbv] = useState('');
  const [count, setCount] = useState(1);
  const [date, setDate] = useState(localDateStr());
  const [volumeUnit, setVolumeUnit] = useState('oz');

  // Inline edit state
  const [editingKey, setEditingKey] = useState(null); // "date:index"
  const [editForm, setEditForm] = useState({ name: '', oz: '', abv: '', count: 1 });
  const [editVolumeUnit, setEditVolumeUnit] = useState('oz');

  // Correlation chart state
  const [chartView, setChartView] = useState('30d');
  const [correlationData, setCorrelationData] = useState(null);

  const fetchDrinkButtons = useCallback(async () => {
    const buttons = await api.getCustomDrinks().catch(() => null);
    if (Array.isArray(buttons)) {
      setDrinkButtons(buttons);
    } else {
      setDrinkButtons(DEFAULT_DRINKS);
    }
  }, []);

  const fetchData = useCallback(async () => {
    const [summaryData, entries] = await Promise.all([
      api.getAlcoholSummary().catch(() => null),
      api.getDailyAlcohol().catch(() => [])
    ]);
    setSummary(summaryData);
    setAllEntries(entries);
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchDrinkButtons();
  }, [fetchDrinkButtons]);

  useEffect(() => {
    fetchData();
  }, [fetchData, refreshKey]);

  // Fetch correlation data for HRV chart
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

  const handleQuickAdd = async (drink) => {
    setLogging(true);
    await api.logAlcoholDrink({
      name: drink.name,
      oz: drink.oz,
      abv: drink.abv,
      count: 1,
      date: date || undefined
    }).catch(() => null);
    setLogging(false);
    setRefreshKey(k => k + 1);
  };

  const handleCustomAdd = async (e) => {
    e.preventDefault();
    if (!oz || !abv) return;
    setLogging(true);
    await api.logAlcoholDrink({
      name: name || '',
      oz: Math.round(toOz(parseFloat(oz), volumeUnit) * 100) / 100,
      abv: parseFloat(abv),
      count: count || 1,
      date: date || undefined
    }).catch(() => null);
    setLogging(false);
    setName('');
    setOz('');
    setAbv('');
    setCount(1);
    setRefreshKey(k => k + 1);
  };

  const handleRemove = async (entryDate, index) => {
    await api.removeAlcoholDrink(entryDate, index).catch(() => null);
    setRefreshKey(k => k + 1);
  };

  const startEdit = (entryDate, index, drink) => {
    setEditingKey(`${entryDate}:${index}`);
    setEditVolumeUnit('oz');
    setEditForm({
      name: drink.name || '',
      oz: String(drink.oz || ''),
      abv: String(drink.abv || ''),
      count: drink.count || 1,
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
    await api.updateAlcoholDrink(entryDate, index, {
      name: editForm.name,
      oz: Math.round(toOz(parseFloat(editForm.oz), editVolumeUnit) * 100) / 100,
      abv: parseFloat(editForm.abv),
      count: parseInt(editForm.count, 10) || 1,
      date: editForm.date !== entryDate ? editForm.date : undefined
    }).catch(() => null);
    setEditingKey(null);
    setRefreshKey(k => k + 1);
  };

  // === Custom drink button management ===

  const validateDrinkButton = (form) => {
    const parsedVol = parseFloat(form.oz);
    const parsedAbv = parseFloat(form.abv);
    if (!form.name) return 'Name is required';
    const maxVol = buttonVolumeUnit === 'ml' ? Math.round(1000 * ML_PER_OZ) : 1000;
    if (isNaN(parsedVol) || parsedVol < 0.1 || parsedVol > maxVol) return `Volume must be between 0.1 and ${maxVol} ${buttonVolumeUnit}`;
    if (isNaN(parsedAbv) || parsedAbv < 0 || parsedAbv > 100) return 'ABV must be between 0 and 100';
    return null;
  };

  const handleAddButton = async (e) => {
    e.preventDefault();
    const error = validateDrinkButton(buttonForm);
    if (error) { toast.error(error); return; }
    const parsedOz = Math.round(toOz(parseFloat(buttonForm.oz), buttonVolumeUnit) * 100) / 100;
    const parsedAbv = parseFloat(buttonForm.abv);
    const result = await api.addCustomDrink({ name: buttonForm.name, oz: parsedOz, abv: parsedAbv }).catch(() => null);
    if (!result) { toast.error('Failed to add drink button'); return; }
    setButtonForm({ name: '', oz: '', abv: '' });
    setButtonVolumeUnit('oz');
    fetchDrinkButtons();
  };

  const startEditButton = (idx) => {
    const btn = drinkButtons[idx];
    setEditingButtonIdx(idx);
    setButtonVolumeUnit('oz');
    setButtonForm({ name: btn.name, oz: String(btn.oz), abv: String(btn.abv) });
  };

  const saveEditButton = async () => {
    if (editingButtonIdx === null) return;
    const error = validateDrinkButton(buttonForm);
    if (error) { toast.error(error); return; }
    const parsedOz = Math.round(toOz(parseFloat(buttonForm.oz), buttonVolumeUnit) * 100) / 100;
    const parsedAbv = parseFloat(buttonForm.abv);
    const result = await api.updateCustomDrink(editingButtonIdx, { name: buttonForm.name, oz: parsedOz, abv: parsedAbv }).catch(() => null);
    if (!result) { toast.error('Failed to update drink button'); return; }
    setEditingButtonIdx(null);
    setButtonForm({ name: '', oz: '', abv: '' });
    setButtonVolumeUnit('oz');
    fetchDrinkButtons();
  };

  const cancelEditButton = () => {
    setEditingButtonIdx(null);
    setButtonForm({ name: '', oz: '', abv: '' });
    setButtonVolumeUnit('oz');
  };

  const handleRemoveButton = async (idx) => {
    await api.removeCustomDrink(idx).catch(() => null);
    fetchDrinkButtons();
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
        <div className="flex flex-wrap items-center gap-x-5 gap-y-1 px-4 py-2 bg-port-card border border-port-border rounded-lg">
          <div className="flex items-center gap-1.5">
            <Beer size={14} className="text-port-accent" />
            <span className="text-xs text-gray-500">Today</span>
            <span className={`text-sm font-bold ${summary.grams?.today > 40 ? 'text-port-error' : summary.grams?.today > 10 ? 'text-port-warning' : 'text-white'}`}>
              {summary.grams?.today ?? 0}g
            </span>
            <span className="text-xs text-gray-600">({summary.today} drinks)</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-gray-500">7d</span>
            <span className={`text-sm font-semibold ${summary.grams?.avg7day > 40 ? 'text-port-error' : summary.grams?.avg7day > 10 ? 'text-port-warning' : 'text-gray-300'}`}>
              {summary.grams?.avg7day ?? 0}g/d
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-gray-500">30d</span>
            <span className={`text-sm font-semibold ${summary.grams?.avg30day > 40 ? 'text-port-error' : summary.grams?.avg30day > 10 ? 'text-port-warning' : 'text-gray-300'}`}>
              {summary.grams?.avg30day ?? 0}g/d
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-gray-500">Week</span>
            <span className={`text-sm font-semibold ${summary.weeklyTotal > summary.thresholds?.weeklyMax ? 'text-port-error' : 'text-gray-300'}`}>
              {summary.grams?.weeklyTotal ?? 0}g
            </span>
            <span className="text-xs text-gray-600">/ {summary.gramThresholds?.weeklyMax ?? 196}g</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-gray-500">All-time</span>
            <span className={`text-sm font-semibold ${summary.grams?.allTimeAvg > 40 ? 'text-port-error' : summary.grams?.allTimeAvg > 10 ? 'text-port-warning' : 'text-gray-400'}`}>
              {summary.grams?.allTimeAvg ?? 0}g/d
            </span>
          </div>
          <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border ${RISK_BG[summary.riskLevel]}`}>
            {summary.riskLevel === 'high' && <AlertTriangle size={10} />}
            {summary.riskLevel === 'low' && <TrendingDown size={10} />}
            {summary.riskLevel === 'moderate' && <TrendingUp size={10} />}
            <span className={RISK_COLORS[summary.riskLevel]}>
              {summary.riskLevel === 'low' ? 'Low' : summary.riskLevel === 'moderate' ? 'Moderate' : 'High'}
            </span>
          </span>
        </div>
      )}

      {/* Consumption + HRV Correlation Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <AlcoholChart sex={summary?.sex} onRefreshKey={refreshKey} onViewChange={setChartView} />
        {correlationData && <AlcoholHrvCorrelation data={correlationData} range={chartView} />}
      </div>

      {/* Log a Drink */}
      <div className="bg-port-card border border-port-border rounded-xl p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-medium text-gray-400 uppercase tracking-wider">Log a Drink</h3>
          <button
            onClick={() => setManagingButtons(v => !v)}
            className={`flex items-center gap-1 px-2 py-1 text-xs rounded-lg transition-colors ${
              managingButtons ? 'bg-port-accent/20 text-port-accent' : 'text-gray-500 hover:text-gray-300'
            }`}
            title="Manage quick-add buttons"
          >
            <Settings size={14} />
            {managingButtons ? 'Done' : 'Manage'}
          </button>
        </div>

        {/* Quick-add buttons */}
        {!managingButtons && (
          <div className="flex flex-wrap gap-2 mb-4">
            {drinkButtons.map((drink, idx) => (
              <button
                key={`${drink.name}-${idx}`}
                onClick={() => handleQuickAdd(drink)}
                disabled={logging}
                className="flex items-center gap-1 px-3 py-2 min-h-[40px] text-xs bg-port-border/50 text-gray-300 rounded-lg hover:bg-port-accent/10 hover:text-port-accent transition-colors disabled:opacity-50"
              >
                <Plus size={12} />
                {drink.name}
              </button>
            ))}
          </div>
        )}

        {/* Manage quick-add buttons */}
        {managingButtons && (
          <div className="mb-4 space-y-2">
            {drinkButtons.map((drink, idx) => (
              <div key={`manage-${idx}`} className="flex items-center gap-2">
                {editingButtonIdx === idx ? (
                  <>
                    <input
                      type="text"
                      value={buttonForm.name}
                      onChange={e => setButtonForm(f => ({ ...f, name: e.target.value }))}
                      placeholder="Name"
                      className="flex-1 px-2 py-1.5 bg-port-bg border border-port-border rounded-lg text-xs text-white"
                    />
                    <input
                      type="number"
                      step="0.1"
                      min="0.1"
                      value={buttonForm.oz}
                      onChange={e => setButtonForm(f => ({ ...f, oz: e.target.value }))}
                      placeholder={buttonVolumeUnit === 'oz' ? 'Oz' : 'mL'}
                      className="w-16 px-2 py-1.5 bg-port-bg border border-port-border rounded-lg text-xs text-white text-right"
                    />
                    <button
                      type="button"
                      onClick={() => setButtonVolumeUnit(u => u === 'oz' ? 'ml' : 'oz')}
                      className="px-1.5 py-1 text-[10px] font-medium rounded bg-port-border/50 text-gray-400 hover:text-port-accent hover:bg-port-accent/10 transition-colors"
                    >
                      {buttonVolumeUnit}
                    </button>
                    <input
                      type="number"
                      step="0.1"
                      min="0"
                      max="100"
                      value={buttonForm.abv}
                      onChange={e => setButtonForm(f => ({ ...f, abv: e.target.value }))}
                      placeholder="ABV%"
                      className="w-16 px-2 py-1.5 bg-port-bg border border-port-border rounded-lg text-xs text-white text-right"
                    />
                    <button onClick={saveEditButton} className="p-1.5 text-port-success hover:text-port-success/80" title="Save">
                      <Check size={14} />
                    </button>
                    <button onClick={cancelEditButton} className="p-1.5 text-gray-500 hover:text-gray-300" title="Cancel">
                      <X size={14} />
                    </button>
                  </>
                ) : (
                  <>
                    <span className="flex-1 text-xs text-gray-300">{drink.name}</span>
                    <span className="text-xs text-gray-500">{drink.oz}oz</span>
                    <span className="text-xs text-gray-500">{drink.abv}%</span>
                    <button onClick={() => startEditButton(idx)} className="p-1.5 text-gray-600 hover:text-port-accent" title="Edit">
                      <Pencil size={12} />
                    </button>
                    <button onClick={() => handleRemoveButton(idx)} className="p-1.5 text-gray-600 hover:text-port-error" title="Remove">
                      <Trash2 size={12} />
                    </button>
                  </>
                )}
              </div>
            ))}
            {editingButtonIdx === null && (
              <form onSubmit={handleAddButton} className="flex items-center gap-2 pt-2 border-t border-port-border/50">
                <input
                  type="text"
                  value={buttonForm.name}
                  onChange={e => setButtonForm(f => ({ ...f, name: e.target.value }))}
                  placeholder="New button name"
                  className="flex-1 px-2 py-1.5 bg-port-bg border border-port-border rounded-lg text-xs text-white placeholder-gray-600"
                />
                <input
                  type="number"
                  step="0.1"
                  min="0.1"
                  value={buttonForm.oz}
                  onChange={e => setButtonForm(f => ({ ...f, oz: e.target.value }))}
                  placeholder={buttonVolumeUnit === 'oz' ? 'Oz' : 'mL'}
                  className="w-16 px-2 py-1.5 bg-port-bg border border-port-border rounded-lg text-xs text-white text-right placeholder-gray-600"
                />
                <button
                  type="button"
                  onClick={() => setButtonVolumeUnit(u => u === 'oz' ? 'ml' : 'oz')}
                  className="px-1.5 py-1 text-[10px] font-medium rounded bg-port-border/50 text-gray-400 hover:text-port-accent hover:bg-port-accent/10 transition-colors"
                >
                  {buttonVolumeUnit}
                </button>
                <input
                  type="number"
                  step="0.1"
                  min="0"
                  max="100"
                  value={buttonForm.abv}
                  onChange={e => setButtonForm(f => ({ ...f, abv: e.target.value }))}
                  placeholder="ABV%"
                  className="w-16 px-2 py-1.5 bg-port-bg border border-port-border rounded-lg text-xs text-white text-right placeholder-gray-600"
                />
                <button
                  type="submit"
                  disabled={!buttonForm.name || !buttonForm.oz || buttonForm.abv === '' || isNaN(parseFloat(buttonForm.abv))}
                  className="flex items-center gap-1 px-2 py-1.5 text-xs bg-port-accent text-white rounded-lg hover:bg-port-accent/80 disabled:opacity-50"
                >
                  <Plus size={12} />
                  Add
                </button>
              </form>
            )}
          </div>
        )}

        {/* Custom entry form */}
        <form onSubmit={handleCustomAdd} className="grid grid-cols-2 sm:grid-cols-[1fr_5rem_5rem_4rem_9rem_auto] items-end gap-3">
          <div className="col-span-2 sm:col-span-1">
            <label className="text-xs text-gray-500 block mb-1">Name (optional)</label>
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="e.g., Hazy IPA"
              className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-sm text-white placeholder-gray-600"
            />
          </div>
          <div>
            <div className="flex items-center gap-1.5 mb-1">
              <label className="text-xs text-gray-500">Volume</label>
              <button
                type="button"
                onClick={() => setVolumeUnit(u => u === 'oz' ? 'ml' : 'oz')}
                className="px-1.5 py-0.5 text-[10px] font-medium rounded bg-port-border/50 text-gray-400 hover:text-port-accent hover:bg-port-accent/10 transition-colors"
              >
                {volumeUnit}
              </button>
            </div>
            <input
              type="number"
              step="0.1"
              min="0.1"
              value={oz}
              onChange={e => setOz(e.target.value)}
              required
              placeholder={volumeUnit === 'oz' ? '12' : '355'}
              className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-sm text-white placeholder-gray-600"
            />
          </div>
          <div>
            <label className="text-xs text-gray-500 block mb-1">ABV %</label>
            <input
              type="number"
              step="0.1"
              min="0"
              max="100"
              value={abv}
              onChange={e => setAbv(e.target.value)}
              required
              placeholder="5"
              className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-sm text-white placeholder-gray-600"
            />
          </div>
          <div>
            <label className="text-xs text-gray-500 block mb-1">Count</label>
            <input
              type="number"
              min="1"
              max="20"
              value={count}
              onChange={e => setCount(parseInt(e.target.value) || 1)}
              className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-sm text-white"
            />
          </div>
          <div>
            <label className="text-xs text-gray-500 block mb-1">Date</label>
            <input
              type="date"
              value={date}
              onChange={e => setDate(e.target.value)}
              className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-sm text-white"
            />
          </div>
          <button
            type="submit"
            disabled={logging || !oz || !abv}
            className="col-span-2 sm:col-span-1 flex items-center justify-center gap-2 px-4 py-2 min-h-[40px] bg-port-accent text-white rounded-lg hover:bg-port-accent/80 disabled:opacity-50 transition-colors"
          >
            {logging ? <BrailleSpinner /> : <Plus size={16} />}
            Log
          </button>
        </form>
      </div>

      {/* All Drink Entries */}
      {allEntries?.length > 0 && (
        <div className="bg-port-card border border-port-border rounded-xl p-4">
          <h3 className="text-sm font-medium text-gray-400 uppercase tracking-wider mb-3">
            All Drink Entries ({allEntries.length} days)
          </h3>
          <div className="max-h-[70vh] overflow-x-auto overflow-y-auto rounded-lg border border-port-border">
            <table className="w-full text-sm min-w-[600px]">
              <thead className="sticky top-0 bg-port-card z-10">
                <tr className="border-b border-port-border text-left text-xs text-gray-500 uppercase">
                  <th className="px-3 py-2">Date</th>
                  <th className="px-3 py-2">Name</th>
                  <th className="px-3 py-2 text-right">Oz</th>
                  <th className="px-3 py-2 text-right">ABV%</th>
                  <th className="px-3 py-2 text-right">Count</th>
                  <th className="px-3 py-2 text-right">Std Drinks</th>
                  <th className="px-3 py-2 text-right w-20">Actions</th>
                </tr>
              </thead>
              <tbody>
                {visibleEntries.map(entry => {
                  const drinks = entry.alcohol?.drinks || [];
                  return drinks.map((drink, idx) => {
                    const key = `${entry.date}:${idx}`;
                    const isEditing = editingKey === key;
                    const stdDrinks = computeStdDrinks(drink.oz, drink.abv, drink.count);
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
                              onChange={e => setEditForm(f => ({ ...f, date: e.target.value }))}
                              className="bg-port-bg border border-port-border rounded px-2 py-1 text-xs text-white"
                            />
                          ) : idx === 0 ? (
                            <div>
                              <span className="text-gray-500 text-xs w-7 inline-block">{dayOfWeek(entry.date)}</span>
                              <span className="text-gray-300 font-medium">{entry.date}</span>
                              <span className={`ml-2 text-xs font-bold ${
                                entry.alcohol.standardDrinks > (summary?.thresholds?.dailyMax || 2) ? 'text-port-error' : 'text-port-accent'
                              }`}>
                                ({entry.alcohol.standardDrinks} total)
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
                                value={editForm.name}
                                onChange={e => setEditForm(f => ({ ...f, name: e.target.value }))}
                                className="w-full px-2 py-1 bg-port-bg border border-port-border rounded text-xs text-white"
                              />
                            </td>
                            <td className="px-3 py-1.5">
                              <div className="flex items-center gap-1">
                                <input
                                  type="number"
                                  step="0.1"
                                  min="0.1"
                                  value={editForm.oz}
                                  onChange={e => setEditForm(f => ({ ...f, oz: e.target.value }))}
                                  className="w-16 px-2 py-1 bg-port-bg border border-port-border rounded text-xs text-white text-right"
                                />
                                <button
                                  type="button"
                                  onClick={() => setEditVolumeUnit(u => u === 'oz' ? 'ml' : 'oz')}
                                  className="px-1 py-0.5 text-[10px] font-medium rounded bg-port-border/50 text-gray-400 hover:text-port-accent hover:bg-port-accent/10 transition-colors"
                                >
                                  {editVolumeUnit}
                                </button>
                              </div>
                            </td>
                            <td className="px-3 py-1.5">
                              <input
                                type="number"
                                step="0.1"
                                min="0"
                                max="100"
                                value={editForm.abv}
                                onChange={e => setEditForm(f => ({ ...f, abv: e.target.value }))}
                                className="w-16 px-2 py-1 bg-port-bg border border-port-border rounded text-xs text-white text-right"
                              />
                            </td>
                            <td className="px-3 py-1.5">
                              <input
                                type="number"
                                min="1"
                                max="100"
                                value={editForm.count}
                                onChange={e => setEditForm(f => ({ ...f, count: e.target.value }))}
                                className="w-14 px-2 py-1 bg-port-bg border border-port-border rounded text-xs text-white text-right"
                              />
                            </td>
                            <td className="px-3 py-1.5 text-right text-gray-500 text-xs">
                              {computeStdDrinks(toOz(parseFloat(editForm.oz), editVolumeUnit), parseFloat(editForm.abv), parseInt(editForm.count) || 1)}
                            </td>
                            <td className="px-3 py-1.5 text-right">
                              <div className="flex items-center justify-end gap-1">
                                <button
                                  onClick={saveEdit}
                                  className="p-1 text-port-success hover:text-port-success/80 transition-colors"
                                  title="Save"
                                >
                                  <Check size={14} />
                                </button>
                                <button
                                  onClick={cancelEdit}
                                  className="p-1 text-gray-500 hover:text-gray-300 transition-colors"
                                  title="Cancel"
                                >
                                  <X size={14} />
                                </button>
                              </div>
                            </td>
                          </>
                        ) : (
                          <>
                            <td className="px-3 py-1.5 text-gray-400">{drink.name || 'Unnamed'}</td>
                            <td className="px-3 py-1.5 text-right text-gray-300">{drink.oz}</td>
                            <td className="px-3 py-1.5 text-right text-gray-300">{drink.abv}%</td>
                            <td className="px-3 py-1.5 text-right text-gray-300">{drink.count > 1 ? drink.count : 1}</td>
                            <td className="px-3 py-1.5 text-right text-gray-400">{stdDrinks}</td>
                            <td className="px-3 py-1.5 text-right">
                              <div className="flex items-center justify-end gap-1">
                                <button
                                  onClick={() => startEdit(entry.date, idx, drink)}
                                  className="p-1 text-gray-600 hover:text-port-accent transition-colors"
                                  title="Edit drink"
                                >
                                  <Pencil size={12} />
                                </button>
                                <button
                                  onClick={() => handleRemove(entry.date, idx)}
                                  className="p-1 text-gray-600 hover:text-port-error transition-colors"
                                  title="Remove drink"
                                >
                                  <Trash2 size={12} />
                                </button>
                              </div>
                            </td>
                          </>
                        )}
                      </tr>
                    );
                  });
                })}
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

      {/* Standard Drink Calculator */}
      <StandardDrinkCalculator />
    </div>
  );
}
