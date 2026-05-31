import { useState, useEffect, useCallback, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import * as api from '../../../services/api';
import { METRIC_CATEGORIES } from '../healthMetrics';
import HealthCategorySection from '../HealthCategorySection';
import ActivityBloodCorrelation from '../ActivityBloodCorrelation';

const RANGES = [
  { id: '7d', label: '7d', days: 7 },
  { id: '30d', label: '30d', days: 30 },
  { id: '90d', label: '90d', days: 90 },
  { id: '1y', label: '1y', days: 365 }
];

function getFromDate(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().split('T')[0];
}

export default function HealthTab() {
  const [searchParams, setSearchParams] = useSearchParams();
  const range = searchParams.get('range') || '7d';
  const sectionParam = searchParams.get('section');

  const [availableMetrics, setAvailableMetrics] = useState(new Set());
  const [expandedSections, setExpandedSections] = useState(new Set());
  const [correlationData, setCorrelationData] = useState(null);
  const [workouts, setWorkouts] = useState([]);
  const [initialized, setInitialized] = useState(false);
  const sectionRefs = useRef({});

  // Fetch which metrics have data (once on mount)
  useEffect(() => {
    api.getAvailableHealthMetrics()
      .then(metrics => {
        setAvailableMetrics(new Set(metrics.map(m => m.name)));
        // Set initial expanded sections after we know what's available
        const initial = new Set();
        for (const cat of METRIC_CATEGORIES) {
          if (cat.defaultExpanded) initial.add(cat.id);
        }
        setExpandedSections(initial);
        setInitialized(true);
      })
      .catch(() => setInitialized(true));
  }, []);

  // Expand and scroll to section when URL param changes
  useEffect(() => {
    if (!sectionParam || !initialized) return;
    setExpandedSections(prev => {
      if (prev.has(sectionParam)) return prev;
      const next = new Set(prev);
      next.add(sectionParam);
      return next;
    });
    const el = sectionRefs.current[sectionParam];
    if (el) setTimeout(() => el.scrollIntoView({ behavior: 'smooth', block: 'start' }), 100);
  }, [sectionParam, initialized]);

  // Fetch correlation data
  const days = RANGES.find(r => r.id === range)?.days ?? 7;
  const from = getFromDate(days);
  const to = new Date().toISOString().split('T')[0];

  useEffect(() => {
    api.getAppleHealthCorrelation(from, to)
      .then(setCorrelationData)
      .catch(() => setCorrelationData(null));
  }, [from, to]);

  useEffect(() => {
    api.getWorkouts()
      .then((data) => setWorkouts(data?.workouts || []))
      .catch(() => setWorkouts([]));
  }, []);

  const setRange = useCallback((newRange) => {
    const params = new URLSearchParams(searchParams);
    params.set('range', newRange);
    setSearchParams(params, { replace: true });
  }, [searchParams, setSearchParams]);

  const toggleSection = useCallback((sectionId) => {
    setExpandedSections(prev => {
      const next = new Set(prev);
      if (next.has(sectionId)) {
        next.delete(sectionId);
      } else {
        next.add(sectionId);
      }
      return next;
    });
  }, []);

  if (!initialized) {
    return <div className="text-gray-600 text-sm py-12 text-center">Loading health data...</div>;
  }

  return (
    <div className="space-y-4">
      {/* Range selector */}
      <div className="flex items-center gap-1">
        {RANGES.map(r => (
          <button
            key={r.id}
            onClick={() => setRange(r.id)}
            className={`px-3 py-1.5 text-sm rounded-lg transition-colors font-medium ${
              range === r.id
                ? 'bg-port-accent/10 text-port-accent'
                : 'text-gray-400 hover:text-white hover:bg-port-border/50'
            }`}
          >
            {r.label}
          </button>
        ))}
      </div>

      <section className="border border-port-border rounded-lg overflow-hidden">
        <div className="px-4 py-3 border-b border-port-border bg-port-bg/40">
          <h3 className="text-sm font-medium text-white">Workouts</h3>
        </div>
        {workouts.length === 0 ? (
          <p className="px-4 py-3 text-sm text-gray-500">No workouts logged yet.</p>
        ) : (
          <div className="divide-y divide-port-border/70">
            {workouts.slice(0, 8).map((workout, index) => (
              <div key={`${workout.date}-${workout.type}-${index}`} className="px-4 py-3 flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <p className="text-sm text-white truncate">{workout.type}</p>
                  {workout.notes && <p className="text-xs text-gray-500 truncate">{workout.notes}</p>}
                </div>
                <div className="shrink-0 text-right text-xs text-gray-400">
                  <div>{workout.date}</div>
                  <div>
                    {workout.durationMinutes != null ? `${workout.durationMinutes} min` : 'Duration n/a'}
                    {workout.intensity ? ` · ${workout.intensity}` : ''}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Category sections */}
      {METRIC_CATEGORIES.map(category => (
        <div key={category.id} ref={el => sectionRefs.current[category.id] = el}>
          <HealthCategorySection
            category={category}
            from={from}
            to={to}
            expanded={expandedSections.has(category.id)}
            onToggle={() => toggleSection(category.id)}
            availableMetrics={availableMetrics}
          />
        </div>
      ))}

      {/* Correlation charts */}
      {correlationData && (
        <div className="space-y-6 pt-2">
          <ActivityBloodCorrelation data={correlationData} range={range} />
        </div>
      )}
    </div>
  );
}
