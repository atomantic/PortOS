import { useState, useEffect, useCallback } from 'react';
import { Beer, Plus, Trash2, AlertTriangle, TrendingDown, TrendingUp, Pencil, Check, X } from 'lucide-react';
import * as api from '../../../services/api';
import BrailleSpinner from '../../BrailleSpinner';
import AlcoholChart from '../AlcoholChart';
import StandardDrinkCalculator from '../StandardDrinkCalculator';

const COMMON_DRINKS = [
  { name: 'Beer (12oz)', oz: 12, abv: 5 },
  { name: 'IPA (16oz)', oz: 16, abv: 6.5 },
  { name: 'Wine (5oz)', oz: 5, abv: 12 },
  { name: 'Spirit (1.5oz)', oz: 1.5, abv: 40 },
  { name: 'Cocktail (6oz)', oz: 6, abv: 15 },
  { name: 'Hard Seltzer (12oz)', oz: 12, abv: 5 },
  { name: 'Guinness (14.9oz)', oz: 14.9, abv: 4.2 }
];

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

  // Form state
  const [name, setName] = useState('');
  const [oz, setOz] = useState('');
  const [abv, setAbv] = useState('');
  const [count, setCount] = useState(1);
  const [date, setDate] = useState('');

  // Inline edit state
  const [editingKey, setEditingKey] = useState(null); // "date:index"
  const [editForm, setEditForm] = useState({ name: '', oz: '', abv: '', count: 1 });

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
    fetchData();
  }, [fetchData, refreshKey]);

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
      oz: parseFloat(oz),
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
    setEditForm({
      name: drink.name || '',
      oz: String(drink.oz || ''),
      abv: String(drink.abv || ''),
      count: drink.count || 1
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
      oz: parseFloat(editForm.oz),
      abv: parseFloat(editForm.abv),
      count: parseInt(editForm.count, 10) || 1
    }).catch(() => null);
    setEditingKey(null);
    setRefreshKey(k => k + 1);
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
    <div className="space-y-6">
      {/* Rolling Averages Summary */}
      {summary && (
        <div className="bg-port-card border border-port-border rounded-xl p-6">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <Beer size={18} className="text-port-accent" />
              <h3 className="text-sm font-medium text-gray-400 uppercase tracking-wider">
                Alcohol Summary
              </h3>
            </div>
            <span className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium border ${RISK_BG[summary.riskLevel]}`}>
              {summary.riskLevel === 'high' && <AlertTriangle size={12} />}
              {summary.riskLevel === 'low' && <TrendingDown size={12} />}
              {summary.riskLevel === 'moderate' && <TrendingUp size={12} />}
              <span className={RISK_COLORS[summary.riskLevel]}>
                {summary.riskLevel === 'low' ? 'Low Risk' : summary.riskLevel === 'moderate' ? 'Moderate Risk' : 'High Risk'}
              </span>
            </span>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
            <div>
              <span className="text-xs text-gray-500">Today</span>
              <p className={`text-2xl font-bold ${summary.today > summary.thresholds.dailyMax ? 'text-port-error' : 'text-white'}`}>
                {summary.today}
              </p>
              <span className="text-xs text-gray-600">/ {summary.thresholds.dailyMax} max</span>
            </div>
            <div>
              <span className="text-xs text-gray-500">7-Day Avg</span>
              <p className="text-2xl font-bold text-white">{summary.avg7day}</p>
              <span className="text-xs text-gray-600">per day</span>
            </div>
            <div>
              <span className="text-xs text-gray-500">30-Day Avg</span>
              <p className="text-2xl font-bold text-white">{summary.avg30day}</p>
              <span className="text-xs text-gray-600">per day</span>
            </div>
            <div>
              <span className="text-xs text-gray-500">Weekly Total</span>
              <p className={`text-2xl font-bold ${summary.weeklyTotal > summary.thresholds.weeklyMax ? 'text-port-error' : 'text-white'}`}>
                {summary.weeklyTotal}
              </p>
              <span className="text-xs text-gray-600">/ {summary.thresholds.weeklyMax} max</span>
            </div>
            <div>
              <span className="text-xs text-gray-500">All-Time Avg</span>
              <p className="text-2xl font-bold text-gray-300">{summary.allTimeAvg}</p>
              <span className="text-xs text-gray-600">per day</span>
            </div>
          </div>
        </div>
      )}

      {/* Consumption Chart */}
      <AlcoholChart sex={summary?.sex} onRefreshKey={refreshKey} />

      {/* Log a Drink */}
      <div className="bg-port-card border border-port-border rounded-xl p-6">
        <h3 className="text-sm font-medium text-gray-400 uppercase tracking-wider mb-4">Log a Drink</h3>

        {/* Quick-add buttons */}
        <div className="flex flex-wrap gap-2 mb-4">
          {COMMON_DRINKS.map(drink => (
            <button
              key={drink.name}
              onClick={() => handleQuickAdd(drink)}
              disabled={logging}
              className="flex items-center gap-1 px-3 py-1.5 text-xs bg-port-border/50 text-gray-300 rounded-lg hover:bg-port-accent/10 hover:text-port-accent transition-colors disabled:opacity-50"
            >
              <Plus size={12} />
              {drink.name}
            </button>
          ))}
        </div>

        {/* Custom entry form */}
        <form onSubmit={handleCustomAdd} className="flex flex-wrap items-end gap-3">
          <div className="flex-1 min-w-[120px]">
            <label className="text-xs text-gray-500 block mb-1">Name (optional)</label>
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="e.g., Hazy IPA"
              className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-sm text-white placeholder-gray-600"
            />
          </div>
          <div className="w-20">
            <label className="text-xs text-gray-500 block mb-1">Oz</label>
            <input
              type="number"
              step="0.1"
              min="0.1"
              value={oz}
              onChange={e => setOz(e.target.value)}
              required
              placeholder="12"
              className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-sm text-white placeholder-gray-600"
            />
          </div>
          <div className="w-20">
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
          <div className="w-16">
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
          <div className="w-36">
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
            className="flex items-center gap-2 px-4 py-2 bg-port-accent text-white rounded-lg hover:bg-port-accent/80 disabled:opacity-50 transition-colors"
          >
            {logging ? <BrailleSpinner /> : <Plus size={16} />}
            Log
          </button>
        </form>
      </div>

      {/* All Drink Entries */}
      {allEntries?.length > 0 && (
        <div className="bg-port-card border border-port-border rounded-xl p-6">
          <h3 className="text-sm font-medium text-gray-400 uppercase tracking-wider mb-4">
            All Drink Entries ({allEntries.length} days)
          </h3>
          <div className="max-h-[70vh] overflow-y-auto rounded-lg border border-port-border">
            <table className="w-full text-sm">
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
                          {idx === 0 ? (
                            <div>
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
                              <input
                                type="number"
                                step="0.1"
                                min="0.1"
                                value={editForm.oz}
                                onChange={e => setEditForm(f => ({ ...f, oz: e.target.value }))}
                                className="w-16 px-2 py-1 bg-port-bg border border-port-border rounded text-xs text-white text-right"
                              />
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
                              {computeStdDrinks(parseFloat(editForm.oz), parseFloat(editForm.abv), parseInt(editForm.count) || 1)}
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
