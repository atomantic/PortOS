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
  const [initialized, setInitialized] = useState(false);
  const sectionRefs = useRef({});

  // Fetch which metrics have data
  useEffect(() => {
    api.getAvailableHealthMetrics()
      .then(metrics => {
        setAvailableMetrics(new Set(metrics.map(m => m.name)));
        // Set initial expanded sections after we know what's available
        const initial = new Set();
        for (const cat of METRIC_CATEGORIES) {
          if (cat.defaultExpanded) initial.add(cat.id);
        }
        if (sectionParam) initial.add(sectionParam);
        setExpandedSections(initial);
        setInitialized(true);
      })
      .catch(() => setInitialized(true));
  }, []);

  // Scroll to section if specified in URL
  useEffect(() => {
    if (sectionParam && initialized) {
      const el = sectionRefs.current[sectionParam];
      if (el) setTimeout(() => el.scrollIntoView({ behavior: 'smooth', block: 'start' }), 100);
    }
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
