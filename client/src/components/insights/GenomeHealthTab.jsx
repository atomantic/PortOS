import { useState, useEffect } from 'react';
import { ChevronDown, ChevronRight, Dna, Heart, Zap, Activity, TestTube, Droplets, Sun, Leaf } from 'lucide-react';
import { Link } from 'react-router-dom';
import { getGenomeHealthCorrelations } from '../../services/api';
import InsightCard from './InsightCard';
import ConfidenceBadge from './ConfidenceBadge';
import ProvenancePanel from './ProvenancePanel';
import EmptyState from './EmptyState';

// Map string icon names from server to Lucide components
const ICON_MAP = {
  Heart,
  Zap,
  Activity,
  TestTube,
  Droplets,
  Sun,
  Leaf,
  Dna
};

// Map marker status to confidence level key
const STATUS_TO_LEVEL = {
  elevated_risk: 'significant',
  moderate_risk: 'moderate',
  typical: 'strong',
  protective: 'strong',
  unknown: 'unknown'
};

function CategorySection({ category }) {
  const [expanded, setExpanded] = useState(true);
  const Icon = ICON_MAP[category.icon] ?? Dna;

  return (
    <div className="border border-port-border rounded-lg overflow-hidden">
      <button
        onClick={() => setExpanded(prev => !prev)}
        className="w-full flex items-center justify-between px-4 py-3 bg-port-card hover:bg-port-border/20 transition-colors"
      >
        <div className="flex items-center gap-3">
          <Icon size={18} className={category.color ? `text-${category.color}` : 'text-port-accent'} />
          <span className="text-sm font-semibold text-white">{category.label}</span>
          <span className="text-xs text-gray-500 bg-gray-800 px-2 py-0.5 rounded-full">
            {category.markers.length} markers
          </span>
          {category.notFoundCount > 0 && (
            <span className="text-xs text-gray-600">
              ({category.notFoundCount} not in dataset)
            </span>
          )}
        </div>
        {expanded ? <ChevronDown size={16} className="text-gray-500" /> : <ChevronRight size={16} className="text-gray-500" />}
      </button>

      {expanded && (
        <div className="p-4 grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-3 bg-port-bg/50">
          {category.markers.map((marker) => (
            <MarkerCard key={marker.rsid} marker={marker} />
          ))}
        </div>
      )}
    </div>
  );
}

function MarkerCard({ marker }) {
  const level = STATUS_TO_LEVEL[marker.status] ?? 'unknown';
  const implications = marker.implications?.[marker.status] ?? marker.description;

  return (
    <InsightCard
      title={marker.name ?? marker.rsid}
      subtitle={marker.gene ? `Gene: ${marker.gene}` : marker.rsid}
      badge={
        <ConfidenceBadge
          level={marker.confidence?.level ?? level}
          label={marker.confidence?.label ?? marker.status}
        />
      }
    >
      {marker.description && (
        <p className="text-xs text-gray-400 mt-2 leading-relaxed">{marker.description}</p>
      )}

      {implications && implications !== marker.description && (
        <p className="text-xs text-gray-500 mt-1 italic leading-relaxed">{implications}</p>
      )}

      {/* Matched blood values */}
      <div className="mt-3">
        {marker.matchedBloodValues && marker.matchedBloodValues.length > 0 ? (
          <div className="space-y-1">
            <p className="text-[10px] text-gray-600 uppercase tracking-wide font-medium">Blood data</p>
            {marker.matchedBloodValues.map((bv, i) => (
              <div key={i} className="flex items-center justify-between text-xs">
                <span className="text-gray-400">{bv.analyte}</span>
                <span className="text-gray-300 font-medium">
                  {bv.value} {bv.unit}
                  {bv.date && <span className="text-gray-600 ml-1">({bv.date})</span>}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-xs text-gray-600">
            No blood test on record.{' '}
            <Link to="/meatspace/blood" className="text-port-accent hover:underline">
              Add blood test
            </Link>
          </p>
        )}
      </div>

      <ProvenancePanel references={marker.references} />
    </InsightCard>
  );
}

function SkeletonCard() {
  return (
    <div className="bg-port-card border border-port-border rounded-lg p-4 animate-pulse">
      <div className="h-4 bg-gray-700 rounded w-3/4 mb-2" />
      <div className="h-3 bg-gray-800 rounded w-1/2 mb-3" />
      <div className="h-3 bg-gray-800 rounded w-full mb-1" />
      <div className="h-3 bg-gray-800 rounded w-5/6" />
    </div>
  );
}

export default function GenomeHealthTab() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getGenomeHealthCorrelations()
      .then(setData)
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="space-y-4">
        <div className="flex gap-4 mb-6">
          <div className="h-8 bg-gray-800 rounded w-40 animate-pulse" />
          <div className="h-8 bg-gray-800 rounded w-40 animate-pulse" />
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-3">
          {Array.from({ length: 6 }).map((_, i) => <SkeletonCard key={i} />)}
        </div>
      </div>
    );
  }

  if (!data?.available) {
    return (
      <EmptyState
        message="No genome data uploaded yet. Upload your 23andMe or similar raw genome file to see health correlations."
        linkTo="/meatspace/genome"
        linkLabel="Upload Genome"
      />
    );
  }

  return (
    <div className="space-y-4">
      {/* Summary stats */}
      <div className="flex flex-wrap gap-4 text-sm">
        <div className="flex items-center gap-2 bg-port-card border border-port-border rounded-lg px-4 py-2">
          <Dna size={16} className="text-port-accent" />
          <span className="text-gray-400">{data.totalMarkers} markers analyzed</span>
        </div>
        <div className="flex items-center gap-2 bg-port-card border border-port-border rounded-lg px-4 py-2">
          <Activity size={16} className="text-port-success" />
          <span className="text-gray-400">{data.matchedMarkers} matched with blood data</span>
        </div>
        {data.sources && data.sources.length > 0 && (
          <div className="flex items-center gap-2 bg-port-card border border-port-border rounded-lg px-4 py-2">
            <span className="text-gray-500 text-xs">Sources:</span>
            {data.sources.map((src, i) => (
              <span key={i} className="text-xs text-gray-400 bg-gray-800 px-1.5 py-0.5 rounded">{src}</span>
            ))}
          </div>
        )}
      </div>

      {/* Category sections */}
      <div className="space-y-3">
        {data.categories.map((cat) => (
          <CategorySection key={cat.category} category={cat} />
        ))}
      </div>
    </div>
  );
}
