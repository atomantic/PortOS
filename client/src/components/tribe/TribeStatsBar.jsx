import { AlertTriangle, Calendar, Clock, Heart, Users, X } from 'lucide-react';
import Banner from '../ui/Banner';
import StatTile from './StatTile';
import { contactStatus } from '../../lib/tribe.js';

export default function TribeStatsBar({
  contacts,
  statusFilter,
  onFocusStatus,
  duplicates,
  duplicatesDismissed,
  onDismissDuplicates,
}) {
  const overdueCount = contacts.filter((contact) => ['missing', 'overdue'].includes(contactStatus(contact).state)).length;
  const soonCount = contacts.filter((contact) => contactStatus(contact).state === 'soon').length;
  const supportCount = contacts.filter((contact) => contact.ring === 'support').length;
  const tribeCount = contacts.filter((contact) => contact.ring !== 'external').length;
  const externalCount = contacts.length - tribeCount;
  const duplicateGroups = [...(duplicates?.emails || []), ...(duplicates?.phones || [])];

  return (
    <>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile icon={Users} label="Relationships" value={contacts.length} detail={externalCount ? `${supportCount} support · ${externalCount} external` : `${supportCount} support ring`} />
        <StatTile icon={Clock} label="Needs Care" value={overdueCount} detail="missing or overdue" onClick={() => onFocusStatus('overdue')} active={statusFilter === 'overdue'} />
        <StatTile icon={Calendar} label="Coming Up" value={soonCount} detail="due within 7 days" onClick={() => onFocusStatus('soon')} active={statusFilter === 'soon'} />
        <StatTile icon={Heart} label="Capacity" value={`${tribeCount}/150`} detail="village horizon" />
      </div>

      {duplicateGroups.length > 0 && !duplicatesDismissed && (
        <Banner
          tone="warning"
          icon={AlertTriangle}
          title="Shared contact info"
          actions={(
            <button
              type="button"
              onClick={onDismissDuplicates}
              aria-label="Dismiss shared contact info notice"
              className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center rounded text-port-warning/70 hover:text-port-warning"
            >
              <X size={14} aria-hidden="true" />
            </button>
          )}
        >
          {duplicateGroups.map((group) => (
            <div key={group.identifier}>
              <span className="font-mono">{group.identifier}</span> is on file for {group.people.map((p) => p.name).join(' and ')}.
            </div>
          ))}
        </Banner>
      )}
    </>
  );
}
