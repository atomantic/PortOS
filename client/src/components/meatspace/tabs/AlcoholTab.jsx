import { useState } from 'react';
import { Beer, Plus, Trash2, AlertTriangle, TrendingDown, TrendingUp, Pencil, Check, X, Settings } from 'lucide-react';
import { pluralize } from '../../../lib/textUtils';
import {
  getCustomDrinks,
  getAlcoholSummary,
  getDailyAlcohol,
  logAlcoholDrink,
  removeAlcoholDrink,
  updateAlcoholDrink,
  addCustomDrink,
  updateCustomDrink,
  removeCustomDrink,
} from '../../../services/apiMeatspace.js';
import BrailleSpinner from '../../BrailleSpinner';
import LoadFailureNotice from '../LoadFailureNotice';
import ConfirmButtonPair from '../../ui/ConfirmButtonPair';
import { FormField } from '../../ui/FormField';
import AlcoholChart from '../AlcoholChart';
import AlcoholHrvCorrelation from '../AlcoholHrvCorrelation';
import StandardDrinkCalculator from '../StandardDrinkCalculator';
import { dayOfWeek } from '../constants';
import { localDateKey } from '../../../utils/formatters';
import DraftNumber from '../../ui/DraftNumber';
import useSubstanceLog from '../useSubstanceLog';

const ML_PER_OZ = 29.5735;

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

function computeStdDrinks(oz, abv, count) {
  const pureOz = (oz || 0) * (count || 1) * ((abv || 0) / 100);
  return Math.round((pureOz / 0.6) * 100) / 100;
}

const roundedOz = (value, unit) => Math.round(toOz(parseFloat(value), unit) * 100) / 100;
const toDrinkPayload = ({ name, oz, abv, volumeUnit }) => ({ name, oz: roundedOz(oz, volumeUnit), abv: parseFloat(abv) });

const alcoholLog = {
  getSummary: getAlcoholSummary,
  entry: {
    read: getDailyAlcohol,
    add: logAlcoholDrink,
    update: updateAlcoholDrink,
    remove: removeAlcoholDrink,
    emptyDraft: { name: '', oz: '', abv: '', count: 1 },
    canAdd: ({ oz, abv }) => Boolean(oz && abv),
    toPayload: toDrinkPayload,
    fromRecord: drink => ({ name: drink.name || '', oz: String(drink.oz || ''), abv: String(drink.abv || ''), volumeUnit: 'oz' }),
    fromButton: ({ name, oz, abv }) => ({ name, oz, abv })
  },
  button: {
    read: getCustomDrinks,
    add: (...args) => addCustomDrink(...args),
    update: (...args) => updateCustomDrink(...args),
    remove: removeCustomDrink,
    label: 'drink',
    emptyDraft: { name: '', oz: '', abv: '', volumeUnit: 'oz' },
    toPayload: toDrinkPayload,
    fromRecord: drink => ({ name: drink.name, oz: String(drink.oz), abv: String(drink.abv), volumeUnit: 'oz' }),
    validate: ({ name, oz, abv, volumeUnit }) => {
      const parsedVol = parseFloat(oz);
      const parsedAbv = parseFloat(abv);
      if (!name) return 'Name is required';
      const maxVol = volumeUnit === 'ml' ? Math.round(1000 * ML_PER_OZ) : 1000;
      if (isNaN(parsedVol) || parsedVol < 0.1 || parsedVol > maxVol) return `Volume must be between 0.1 and ${maxVol} ${volumeUnit}`;
      if (isNaN(parsedAbv) || parsedAbv < 0 || parsedAbv > 100) return 'ABV must be between 0 and 100';
      return null;
    }
  }
};

export default function AlcoholTab() {
  const {
    summary, loading, loadFailed, logging, refreshKey, fetchData,
    totalDays, visibleEntries, remainingDays, loadMoreDays,
    chartView, setChartView, correlationData,
    entryForm: { name, oz, abv, count }, setEntryForm, editingKey, editForm, setEditForm,
    handleQuickAdd, handleCustomAdd, handleRemove, startEdit, cancelEdit, saveEdit,
    buttons: drinkButtons, buttonsFailed, fetchButtons, managingButtons, setManagingButtons,
    editingButtonIdx, buttonForm, setButtonForm, handleAddButton,
    startEditButton, saveEditButton, cancelEditButton, handleRemoveButton,
    isConfirming, requestDelete, cancelDelete, confirmDelete
  } = useSubstanceLog(alcoholLog);
  const [date, setDate] = useState(localDateKey);
  const [volumeUnit, setVolumeUnit] = useState('oz');
  const buttonVolumeUnit = buttonForm.volumeUnit;
  const editVolumeUnit = editForm.volumeUnit;

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
        <LoadFailureNotice message="Could not load drink history." onRetry={fetchData} />
      )}
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
          <h2 className="text-sm font-medium text-gray-400 uppercase tracking-wider">Log a Drink</h2>
          {drinkButtons && <button
            type="button"
            aria-expanded={managingButtons}
            onClick={() => setManagingButtons(v => !v)}
            className={`flex items-center gap-1 px-2 py-1 text-xs rounded-lg transition-colors ${
              managingButtons ? 'bg-port-accent/20 text-port-accent' : 'text-gray-500 hover:text-gray-300'
            }`}
            title="Manage quick-add buttons"
          >
            <Settings size={14} />
            {managingButtons ? 'Done' : 'Manage'}
          </button>}
        </div>

        {buttonsFailed && (
          <div className="mb-4">
            <LoadFailureNotice message="Could not load your quick-add drink buttons." onRetry={fetchButtons} />
          </div>
        )}

        {/* Quick-add buttons */}
        {drinkButtons && !managingButtons && (
          <div className="flex flex-wrap gap-2 mb-4">
            {drinkButtons.map((drink, idx) => (
              <button
                key={`${drink.name}-${idx}`}
                onClick={() => handleQuickAdd(drink, date)}
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
        {drinkButtons && managingButtons && (
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
                      aria-label="Drink button name"
                      className="flex-1 px-2 py-1.5 bg-port-bg border border-port-border rounded-lg text-xs text-white"
                    />
                    <input
                      type="number"
                      step="0.1"
                      min="0.1"
                      value={buttonForm.oz}
                      onChange={e => setButtonForm(f => ({ ...f, oz: e.target.value }))}
                      placeholder={buttonVolumeUnit === 'oz' ? 'Oz' : 'mL'}
                      aria-label={`Drink button volume in ${buttonVolumeUnit}`}
                      className="w-16 px-2 py-1.5 bg-port-bg border border-port-border rounded-lg text-xs text-white text-right"
                    />
                    <button
                      type="button"
                      onClick={() => setButtonForm(f => ({ ...f, volumeUnit: f.volumeUnit === 'oz' ? 'ml' : 'oz' }))}
                      className="px-1.5 py-1 text-[10px] pointer-coarse:min-h-11 font-medium rounded bg-port-border/50 text-gray-400 hover:text-port-accent hover:bg-port-accent/10 transition-colors"
                      aria-label={`Switch drink button volume unit, currently ${buttonVolumeUnit}`}
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
                      aria-label="Drink button ABV percent"
                      className="w-16 px-2 py-1.5 bg-port-bg border border-port-border rounded-lg text-xs text-white text-right"
                    />
                    <button onClick={saveEditButton} className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center p-1.5 text-port-success hover:text-port-success/80" title="Save" aria-label="Save">
                      <Check size={14} />
                    </button>
                    <button onClick={cancelEditButton} className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center p-1.5 text-gray-500 hover:text-gray-300" title="Cancel" aria-label="Cancel">
                      <X size={14} />
                    </button>
                  </>
                ) : (
                  <>
                    <span className="flex-1 text-xs text-gray-300">{drink.name}</span>
                    <span className="text-xs text-gray-500">{drink.oz}oz</span>
                    <span className="text-xs text-gray-500">{drink.abv}%</span>
                    <button onClick={() => startEditButton(idx)} className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center p-1.5 text-gray-600 hover:text-port-accent" title="Edit" aria-label={`Edit ${drink.name}`}>
                      <Pencil size={12} />
                    </button>
                    {isConfirming(`btn:${idx}`) ? (
                      <ConfirmButtonPair
                        prompt="Remove?"
                        confirmText="Remove"
                        confirmIcon={Trash2}
                        ariaLabel={`Confirm remove quick-add button ${drink.name}`}
                        onConfirm={() => confirmDelete(() => handleRemoveButton(idx))}
                        onCancel={cancelDelete}
                      />
                    ) : (
                      <button onClick={() => requestDelete(`btn:${idx}`)} className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center p-1.5 text-gray-600 hover:text-port-error" title="Remove" aria-label={`Remove ${drink.name}`}>
                        <Trash2 size={12} />
                      </button>
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
                  onChange={e => setButtonForm(f => ({ ...f, name: e.target.value }))}
                  placeholder="New button name"
                  aria-label="New drink button name"
                  className="flex-1 px-2 py-1.5 bg-port-bg border border-port-border rounded-lg text-xs text-white placeholder-gray-600"
                />
                <input
                  type="number"
                  step="0.1"
                  min="0.1"
                  value={buttonForm.oz}
                  onChange={e => setButtonForm(f => ({ ...f, oz: e.target.value }))}
                  placeholder={buttonVolumeUnit === 'oz' ? 'Oz' : 'mL'}
                  aria-label={`New drink button volume in ${buttonVolumeUnit}`}
                  className="w-16 px-2 py-1.5 bg-port-bg border border-port-border rounded-lg text-xs text-white text-right placeholder-gray-600"
                />
                <button
                  type="button"
                  onClick={() => setButtonForm(f => ({ ...f, volumeUnit: f.volumeUnit === 'oz' ? 'ml' : 'oz' }))}
                  aria-label={`Switch new drink button volume unit, currently ${buttonVolumeUnit}`}
                  className="px-1.5 py-1 text-[10px] pointer-coarse:min-h-11 font-medium rounded bg-port-border/50 text-gray-400 hover:text-port-accent hover:bg-port-accent/10 transition-colors"
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
                  aria-label="New drink button ABV percent"
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
        <form onSubmit={e => handleCustomAdd(e, date, { volumeUnit })} className="grid grid-cols-2 sm:grid-cols-[1fr_5rem_5rem_4rem_9rem_auto] items-end gap-3">
          <FormField className="col-span-2 sm:col-span-1" label="Name (optional)" labelClassName="text-xs text-gray-500 block mb-1">
            <input
              type="text"
              value={name}
              onChange={e => setEntryForm(f => ({ ...f, name: e.target.value }))}
              placeholder="e.g., Hazy IPA"
              className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-sm text-white placeholder-gray-600"
            />
          </FormField>
          <div>
            <div className="flex items-center gap-1.5 mb-1">
              <label htmlFor="alcohol-volume" className="text-xs text-gray-500">Volume</label>
              <button
                type="button"
                onClick={() => setVolumeUnit(u => u === 'oz' ? 'ml' : 'oz')}
                className="px-1.5 py-0.5 text-[10px] pointer-coarse:min-h-11 font-medium rounded bg-port-border/50 text-gray-400 hover:text-port-accent hover:bg-port-accent/10 transition-colors"
              >
                {volumeUnit}
              </button>
            </div>
            <input
              id="alcohol-volume"
              type="number"
              step="0.1"
              min="0.1"
              value={oz}
              onChange={e => setEntryForm(f => ({ ...f, oz: e.target.value }))}
              required
              placeholder={volumeUnit === 'oz' ? '12' : '355'}
              className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-sm text-white placeholder-gray-600"
            />
          </div>
          <FormField label="ABV %" labelClassName="text-xs text-gray-500 block mb-1">
            <input
              type="number"
              step="0.1"
              min="0"
              max="100"
              value={abv}
              onChange={e => setEntryForm(f => ({ ...f, abv: e.target.value }))}
              required
              placeholder="5"
              className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-sm text-white placeholder-gray-600"
            />
          </FormField>
          <DraftNumber integer min={1} max={20} value={count} onCommit={value => setEntryForm(f => ({ ...f, count: value }))}>
            {(field) => (
              <FormField label="Count" labelClassName="text-xs text-gray-500 block mb-1">
                <input type="number" className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-sm text-white" {...field} />
              </FormField>
            )}
          </DraftNumber>
          <FormField label="Date" labelClassName="text-xs text-gray-500 block mb-1">
            <input
              type="date"
              value={date}
              onChange={e => setDate(e.target.value)}
              className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-sm text-white"
            />
          </FormField>
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
      {totalDays > 0 && (
        <div className="bg-port-card border border-port-border rounded-xl p-4">
          <h2 className="text-sm font-medium text-gray-400 uppercase tracking-wider mb-3">
            All Drink Entries ({pluralize(totalDays, 'day')})
          </h2>
          <div className="max-h-dvh-cap [--dvh-cap:70dvh] overflow-x-auto overflow-y-auto rounded-lg border border-port-border">
            <table className="w-full text-sm min-w-[600px]">
              <thead className="sticky top-0 bg-port-card z-10">
                <tr className="border-b border-port-border text-left text-xs text-gray-500 uppercase">
                  <th scope="col" className="px-3 py-2">Date</th>
                  <th scope="col" className="px-3 py-2">Name</th>
                  <th scope="col" className="px-3 py-2 text-right">Oz</th>
                  <th scope="col" className="px-3 py-2 text-right">ABV%</th>
                  <th scope="col" className="px-3 py-2 text-right">Count</th>
                  <th scope="col" className="px-3 py-2 text-right">Std Drinks</th>
                  <th scope="col" className="px-3 py-2 text-right w-20">Actions</th>
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
                              aria-label="Entry date"
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
                            <span className="sr-only">{entry.date}</span>
                          )}
                        </td>
                        {isEditing ? (
                          <>
                            <td className="px-3 py-1.5">
                              <input
                                type="text"
                                value={editForm.name}
                                onChange={e => setEditForm(f => ({ ...f, name: e.target.value }))}
                                aria-label="Entry name"
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
                                  aria-label={`Entry volume in ${editVolumeUnit}`}
                                  className="w-16 px-2 py-1 bg-port-bg border border-port-border rounded text-xs text-white text-right"
                                />
                                <button
                                  type="button"
                                  onClick={() => setEditForm(f => ({ ...f, volumeUnit: f.volumeUnit === 'oz' ? 'ml' : 'oz' }))}
                                  className="px-1 py-0.5 text-[10px] pointer-coarse:min-h-11 font-medium rounded bg-port-border/50 text-gray-400 hover:text-port-accent hover:bg-port-accent/10 transition-colors"
                                  aria-label={`Switch entry volume unit, currently ${editVolumeUnit}`}
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
                                aria-label="Entry ABV percent"
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
                                aria-label="Entry count"
                                className="w-14 px-2 py-1 bg-port-bg border border-port-border rounded text-xs text-white text-right"
                              />
                            </td>
                            <td className="px-3 py-1.5 text-right text-gray-500 text-xs">
                              {computeStdDrinks(toOz(parseFloat(editForm.oz), editVolumeUnit), parseFloat(editForm.abv), parseInt(editForm.count) || 1)}
                            </td>
                            <td className="px-3 py-1.5 text-right">
                              <div className="flex items-center justify-end gap-2">
                                <button
                                  onClick={saveEdit}
                                  className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center p-1 text-port-success hover:text-port-success/80 transition-colors"
                                  title="Save" aria-label="Save"
                                >
                                  <Check size={14} />
                                </button>
                                <button
                                  onClick={cancelEdit}
                                  className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center p-1 text-gray-500 hover:text-gray-300 transition-colors"
                                  title="Cancel" aria-label="Cancel"
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
                              <div className="flex items-center justify-end gap-2">
                                <button
                                  onClick={() => startEdit(entry.date, idx, drink)}
                                  className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center p-1 text-gray-600 hover:text-port-accent transition-colors"
                                  title="Edit drink" aria-label={`Edit ${drink.name || 'drink'} entry for ${entry.date}`}
                                >
                                  <Pencil size={12} />
                                </button>
                                {isConfirming(key) ? (
                                  <ConfirmButtonPair
                                    prompt="Remove?"
                                    confirmText="Remove"
                                    confirmIcon={Trash2}
                                    ariaLabel={`Confirm remove drink ${drink.name || 'entry'}`}
                                    onConfirm={() => confirmDelete(() => handleRemove(entry.date, idx, drink.id))}
                                    onCancel={cancelDelete}
                                  />
                                ) : (
                                  <button
                                    onClick={() => requestDelete(key)}
                                    className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center p-1 text-gray-600 hover:text-port-error transition-colors"
                                    title="Remove drink" aria-label={`Remove ${drink.name || 'drink'} entry for ${entry.date}`}
                                  >
                                    <Trash2 size={12} />
                                  </button>
                                )}
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

      {/* Standard Drink Calculator */}
      <StandardDrinkCalculator />
    </div>
  );
}
