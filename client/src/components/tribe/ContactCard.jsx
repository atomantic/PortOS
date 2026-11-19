import { MessageCircle, UserRound } from 'lucide-react';
import { contactStatus, energyFor, ringFor, tagsToArray } from '../../lib/tribe.js';

export default function ContactCard({ contact, active, onSelect, onLogTouch, cardRef }) {
  const ring = ringFor(contact.ring);
  const energy = energyFor(contact.energy);
  const status = contactStatus(contact);
  const tags = tagsToArray(contact.tags).slice(0, 3);

  return (
    <article
      ref={cardRef}
      className={`w-full text-left border rounded p-4 transition-colors bg-port-card ${
        active ? 'border-port-accent/70 ring-1 ring-port-accent/30' : 'border-port-border hover:border-port-accent/40'
      }`}
    >
      <button type="button" onClick={onSelect} className="block w-full text-left">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 min-w-0">
              <UserRound size={16} className="shrink-0 text-gray-500" aria-hidden="true" />
              <h2 className="font-semibold text-white truncate">{contact.name || 'Unnamed person'}</h2>
            </div>
            <p className="mt-1 text-sm text-gray-400 truncate">{contact.relationship || 'Relationship'}</p>
          </div>
          <span className={`shrink-0 rounded border px-2 py-1 text-xs ${ring.bg} ${ring.border} ${ring.tone}`}>
            {ring.label}
          </span>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <span className={`rounded border px-2 py-1 text-xs ${energy.className}`}>{energy.label}</span>
          <span className={`text-xs ${status.tone}`}>{status.label}</span>
          {contact.channel && <span className="text-xs text-gray-500">{contact.channel}</span>}
        </div>

        {tags.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {tags.map((tag) => (
              <span key={tag} className="rounded bg-port-bg px-2 py-1 text-[11px] text-gray-400">{tag}</span>
            ))}
          </div>
        )}

        {contact.nextMove && (
          <p className="mt-3 text-sm text-gray-300 line-clamp-2">{contact.nextMove}</p>
        )}
      </button>

      <div className="mt-4 flex items-center justify-between gap-3 text-xs text-gray-500">
        <span>{contact.lastContact ? `Last ${contact.lastContact}` : 'No date logged'}</span>
        <button
          type="button"
          onClick={onLogTouch}
          className="inline-flex items-center gap-1 rounded px-2 py-1 text-port-accent hover:bg-port-accent/10"
        >
          <MessageCircle size={13} aria-hidden="true" />
          Touch
        </button>
      </div>
    </article>
  );
}
