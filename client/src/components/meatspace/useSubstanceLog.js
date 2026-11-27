/** Share the MeatSpace substance log's history, entry drafts, and quick-add button management. */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useConfirmDelete } from '../../hooks/useConfirmDelete';
import { useSingleFlight } from '../../hooks/useSingleFlight';
import { getAppleHealthCorrelation } from '../../services/apiHealth.js';
import { localDateKey } from '../../utils/formatters';
import toast from '../ui/Toast';

const DAYS_PER_PAGE = 50;

export default function useSubstanceLog({ getSummary, entry, button }) {
  const [summary, setSummary] = useState(null);
  const [allEntries, setAllEntries] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [logging, setLogging] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [visibleDays, setVisibleDays] = useState(DAYS_PER_PAGE);
  const { isConfirming, requestDelete, cancelDelete, confirmDelete } = useConfirmDelete();

  const [entryForm, setEntryForm] = useState(entry.emptyDraft);
  const [editingKey, setEditingKey] = useState(null);
  const [editForm, setEditForm] = useState(entry.emptyDraft);

  // null means the button list is unloaded or failed to load.
  const [buttons, setButtons] = useState(null);
  const [buttonsFailed, setButtonsFailed] = useState(false);
  const buttonsReadSeq = useRef(0);
  const [managingButtons, setManagingButtons] = useState(false);
  const [editingButtonIdx, setEditingButtonIdx] = useState(null);
  const [buttonForm, setButtonForm] = useState(button.emptyDraft);

  const [chartView, setChartView] = useState('30d');
  const [correlationData, setCorrelationData] = useState(null);

  const cancelEditButton = useCallback(() => {
    setEditingButtonIdx(null);
    setButtonForm(button.emptyDraft);
  }, [button]);

  // A stale list may have different positions from the stored quick-add list.
  const fetchButtons = useCallback(async () => {
    const seq = ++buttonsReadSeq.current;
    const records = await button.read({ silent: true }).catch(() => null);
    if (seq !== buttonsReadSeq.current) return;
    const ok = Array.isArray(records);
    setButtons(ok ? records : null);
    setButtonsFailed(!ok);
    if (!ok) cancelEditButton();
  }, [button, cancelEditButton]);

  const fetchData = useCallback(async () => {
    const [summaryResult, entriesResult] = await Promise.allSettled([
      getSummary({ silent: true }),
      entry.read(undefined, undefined, { silent: true })
    ]);
    // Keep previously loaded data visible when either read fails.
    if (summaryResult.status === 'fulfilled') setSummary(summaryResult.value);
    if (entriesResult.status === 'fulfilled') setAllEntries(entriesResult.value);
    setLoadFailed(summaryResult.status === 'rejected' || entriesResult.status === 'rejected');
    setLoading(false);
  }, [getSummary, entry]);

  useEffect(() => {
    fetchButtons();
  }, [fetchButtons]);

  useEffect(() => {
    fetchData();
  }, [fetchData, refreshKey]);

  const { correlationFrom, correlationTo } = useMemo(() => {
    const days = { '7d': 7, '30d': 30, '90d': 90 }[chartView] || 30;
    const d = new Date();
    d.setDate(d.getDate() - days);
    return { correlationFrom: localDateKey(d), correlationTo: localDateKey() };
  }, [chartView]);

  useEffect(() => {
    let active = true;
    getAppleHealthCorrelation(correlationFrom, correlationTo)
      .then(data => { if (active) setCorrelationData(data); })
      .catch(() => { if (active) setCorrelationData(null); });
    return () => { active = false; };
  }, [correlationFrom, correlationTo]);

  const logEntry = async (payload) => {
    setLogging(true);
    const result = await entry.add(payload).catch(() => null);
    setLogging(false);
    return result;
  };

  const handleQuickAdd = async (record, date) => {
    await logEntry({ ...entry.fromButton(record), count: 1, date: date || undefined });
    setRefreshKey(k => k + 1);
  };

  const handleCustomAdd = async (event, date, extraFields) => {
    event.preventDefault();
    if (!entry.canAdd(entryForm)) return;
    const result = await logEntry({
      ...entry.toPayload({ ...entryForm, ...extraFields }),
      count: entryForm.count || 1,
      date: date || undefined
    });
    // Keep the draft when the request fails.
    if (!result) return;
    setEntryForm(entry.emptyDraft);
    setRefreshKey(k => k + 1);
  };

  const handleRemove = async (entryDate, index, id) => {
    await entry.remove(entryDate, index, id).catch(() => null);
    setRefreshKey(k => k + 1);
  };

  const startEdit = (entryDate, index, record) => {
    setEditingKey(`${entryDate}:${index}`);
    setEditForm({ ...entry.fromRecord(record), id: record.id, count: record.count || 1, date: entryDate });
  };

  const cancelEdit = () => setEditingKey(null);

  const saveEdit = async () => {
    if (!editingKey) return;
    const [entryDate, indexStr] = editingKey.split(':');
    const result = await entry.update(entryDate, parseInt(indexStr, 10), {
      id: editForm.id,
      ...entry.toPayload(editForm),
      count: parseInt(editForm.count, 10) || 1,
      date: editForm.date !== entryDate ? editForm.date : undefined
    }).catch(() => null);
    // Keep the editor open without refreshing the row underneath the draft.
    if (!result) return;
    cancelEdit();
    setRefreshKey(k => k + 1);
  };

  const handleAddButton = useSingleFlight(async () => {
    const error = button.validate(buttonForm);
    if (error) { toast.error(error); return; }
    const result = await button.add(button.toPayload(buttonForm), { silent: true }).catch(() => null);
    if (!result) { toast.error(`Failed to add ${button.label} button`); return; }
    setButtonForm(button.emptyDraft);
    // Invalidate reads started before this mutation. An unloaded list needs a
    // fresh read before it can support positional edits.
    buttonsReadSeq.current += 1;
    if (Array.isArray(buttons)) setButtons(prev => [...prev, result]);
    else fetchButtons();
  });

  const startEditButton = (idx) => {
    setEditingButtonIdx(idx);
    setButtonForm(button.fromRecord(buttons[idx]));
  };

  const saveEditButton = async () => {
    if (editingButtonIdx === null) return;
    const error = button.validate(buttonForm);
    if (error) { toast.error(error); return; }
    const result = await button.update(editingButtonIdx, button.toPayload(buttonForm), { silent: true }).catch(() => null);
    if (!result) { toast.error(`Failed to update ${button.label} button`); return; }
    cancelEditButton();
    buttonsReadSeq.current += 1;
    setButtons(prev => prev && prev.map((record, idx) => idx === editingButtonIdx ? result : record));
  };

  const handleRemoveButton = async (idx) => {
    const removed = await button.remove(idx).catch(() => null);
    if (!removed) return;
    buttonsReadSeq.current += 1;
    setButtons(prev => prev && prev.filter((_, buttonIdx) => buttonIdx !== idx));
    // Keep editing the same button when removing an earlier position.
    if (editingButtonIdx === idx) cancelEditButton();
    else if (editingButtonIdx !== null && editingButtonIdx > idx) setEditingButtonIdx(editingButtonIdx - 1);
  };

  const totalDays = allEntries?.length ?? 0;
  const visibleEntries = allEntries?.slice(0, visibleDays) || [];
  const remainingDays = Math.max(0, totalDays - visibleDays);
  const loadMoreDays = () => setVisibleDays(v => v + DAYS_PER_PAGE);

  return {
    summary, loading, loadFailed, logging, refreshKey, fetchData,
    totalDays, visibleEntries, remainingDays, loadMoreDays,
    chartView, setChartView, correlationData,
    entryForm, setEntryForm, editingKey, editForm, setEditForm,
    handleQuickAdd, handleCustomAdd, handleRemove, startEdit, cancelEdit, saveEdit,
    buttons, buttonsFailed, fetchButtons, managingButtons, setManagingButtons,
    editingButtonIdx, buttonForm, setButtonForm, handleAddButton,
    startEditButton, saveEditButton, cancelEditButton, handleRemoveButton,
    isConfirming, requestDelete, cancelDelete, confirmDelete
  };
}
