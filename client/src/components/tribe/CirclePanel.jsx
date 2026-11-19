import { useState } from 'react';
import { Filter, Search, Users, X } from 'lucide-react';
import EmptyState from '../EmptyState';
import BeeperIdentitiesPanel from './BeeperIdentitiesPanel';
import ContactCard from './ContactCard';
import ContactForm from './ContactForm';
import MemoryLinksPanel from './MemoryLinksPanel';
import RingMeter from './RingMeter';
import StatusFilterBar from './StatusFilterBar';
import TouchpointsPanel from './TouchpointsPanel';
import { RINGS } from '../../lib/tribe.js';

export default function CirclePanel({
  contacts,
  filteredContacts,
  selectedId,
  draftId,
  query,
  onQueryChange,
  ringFilter,
  onRingFilterChange,
  statusFilter,
  onStatusFilterChange,
  onClearFilters,
  onSelectContact,
  onLogTouch,
  cardRefs,
  formProps,
}) {
  const [ringsOpen, setRingsOpen] = useState(false);

  return (
    <div className="grid gap-4 xl:grid-cols-[310px_minmax(0,1fr)_minmax(330px,420px)]">
      {/* Five ring meters are a dashboard, not the task — below xl they collapse
          behind a disclosure so the search field and the first people stay on
          the first screen (#3791). */}
      <aside className="grid content-start gap-3">
        <button
          type="button"
          onClick={() => setRingsOpen((open) => !open)}
          aria-expanded={ringsOpen}
          className="flex items-center justify-between gap-2 rounded border border-port-border bg-port-card px-3 py-2 text-sm text-gray-300 hover:text-white xl:hidden"
        >
          <span>Ring capacity</span>
          <span className="text-xs text-gray-500">{ringsOpen ? 'Hide' : 'Show'}</span>
        </button>
        <div className={`content-start gap-3 xl:grid ${ringsOpen ? 'grid' : 'hidden'}`}>
          {RINGS.map((ring) => (
            <RingMeter
              key={ring.id}
              ring={ring}
              contacts={contacts}
              active={ringFilter === ring.id}
              onClick={() => onRingFilterChange(ringFilter === ring.id ? 'all' : ring.id)}
            />
          ))}
        </div>
      </aside>

      <section className="min-w-0">
        <div className="mb-3 flex flex-col gap-2 sm:flex-row">
          <div className="relative min-w-0 flex-1">
            <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" aria-hidden="true" />
            <input
              aria-label="Search relationships"
              value={query}
              onChange={(event) => onQueryChange(event.target.value)}
              className="w-full rounded border border-port-border bg-port-card py-2 pl-9 pr-3 text-sm text-white outline-none focus:border-port-accent"
              placeholder="Search relationships"
            />
          </div>
          <div className="relative sm:w-44">
            <Filter size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" aria-hidden="true" />
            <select
              aria-label="Filter relationships by ring"
              value={ringFilter}
              onChange={(event) => onRingFilterChange(event.target.value)}
              className="w-full rounded border border-port-border bg-port-card py-2 pl-9 pr-3 text-sm text-white outline-none focus:border-port-accent"
            >
              <option value="all">All rings</option>
              {RINGS.map((ring) => <option key={ring.id} value={ring.id}>{ring.label}</option>)}
            </select>
          </div>
          {(query || ringFilter !== 'all' || statusFilter !== 'all') && (
            <button
              type="button"
              onClick={onClearFilters}
              title="Clear filters"
              aria-label="Clear filters"
              className="pointer-coarse:min-h-11 pointer-coarse:min-w-11 inline-flex h-10 w-10 items-center justify-center rounded border border-port-border text-gray-400 hover:bg-port-border/40 hover:text-white"
            >
              <X size={16} aria-hidden="true" />
            </button>
          )}
        </div>

        <div className="mb-3">
          <StatusFilterBar statusFilter={statusFilter} onChange={onStatusFilterChange} />
        </div>

        {contacts.length === 0 ? (
          <EmptyState
            icon={Users}
            title="No relationships yet"
            message="Add the first person in your circle, then PortOS can keep cadence, ring size, and care queue visible."
          />
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            {filteredContacts.map((contact) => (
              <ContactCard
                key={contact.id}
                contact={contact}
                active={selectedId === contact.id}
                onSelect={() => onSelectContact(contact)}
                onLogTouch={() => onLogTouch(contact.id)}
                cardRef={(el) => { cardRefs.current[contact.id] = el; }}
              />
            ))}
            {filteredContacts.length === 0 && (
              <div className="rounded border border-port-border bg-port-card p-8 text-center text-sm text-gray-500 md:col-span-2">
                No relationships match the current filters.
              </div>
            )}
          </div>
        )}
      </section>

      <aside className="min-w-0">
        <ContactForm {...formProps} />
        {draftId && <BeeperIdentitiesPanel personId={draftId} />}
        {draftId && <MemoryLinksPanel personId={draftId} />}
        {draftId && <TouchpointsPanel personId={draftId} />}
      </aside>
    </div>
  );
}
