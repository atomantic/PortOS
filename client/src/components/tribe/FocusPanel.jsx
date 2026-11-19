import { useMemo } from 'react';
import { Heart } from 'lucide-react';
import { ENERGY } from '../../lib/tribe.js';

export default function FocusPanel({ contacts }) {
  const byEnergy = useMemo(() => ENERGY.map((energy) => ({
    ...energy,
    count: contacts.filter((contact) => contact.energy === energy.id).length,
  })), [contacts]);
  const support = useMemo(() => contacts.filter((contact) => contact.ring === 'support'), [contacts]);
  const nextMoves = useMemo(() => contacts.filter((contact) => contact.nextMove).slice(0, 8), [contacts]);

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(280px,360px)]">
      <section className="border border-port-border bg-port-card rounded p-4">
        <div className="flex items-center gap-2">
          <Heart size={18} className="text-port-accent" aria-hidden="true" />
          <h2 className="text-sm font-semibold text-white">Inner Circle</h2>
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          {support.length ? support.map((contact) => (
            <div key={contact.id} className="rounded border border-port-border bg-port-bg p-3">
              <p className="font-medium text-white">{contact.name}</p>
              <p className="mt-1 text-sm text-gray-500">{contact.relationship || 'Support'}</p>
              {contact.nextMove && <p className="mt-3 text-sm text-gray-300">{contact.nextMove}</p>}
            </div>
          )) : (
            <p className="text-sm text-gray-500 sm:col-span-2">No support-ring relationships yet.</p>
          )}
        </div>
      </section>

      <aside className="grid gap-4">
        <div className="border border-port-border bg-port-card rounded p-4">
          <h2 className="text-sm font-semibold text-white">Energy Mix</h2>
          <div className="mt-4 grid gap-2">
            {byEnergy.map((energy) => (
              <div key={energy.id} className="flex items-center justify-between gap-3">
                <span className={`rounded border px-2 py-1 text-xs ${energy.className}`}>{energy.label}</span>
                <span className="text-sm text-gray-300">{energy.count}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="border border-port-border bg-port-card rounded p-4">
          <h2 className="text-sm font-semibold text-white">Next Moves</h2>
          <div className="mt-4 grid gap-3">
            {nextMoves.length ? nextMoves.map((contact) => (
              <div key={contact.id} className="border-l border-port-accent/40 pl-3">
                <p className="text-sm font-medium text-white">{contact.name}</p>
                <p className="text-sm text-gray-400">{contact.nextMove}</p>
              </div>
            )) : (
              <p className="text-sm text-gray-500">No next moves captured.</p>
            )}
          </div>
        </div>
      </aside>
    </div>
  );
}
