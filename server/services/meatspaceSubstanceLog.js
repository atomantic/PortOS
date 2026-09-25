/** Shared event-log workflow for MeatSpace substance records. */
import { join } from 'path';
import { atomicWrite, PATHS, ensureDir, readJSONFile, getDateString } from '../lib/fileUtils.js';
import { loadMeatspaceDailyLog, mutateDailyLog, newDailyLogEvent, stampDailyLogEventEdit, tombstoneDailyLogEvent } from './meatspaceDailyLog.js';
import { isMortalLoomEnabled, mlPush, mlPatchById, mlRemoveById, mlIdAtDateIndex } from './mortalLoomStore.js';

export function createSubstanceLog({ key, itemsField, totalField, mlCollection, itemFields, computeTotal, computeLogAmount = computeTotal, describe, customButtons, computeAverages, summaryConfig }) {
  const label = key[0].toUpperCase() + key.slice(1);
  const loadDailyLog = (options) => loadMeatspaceDailyLog({ ...options, label });
  const itemName = key === 'alcohol' ? 'drink' : 'item';
  let averageCache = null;
  let averageCacheAt = 0;
  const invalidate = () => { averageCache = null; };
  const recalc = (entry) => {
    entry[key][totalField] = Math.round(entry[key][itemsField].reduce((sum, item) => sum + computeTotal(item), 0) * 100) / 100;
  };
  const ensureSubstance = (entry) => {
    if (!entry[key]) entry[key] = { [itemsField]: [], [totalField]: 0 };
    return entry[key];
  };

  async function summary() {
    const now = Date.now();
    if (averageCache && now - averageCacheAt < 5 * 60 * 1000) return averageCache;
    const [log, config] = await Promise.all([loadDailyLog(), summaryConfig?.()]);
    const entries = log.entries || [];
    const averages = computeAverages(entries, config);
    const today = getDateString();
    const weekAgo = new Date();
    weekAgo.setDate(weekAgo.getDate() - 7);
    const weekAgoStr = getDateString(weekAgo);
    const recentEntries = entries.filter(e => e.date >= weekAgoStr && e.date <= today && e[key]?.[itemsField]?.length > 0)
      .sort((a, b) => b.date.localeCompare(a.date));
    averageCache = { ...averages, recentEntries };
    averageCacheAt = now;
    return averageCache;
  }

  async function daily(from, to, options) {
    const log = await loadDailyLog(options);
    let entries = (log.entries || []).filter(e => e[key]?.[itemsField]?.length > 0);
    if (from) entries = entries.filter(e => e.date >= from);
    if (to) entries = entries.filter(e => e.date <= to);
    return entries.sort((a, b) => b.date.localeCompare(a.date));
  }

  async function log(input) {
    const targetDate = input.date || getDateString();
    const item = Object.fromEntries(itemFields.filter(field => field !== 'date').map(field => [field, input[field]]));
    if (itemFields.includes('count')) item.count = input.count === undefined ? 1 : input.count;
    const nameField = itemFields[0];
    item[nameField] = item[nameField] || '';
    const amount = Math.round(computeLogAmount(item) * 100) / 100;
    const amountField = key === 'alcohol' ? 'standardDrinks' : 'totalMg';
    if (await isMortalLoomEnabled()) {
      await mlPush(mlCollection, { ...item, date: targetDate });
      invalidate();
      const dailyLog = await loadDailyLog();
      const entry = dailyLog.entries.find(e => e.date === targetDate);
      console.log(`${describe.icon} Logged ${describe.noun} (MortalLoom): ${describe.item(item)} on ${targetDate}`);
      return { [itemName]: item, [amountField]: amount, date: targetDate, dayTotal: entry?.[key]?.[totalField] || amount };
    }
    const result = await mutateDailyLog((dailyLog) => {
      let entry = dailyLog.entries.find(e => e.date === targetDate);
      if (!entry) { entry = { date: targetDate }; dailyLog.entries.push(entry); }
      const substance = ensureSubstance(entry);
      const event = newDailyLogEvent(item);
      substance[itemsField].push(event);
      recalc(entry);
      return { [itemName]: event, [amountField]: amount, date: targetDate, dayTotal: substance[totalField] };
    }, { label });
    invalidate();
    console.log(`${describe.icon} Logged ${describe.noun}: ${describe.item(item)} (${amount} ${describe.amountUnit}) on ${targetDate}`);
    return result;
  }

  async function update(date, index, updates) {
    if (await isMortalLoomEnabled()) {
      const id = await mlIdAtDateIndex(mlCollection, date, index);
      if (!id) return null;
      const patch = {};
      for (const field of [...itemFields, 'date']) if (updates[field] !== undefined) patch[field] = updates[field];
      const updated = await mlPatchById(mlCollection, id, patch);
      invalidate();
      const effectiveDate = updated?.date || date;
      const dailyLog = await loadDailyLog();
      const entry = dailyLog.entries.find(e => e.date === effectiveDate);
      console.log(`📝 Updated ${describe.noun} (MortalLoom) ${date}[${index}] → ${effectiveDate}: ${updated?.[itemFields[0]]}`);
      return { [itemName]: Object.fromEntries(itemFields.map(field => [field, updated[field]])), dayTotal: entry?.[key]?.[totalField] || 0, date: effectiveDate };
    }
    const result = await mutateDailyLog((dailyLog) => {
      const entry = dailyLog.entries.find(e => e.date === date);
      if (!entry?.[key]?.[itemsField]?.[index]) return null;
      const item = stampDailyLogEventEdit(entry[key][itemsField][index]);
      for (const field of itemFields) if (updates[field] !== undefined) item[field] = updates[field];
      const newDate = updates.date;
      if (newDate && newDate !== date) {
        entry[key][itemsField].splice(index, 1);
        if (entry[key][itemsField].length === 0) {
          delete entry[key];
          if (Object.keys(entry).length <= 1) dailyLog.entries = dailyLog.entries.filter(e => e !== entry);
        } else recalc(entry);
        let targetEntry = dailyLog.entries.find(e => e.date === newDate);
        if (!targetEntry) { targetEntry = { date: newDate }; dailyLog.entries.push(targetEntry); }
        ensureSubstance(targetEntry)[itemsField].push(item);
        recalc(targetEntry);
        dailyLog.entries.sort((a, b) => a.date.localeCompare(b.date));
        dailyLog.lastEntryDate = dailyLog.entries[dailyLog.entries.length - 1].date;
        return { [itemName]: item, dayTotal: targetEntry[key][totalField], date: newDate };
      }
      recalc(entry);
      return { [itemName]: item, dayTotal: entry[key][totalField] };
    }, { label });
    if (!result) return null;
    invalidate();
    console.log(`📝 ${result.date && result.date !== date ? 'Moved' : 'Updated'} ${describe.noun} ${result.date && result.date !== date ? `from ${date}[${index}] to ${result.date}` : `on ${date}[${index}]`}: ${describe.item(result[itemName])}`);
    return result;
  }

  async function remove(date, index) {
    if (await isMortalLoomEnabled()) {
      const id = await mlIdAtDateIndex(mlCollection, date, index);
      if (!id) return null;
      const removed = await mlRemoveById(mlCollection, id);
      invalidate();
      return removed;
    }
    const result = await mutateDailyLog((dailyLog) => {
      const entry = dailyLog.entries.find(e => e.date === date);
      if (!entry?.[key]?.[itemsField]?.[index]) return null;
      const removed = entry[key][itemsField].splice(index, 1)[0];
      tombstoneDailyLogEvent(dailyLog, removed);
      if (entry[key][itemsField].length === 0) delete entry[key];
      else recalc(entry);
      return removed;
    }, { label });
    if (!result) return null;
    invalidate();
    console.log(`🗑️ Removed ${describe.noun} from ${date}[${index}]: ${describe.item(result)}`);
    return result;
  }

  const buttonsFile = join(PATHS.meatspace, customButtons.file);
  async function loadButtons() {
    const data = await readJSONFile(buttonsFile, null, { allowArray: false, strict: true });
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return { [customButtons.field]: customButtons.defaults.map(item => ({ ...item })) };
    }
    if (!Array.isArray(data[customButtons.field])) data[customButtons.field] = [];
    return data;
  }
  async function saveButtons(data) {
    await ensureDir(PATHS.meatspace);
    await atomicWrite(buttonsFile, data);
  }
  async function getButtons() { return (await loadButtons())[customButtons.field] || []; }
  async function addButton(input) {
    const data = await loadButtons();
    const item = Object.fromEntries(customButtons.fields.map(field => [field, input[field]]));
    data[customButtons.field].push(item);
    await saveButtons(data);
    console.log(`${describe.icon} Added custom ${describe.noun} button: ${describe.button(item)}`);
    return item;
  }
  async function updateButton(index, updates) {
    if (!Number.isInteger(index)) return null;
    const data = await loadButtons();
    if (index < 0 || index >= data[customButtons.field].length) return null;
    const item = data[customButtons.field][index];
    for (const field of customButtons.fields) if (updates[field] !== undefined) item[field] = updates[field];
    await saveButtons(data);
    console.log(`📝 Updated custom ${describe.noun} button [${index}]: ${item.name}`);
    return item;
  }
  async function removeButton(index) {
    if (!Number.isInteger(index)) return null;
    const data = await loadButtons();
    if (index < 0 || index >= data[customButtons.field].length) return null;
    const removed = data[customButtons.field].splice(index, 1)[0];
    await saveButtons(data);
    console.log(`🗑️ Removed custom ${describe.noun} button: ${removed.name}`);
    return removed;
  }
  return { summary, daily, log, update, remove, getButtons, addButton, updateButton, removeButton };
}
