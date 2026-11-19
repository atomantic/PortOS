export default function RingMeter({ ring, contacts, active, onClick }) {
  const count = contacts.filter((contact) => contact.ring === ring.id).length;
  // `external` is uncapped (cap === null): show a count only, no fill bar or
  // cadence, since it's outside the tribe and carries no care commitment.
  const uncapped = ring.cap == null;
  const fill = uncapped ? 0 : Math.min(100, Math.round((count / ring.cap) * 100));
  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full text-left border rounded p-4 transition-colors ${ring.bg} ${active ? `${ring.border} ring-1 ring-port-accent/30` : 'border-port-border hover:border-port-accent/50'}`}
    >
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className={`text-sm font-semibold ${ring.tone}`}>{ring.label}</p>
          <p className="text-xs text-gray-500">{uncapped ? `${count}` : `${count} / ${ring.cap}`}</p>
        </div>
        <span className="text-xs text-gray-400">{uncapped ? 'outside tribe' : `${ring.cadenceDays}d`}</span>
      </div>
      {!uncapped && (
        <div className="mt-3 h-2 rounded-full bg-black/30 overflow-hidden">
          <div className="h-full rounded-full bg-current text-port-accent" style={{ width: `${fill}%` }} />
        </div>
      )}
    </button>
  );
}
