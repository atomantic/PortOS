import { useMemo } from 'react';
import { Users } from 'lucide-react';
import EmptyState from '../EmptyState';
import ContactCard from './ContactCard';
import StatusFilterBar from './StatusFilterBar';
import { STATUS_FILTER_LABELS, contactStatus, matchesStatusFilter } from '../../lib/tribe.js';

const DEFAULT_STATUS = 'all';

export default function CareQueue({ contacts, statusFilter, onStatusFilterChange, onSelect, onLogTouch }) {
  // External people are outside the tribe — no care cadence is owed, so they
  // never appear in the queue (otherwise their null daysRemaining would sort
  // them to the top alongside genuinely-overdue contacts). Memoized + status
  // computed once per contact (instead of twice per comparison in the sort).
  const queue = useMemo(() => contacts
    .filter((contact) => contact.ring !== 'external' && matchesStatusFilter(contact, statusFilter))
    .map((contact) => {
      const score = contactStatus(contact).daysRemaining;
      return { contact, score: score == null ? -999 : score };
    })
    .sort((a, b) => a.score - b.score)
    .map(({ contact }) => contact), [contacts, statusFilter]);

  // A filtered-to-empty queue is a success state ("nobody is overdue"), not the
  // "no relationships yet" onboarding empty — only show the latter when the whole
  // roster is empty.
  if (!queue.length && statusFilter === DEFAULT_STATUS) {
    return (
      <EmptyState
        icon={Users}
        title="No relationships yet"
        message="Add the first person in your circle, then PortOS can keep cadence, ring size, and care queue visible."
      />
    );
  }

  return (
    <div className="grid gap-3">
      <StatusFilterBar statusFilter={statusFilter} onChange={onStatusFilterChange} />
      {queue.length ? queue.map((contact) => (
        <ContactCard
          key={contact.id}
          contact={contact}
          active={false}
          onSelect={() => onSelect(contact)}
          onLogTouch={() => onLogTouch(contact.id)}
        />
      )) : (
        <div className="rounded border border-port-border bg-port-card p-8 text-center text-sm text-gray-500">
          Nobody is in the {STATUS_FILTER_LABELS[statusFilter].toLowerCase()} bucket right now.
        </div>
      )}
    </div>
  );
}
