import { useState } from 'react';
import { Calendar, Plus, Trash2, Eye, EyeOff, ChevronDown } from 'lucide-react';
import { FormField } from '../../../ui/FormField';
import { EVENT_TYPE_STYLES, EVENT_TYPES, MONTH_NAMES_FULL } from './lifeGridMath';

export default function LifeEventsPanel({ events, onAdd, onToggle, onRemove }) {
  const [expanded, setExpanded] = useState(false);
  const [adding, setAdding] = useState(false);

  // Add form state
  const [name, setName] = useState('');
  const [type, setType] = useState('holiday');
  const [recurrence, setRecurrence] = useState('yearly');
  const [month, setMonth] = useState(0);
  const [day, setDay] = useState(1);
  const [date, setDate] = useState('');

  function resetForm() {
    setName('');
    setType('holiday');
    setRecurrence('yearly');
    setMonth(0);
    setDay(1);
    setDate('');
    setAdding(false);
  }

  function handleSubmit(e) {
    e.preventDefault();
    if (!name.trim()) return;
    const event = {
      name: name.trim(),
      type,
      recurrence,
      ...(recurrence === 'yearly' ? { month, day: parseInt(day) } : { date }),
    };
    onAdd(event);
    resetForm();
  }

  const enabledCount = events.filter(e => e.enabled).length;

  return (
    <div className="bg-port-card border border-port-border rounded-lg overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between p-4 text-left hover:bg-port-bg/30 transition-colors"
      >
        <div className="flex items-center gap-2">
          <Calendar size={16} className="text-amber-400" />
          <h3 className="text-sm font-medium text-gray-400 uppercase tracking-wider">Life Events</h3>
          <span className="text-xs text-gray-600">{enabledCount} active</span>
        </div>
        <ChevronDown size={16} className={`text-gray-500 transition-transform ${expanded ? 'rotate-180' : ''}`} />
      </button>

      {expanded && (
        <div className="px-4 pb-4 space-y-3">
          {/* Event list */}
          <div className="space-y-1.5">
            {events.map(event => {
              const style = EVENT_TYPE_STYLES[event.type] || EVENT_TYPE_STYLES.custom;
              return (
                <div key={event.id} className="flex items-center gap-2.5 py-1.5 group">
                  <span className={`w-2.5 h-2.5 rounded-sm shrink-0 ${style.bg}`} />
                  <div className="flex-1 min-w-0">
                    <span className={`text-sm ${event.enabled ? 'text-white' : 'text-gray-600 line-through'}`}>
                      {event.name}
                    </span>
                    <span className="text-[10px] text-gray-600 ml-2">
                      {event.recurrence === 'yearly'
                        ? `${MONTH_NAMES_FULL[event.month]} ${event.day}`
                        : event.date}
                    </span>
                  </div>
                  <span className="text-[10px] text-gray-600">{event.type}</span>
                  <button
                    onClick={() => onToggle(event.id, !event.enabled)}
                    className="text-gray-500 hover:text-white transition-colors p-0.5"
                    title={event.enabled ? 'Disable' : 'Enable'}
                  >
                    {event.enabled ? <Eye size={12} /> : <EyeOff size={12} />}
                  </button>
                  <button
                    onClick={() => onRemove(event.id)}
                    className="opacity-40 sm:opacity-0 sm:group-hover:opacity-100 focus-visible:opacity-100 transition-opacity text-gray-600 hover:text-port-error p-0.5"
                    title="Remove"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              );
            })}
          </div>

          {/* Add form */}
          {adding ? (
            <form onSubmit={handleSubmit} className="bg-port-bg border border-port-border rounded-lg p-3 space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <FormField label="Name" labelClassName="text-xs text-gray-400 mb-1 block">
                  <input
                    type="text"
                    value={name}
                    onChange={e => setName(e.target.value)}
                    placeholder="e.g. Anniversary"
                    className="w-full px-2 py-1.5 bg-port-card border border-port-border rounded text-sm text-white focus:border-port-accent focus:outline-hidden"
                    autoFocus
                  />
                </FormField>
                <FormField label="Type" labelClassName="text-xs text-gray-400 mb-1 block">
                  <select
                    value={type}
                    onChange={e => setType(e.target.value)}
                    className="w-full px-2 py-1.5 bg-port-card border border-port-border rounded text-sm text-white focus:border-port-accent focus:outline-hidden"
                  >
                    {EVENT_TYPES.map(t => (
                      <option key={t.id} value={t.id}>{t.label}</option>
                    ))}
                  </select>
                </FormField>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <FormField label="Recurrence" labelClassName="text-xs text-gray-400 mb-1 block">
                  <select
                    value={recurrence}
                    onChange={e => setRecurrence(e.target.value)}
                    className="w-full px-2 py-1.5 bg-port-card border border-port-border rounded text-sm text-white focus:border-port-accent focus:outline-hidden"
                  >
                    <option value="yearly">Yearly</option>
                    <option value="once">One-time</option>
                  </select>
                </FormField>
                {recurrence === 'yearly' ? (
                  <div className="flex gap-2">
                    <FormField className="flex-1" label="Month" labelClassName="text-xs text-gray-400 mb-1 block">
                      <select
                        value={month}
                        onChange={e => setMonth(parseInt(e.target.value))}
                        className="w-full px-2 py-1.5 bg-port-card border border-port-border rounded text-sm text-white focus:border-port-accent focus:outline-hidden"
                      >
                        {MONTH_NAMES_FULL.map((m, i) => (
                          <option key={i} value={i}>{m}</option>
                        ))}
                      </select>
                    </FormField>
                    <FormField className="w-16" label="Day" labelClassName="text-xs text-gray-400 mb-1 block">
                      <input
                        type="number"
                        value={day}
                        onChange={e => setDay(e.target.value)}
                        min="1"
                        max="31"
                        className="w-full px-2 py-1.5 bg-port-card border border-port-border rounded text-sm text-white focus:border-port-accent focus:outline-hidden"
                      />
                    </FormField>
                  </div>
                ) : (
                  <FormField label="Date" labelClassName="text-xs text-gray-400 mb-1 block">
                    <input
                      type="date"
                      value={date}
                      onChange={e => setDate(e.target.value)}
                      className="w-full px-2 py-1.5 bg-port-card border border-port-border rounded text-sm text-white focus:border-port-accent focus:outline-hidden"
                    />
                  </FormField>
                )}
              </div>
              <div className="flex gap-2">
                <button type="submit" disabled={!name.trim()} className="px-3 py-1.5 bg-port-accent text-white text-sm rounded hover:bg-port-accent/80 disabled:opacity-50 transition-colors">
                  Add Event
                </button>
                <button type="button" onClick={resetForm} className="px-3 py-1.5 text-gray-400 text-sm hover:text-white transition-colors">
                  Cancel
                </button>
              </div>
            </form>
          ) : (
            <button
              onClick={() => setAdding(true)}
              className="flex items-center gap-1.5 px-2.5 py-1 text-xs text-gray-400 hover:text-white border border-dashed border-port-border rounded hover:border-port-accent/50 transition-colors"
            >
              <Plus size={14} />
              Add Event
            </button>
          )}
        </div>
      )}
    </div>
  );
}
