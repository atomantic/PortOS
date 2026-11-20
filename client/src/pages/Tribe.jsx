import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { Heart, Network, Orbit, Plus, Users, Clock } from 'lucide-react';
import {
  getTribePeople,
  createTribePerson,
  getTribeDuplicateIdentifiers,
  updateTribePerson,
  deleteTribePerson,
  createTribeTouchpoint,
} from '../services/apiTribe.js';
import socket from '../services/socket';
import BrailleSpinner from '../components/BrailleSpinner';
import EmptyState from '../components/EmptyState';
import PageHeader from '../components/PageHeader';
import { localDateStr } from '../components/meatspace/constants';
import toast from '../components/ui/Toast';
import TabPills from '../components/ui/TabPills';
import CareQueue from '../components/tribe/CareQueue';
import CirclePanel from '../components/tribe/CirclePanel';
import ContactForm from '../components/tribe/ContactForm';
import FocusPanel from '../components/tribe/FocusPanel';
import OutreachQueue from '../components/tribe/OutreachQueue';
import TribeCircleMap from '../components/tribe/TribeCircleMap.jsx';
import TribeStatsBar from '../components/tribe/TribeStatsBar';
import { safeReadStorage, safeRemoveStorage } from '../lib/safeStorage.js';
import { STATUS_FILTER_IDS, matchesStatusFilter, ringFor, tagsToArray, tagsToInput } from '../lib/tribe.js';

const STORAGE_KEY = 'portos-tribe-v1';
const TABS = [
  { id: 'care', label: 'Care Queue', icon: Clock },
  { id: 'circle', label: 'Circle', icon: Network },
  { id: 'map', label: 'Map', icon: Orbit },
  { id: 'focus', label: 'Focus', icon: Heart },
];
const TAB_IDS = TABS.map((tab) => tab.id);
const DEFAULT_TAB = 'care';
const DEFAULT_STATUS = 'all';

const emptyDraft = () => ({
  id: null, name: '', relationship: '', ring: 'tribe', cadenceDays: 45, lastContact: '',
  channel: '', energy: 'steady', tags: '', emails: '', phones: '', nextMove: '', notes: '',
});

const withParam = (params, key, value, defaultValue) => {
  if (value === defaultValue) params.delete(key);
  else params.set(key, value);
  return params;
};

function parseStoredContacts(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export default function Tribe() {
  const [contacts, setContacts] = useState([]);
  const [draft, setDraft] = useState(emptyDraft);
  const [query, setQuery] = useState('');
  const [ringFilter, setRingFilter] = useState('all');
  const [searchParams, setSearchParams] = useSearchParams();
  const rawTab = searchParams.get('tab');
  const activeTab = TAB_IDS.includes(rawTab) ? rawTab : DEFAULT_TAB;
  const setActiveTab = (next) => {
    setSearchParams((prev) => {
      const prevRaw = prev.get('tab');
      const prevTab = TAB_IDS.includes(prevRaw) ? prevRaw : DEFAULT_TAB;
      const resolved = typeof next === 'function' ? next(prevTab) : next;
      return withParam(new URLSearchParams(prev), 'tab', resolved, DEFAULT_TAB);
    }, { replace: true });
  };
  const rawStatus = searchParams.get('status');
  const statusFilter = STATUS_FILTER_IDS.includes(rawStatus) ? rawStatus : DEFAULT_STATUS;
  const setStatusFilter = (next) => {
    setSearchParams((prev) => withParam(new URLSearchParams(prev), 'status', next, DEFAULT_STATUS), { replace: true });
  };
  const focusStatus = (next) => {
    const resolved = statusFilter === next ? DEFAULT_STATUS : next;
    setSearchParams((prev) => {
      const params = withParam(new URLSearchParams(prev), 'status', resolved, DEFAULT_STATUS);
      return resolved === DEFAULT_STATUS ? params : withParam(params, 'tab', 'care', DEFAULT_TAB);
    }, { replace: true });
  };

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [duplicates, setDuplicates] = useState(null);
  const [duplicatesDismissed, setDuplicatesDismissed] = useState(false);
  const nameInputRef = useRef(null);
  const formRef = useRef(null);
  const personParam = searchParams.get('person');
  const appliedPersonRef = useRef(null);
  const pendingScrollPersonRef = useRef(null);
  const cardRefs = useRef({});
  const selectedId = draft.id;

  const populateDraft = (contact) => setDraft({
    ...emptyDraft(),
    ...contact,
    loadedLastContact: contact.lastContact || '',
    tags: tagsToInput(contact.tags),
    emails: tagsToInput(contact.emails),
    phones: tagsToInput(contact.phones),
    cadenceDays: contact.cadenceDays || ringFor(contact.ring).cadenceDays,
  });

  const selectContact = (contact, { tab } = {}) => {
    populateDraft(contact);
    appliedPersonRef.current = contact.id;
    setSearchParams((prev) => {
      const params = new URLSearchParams(prev);
      params.set('person', contact.id);
      return tab ? withParam(params, 'tab', tab, DEFAULT_TAB) : params;
    }, { replace: true });
  };

  const loadContacts = async (isCancelled = () => false) => {
    const result = await getTribePeople({ silent: true }).catch((err) => {
      if (!isCancelled()) toast.error(err.message || 'Failed to load Tribe');
      return null;
    });
    if (isCancelled()) return;
    let people = result?.people || [];
    const legacy = parseStoredContacts(safeReadStorage(STORAGE_KEY));
    if (result !== null && people.length === 0 && legacy.length > 0) {
      const imported = [];
      for (const contact of legacy) {
        const created = await createTribePerson({
          name: contact.name || 'Unnamed person', relationship: contact.relationship || '',
          ring: contact.ring || 'tribe', cadenceDays: Math.max(1, Number(contact.cadenceDays) || ringFor(contact.ring).cadenceDays),
          lastContact: contact.lastContact || null, channel: contact.channel || '', energy: contact.energy || 'steady',
          tags: tagsToArray(contact.tags), nextMove: contact.nextMove || '', notes: contact.notes || '',
        }).catch(() => null);
        if (created) imported.push(created);
      }
      if (imported.length > 0) {
        people = imported;
        safeRemoveStorage(STORAGE_KEY);
        toast.success(`Imported ${imported.length} Tribe relationship${imported.length === 1 ? '' : 's'} into Postgres`);
      }
    }
    if (isCancelled()) return;
    setContacts(people);
    setLoading(false);
  };

  useEffect(() => {
    let cancelled = false;
    const isCancelled = () => cancelled;
    loadContacts(isCancelled);
    const loadDuplicates = () => getTribeDuplicateIdentifiers({ silent: true })
      .then((report) => { if (!isCancelled()) setDuplicates(report); })
      .catch(() => { if (!isCancelled()) setDuplicates({ emails: [], phones: [] }); });
    loadDuplicates();
    const handleChanged = () => { loadContacts(isCancelled); loadDuplicates(); };
    socket.on('tribe:changed', handleChanged);
    return () => { cancelled = true; socket.off('tribe:changed', handleChanged); };
  }, []);

  const startNewRelationship = () => {
    appliedPersonRef.current = null;
    setSearchParams((prev) => {
      const prevRaw = prev.get('tab');
      const prevTab = TAB_IDS.includes(prevRaw) ? prevRaw : DEFAULT_TAB;
      const nextTab = prevTab === 'focus' || prevTab === 'map' ? 'circle' : prevTab;
      const params = withParam(new URLSearchParams(prev), 'tab', nextTab, DEFAULT_TAB);
      params.delete('person');
      return params;
    }, { replace: true });
    setDraft(emptyDraft());
    requestAnimationFrame(() => {
      formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      nameInputRef.current?.focus();
    });
  };

  const filteredContacts = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return contacts.filter((contact) => {
      if (ringFilter !== 'all' && contact.ring !== ringFilter) return false;
      if (!matchesStatusFilter(contact, statusFilter)) return false;
      if (!normalized) return true;
      return [contact.name, contact.relationship, contact.channel, tagsToArray(contact.tags).join(' '), contact.nextMove, contact.notes]
        .join(' ').toLowerCase().includes(normalized);
    });
  }, [contacts, query, ringFilter, statusFilter]);

  useEffect(() => {
    if (!personParam) {
      if (appliedPersonRef.current !== null) {
        appliedPersonRef.current = null;
        setDraft(emptyDraft());
      }
      return;
    }
    if (appliedPersonRef.current === personParam || loading) return;
    const target = contacts.find((contact) => contact.id === personParam);
    appliedPersonRef.current = personParam;
    if (!target) return;
    populateDraft(target);
    setActiveTab('circle');
    pendingScrollPersonRef.current = personParam;
  }, [personParam, contacts, loading]);

  useEffect(() => {
    if (!pendingScrollPersonRef.current || activeTab !== 'circle') return;
    const id = pendingScrollPersonRef.current;
    const frame = requestAnimationFrame(() => {
      cardRefs.current[id]?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      pendingScrollPersonRef.current = null;
    });
    return () => cancelAnimationFrame(frame);
  }, [activeTab, filteredContacts]);

  const saveDraft = async () => {
    const payload = {
      name: draft.name.trim() || 'Unnamed person', relationship: draft.relationship.trim(),
      ring: draft.ring, cadenceDays: Math.max(1, Number(draft.cadenceDays) || ringFor(draft.ring).cadenceDays),
      channel: draft.channel.trim(), energy: draft.energy, tags: tagsToArray(draft.tags),
      emails: tagsToArray(draft.emails), phones: tagsToArray(draft.phones),
      nextMove: draft.nextMove.trim(), notes: draft.notes.trim(),
    };
    const isCreate = !draft.id;
    if (isCreate || (draft.lastContact || '') !== (draft.loadedLastContact || '')) payload.lastContact = draft.lastContact || null;
    setSaving(true);
    const resolved = await (draft.id ? updateTribePerson(draft.id, payload, { silent: true }) : createTribePerson(payload, { silent: true }))
      .catch((err) => { toast.error(err.message || 'Failed to save relationship'); return null; });
    setSaving(false);
    if (!resolved) return;
    setContacts((current) => current.some((c) => c.id === resolved.id) ? current.map((c) => (c.id === resolved.id ? resolved : c)) : [resolved, ...current]);
    if (isCreate) startNewRelationship();
    else selectContact(resolved);
  };

  const deleteDraft = async () => {
    const id = draft.id;
    if (!id) return;
    setDeleting(true);
    const result = await deleteTribePerson(id, { silent: true }).catch((err) => {
      toast.error(err.message || 'Failed to delete relationship');
      return null;
    });
    setDeleting(false);
    if (!result?.success) return;
    setContacts((current) => current.filter((contact) => contact.id !== id));
    appliedPersonRef.current = null;
    setDraft(emptyDraft());
    setSearchParams((prev) => {
      const params = new URLSearchParams(prev);
      params.delete('person');
      return params;
    }, { replace: true });
  };

  const logTouch = async (id) => {
    const now = new Date();
    const date = localDateStr(now);
    const result = await createTribeTouchpoint(id, {
      happenedAt: now.toISOString(), localDate: date,
      channel: contacts.find((contact) => contact.id === id)?.channel || '',
      summary: 'Manual touchpoint', source: 'user',
    }, { silent: true }).catch((err) => { toast.error(err.message || 'Failed to log touchpoint'); return null; });
    if (!result?.id) return;
    setContacts((current) => current.map((contact) => (contact.id === id ? { ...contact, lastContact: date } : contact)));
    if (draft.id === id) setDraft((current) => ({ ...current, lastContact: date, loadedLastContact: date }));
  };

  const clearFilters = () => { setQuery(''); setRingFilter('all'); setStatusFilter(DEFAULT_STATUS); };
  const formProps = { draft, onChange: setDraft, onSave: saveDraft, onDelete: deleteDraft, onNew: startNewRelationship, isExisting: Boolean(draft.id), saving, deleting, nameInputRef, formRef };

  return (
    <div className="flex h-full flex-col">
      <PageHeader icon={Users} title="Tribe" subtitle="Relationships, rings, cadence, and care." actions={
        <button type="button" onClick={startNewRelationship} className="inline-flex items-center gap-2 rounded border border-port-border px-3 py-2 text-sm text-gray-300 hover:bg-port-border/40 hover:text-white">
          <Plus size={15} aria-hidden="true" />
          Add
        </button>
      } />
      <TabPills tabs={TABS} activeTab={activeTab} onChange={setActiveTab} ariaLabel="Tribe sections" />
      <section className="flex-1 overflow-auto p-4">
        <div className="mx-auto grid max-w-7xl gap-4">
          {loading ? (
            <div className="flex min-h-[220px] items-center justify-center"><BrailleSpinner text="Loading Tribe" /></div>
          ) : (
            <>
              <TribeStatsBar
                contacts={contacts}
                statusFilter={statusFilter}
                onFocusStatus={focusStatus}
                duplicates={duplicates}
                duplicatesDismissed={duplicatesDismissed}
                onDismissDuplicates={() => setDuplicatesDismissed(true)}
              />

              {activeTab === 'circle' && (
                <CirclePanel
                  contacts={contacts}
                  filteredContacts={filteredContacts}
                  selectedId={selectedId}
                  draftId={draft.id}
                  query={query}
                  onQueryChange={setQuery}
                  ringFilter={ringFilter}
                  onRingFilterChange={setRingFilter}
                  statusFilter={statusFilter}
                  onStatusFilterChange={setStatusFilter}
                  onClearFilters={clearFilters}
                  onSelectContact={selectContact}
                  onLogTouch={logTouch}
                  cardRefs={cardRefs}
                  formProps={formProps}
                />
              )}

              {activeTab === 'map' && (contacts.length === 0 ? (
                <EmptyState icon={Users} title="No relationships yet" message="Add the first person in your circle, then PortOS can keep cadence, ring size, and care queue visible." />
              ) : (
                <TribeCircleMap contacts={contacts} selectedId={selectedId} onSelect={(contact) => selectContact(contact, { tab: 'circle' })} onLogTouch={logTouch} />
              ))}

              {activeTab === 'care' && (
                <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(330px,420px)]">
                  <div className="grid gap-4">
                    <OutreachQueue />
                    <CareQueue contacts={contacts} statusFilter={statusFilter} onStatusFilterChange={setStatusFilter} onSelect={(contact) => selectContact(contact, { tab: 'circle' })} onLogTouch={logTouch} />
                  </div>
                  <ContactForm {...formProps} />
                </div>
              )}

              {activeTab === 'focus' && <FocusPanel contacts={contacts} />}
            </>
          )}
        </div>
      </section>
    </div>
  );
}
