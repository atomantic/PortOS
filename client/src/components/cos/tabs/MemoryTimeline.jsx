export default function MemoryTimeline({ memories }) {
  const grouped = memories.reduce((acc, m) => {
    const date = m.createdAt?.split('T')[0] || 'Unknown';
    if (!acc[date]) acc[date] = [];
    acc[date].push(m);
    return acc;
  }, {});

  const dates = Object.keys(grouped).sort().reverse();

  return (
    <div className="space-y-6">
      {dates.map(date => (
        <div key={date}>
          <div className="text-sm font-medium text-gray-400 mb-2 sticky top-0 bg-port-bg py-1">
            {new Date(date).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })}
          </div>
          <div className="border-l border-port-border pl-4 space-y-3">
            {grouped[date].map(m => (
              <div key={m.id} className="relative">
                <div className="absolute -left-[21px] w-2 h-2 rounded-full bg-port-accent" />
                <div className="text-sm text-white">{m.summary}</div>
                <div className="text-xs text-gray-500 mt-1">{m.type} * {m.category}</div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
