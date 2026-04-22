import { useState, useEffect } from 'react';
import { ChevronDown, ChevronRight, Dna, Heart, HeartPulse, Zap, Activity, TestTube, Droplet, Droplets, Sun, Leaf, Sparkles, Apple, Coffee, Shield, ShieldCheck, ShieldAlert, Flame, Brain, BrainCog, Moon, Dumbbell, Salad, Eye, Bone, Pill, Ribbon, Wind, Scissors, Ear } from 'lucide-react';
import { Link } from 'react-router-dom';
import { getGenomeHealthCorrelations } from '../../services/api';
import InsightCard from './InsightCard';
import ConfidenceBadge from './ConfidenceBadge';
import ProvenancePanel from './ProvenancePanel';
import EmptyState from './EmptyState';

// Map string icon names from server to Lucide components
const ICON_MAP = {
  Heart, HeartPulse, Zap, Activity, TestTube, Droplet, Droplets, Sun, Leaf, Dna,
  Sparkles, Apple, Coffee, Shield, ShieldCheck, ShieldAlert, Flame, Brain, BrainCog,
  Moon, Dumbbell, Salad, Eye, Bone, Pill, Ribbon, Wind, Scissors, Ear
};

// Server sends single-word Tailwind color names; map to class with shade
const COLOR_CLASS_MAP = {
  rose: 'text-rose-400', red: 'text-red-400', purple: 'text-purple-400',
  blue: 'text-blue-400', emerald: 'text-emerald-400', amber: 'text-amber-400',
  green: 'text-green-400', orange: 'text-orange-400', indigo: 'text-indigo-400',
  cyan: 'text-cyan-400', violet: 'text-violet-400', sky: 'text-sky-400',
  yellow: 'text-yellow-400', lime: 'text-lime-400', pink: 'text-pink-400',
  teal: 'text-teal-400', stone: 'text-stone-400', fuchsia: 'text-fuchsia-400',
  slate: 'text-slate-400', zinc: 'text-zinc-400', gray: 'text-gray-400'
};

// Fallback status→level mapping (used when server omits confidence.level).
// The server's polarity-aware `confidence` object is preferred.
const STATUS_TO_LEVEL = {
  beneficial: 'strong',
  typical: 'moderate',
  concern: 'weak',
  major_concern: 'significant',
  not_found: 'unknown',
  unknown: 'unknown'
};

// Short, neutral label fallback. Server sends polarity-aware labels in confidence.label.
const STATUS_LABEL_FALLBACK = {
  beneficial: 'Beneficial',
  typical: 'Typical',
  concern: 'Concern',
  major_concern: 'Major Concern',
  not_found: 'Not Found'
};

const NEUTRAL_GENOTYPE_STYLE = 'border-gray-600 bg-gray-800/60 text-gray-400';
const GENOTYPE_COLOR_BY_STATUS = {
  beneficial:    'border-green-500/30 bg-green-500/10 text-green-300',
  typical:       'border-yellow-500/30 bg-yellow-500/10 text-yellow-300',
  concern:       'border-orange-500/30 bg-orange-500/10 text-orange-300',
  major_concern: 'border-red-500/40 bg-red-500/10 text-red-300'
};

function genotypeStyleFor(status, polarity) {
  // Protective-marker "concern" means "lacks beneficial variant" — render neutral, not orange.
  if (polarity === 'protective' && (status === 'concern' || status === 'major_concern')) {
    return NEUTRAL_GENOTYPE_STYLE;
  }
  return GENOTYPE_COLOR_BY_STATUS[status] ?? NEUTRAL_GENOTYPE_STYLE;
}

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
          <Icon size={18} className={COLOR_CLASS_MAP[category.color] ?? 'text-port-accent'} />
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
  // `implications` can arrive as either a per-status map (legacy) or a pre-resolved string.
  const implications = typeof marker.implications === 'string'
    ? marker.implications
    : (marker.implications?.[marker.status] ?? null);

  const badgeLabel = marker.confidence?.label ?? STATUS_LABEL_FALLBACK[marker.status] ?? marker.status;
  const isProtective = marker.polarity === 'protective';
  const genotypeStyle = genotypeStyleFor(marker.status, marker.polarity);

  return (
    <InsightCard
      title={marker.name ?? marker.rsid}
      subtitle={marker.gene ? `Gene: ${marker.gene}` : marker.rsid}
      badge={
        <ConfidenceBadge
          level={marker.confidence?.level ?? level}
          label={badgeLabel}
        />
      }
    >
      {/* Your result: genotype pill + one-line status */}
      <div className="flex items-center gap-2 mt-2">
        <span className="text-[10px] text-gray-500 uppercase tracking-wide font-medium">
          Your result
        </span>
        {marker.genotype ? (
          <span className={`font-mono text-xs font-bold px-2 py-0.5 rounded border ${genotypeStyle}`}>
            {marker.genotype}
          </span>
        ) : (
          <span className="text-xs text-gray-500 italic">not in dataset</span>
        )}
        {isProtective && (
          <span
            className="text-[10px] text-gray-500 italic"
            title="This marker flags a rare beneficial variant. Not carrying it means standard (typical) — no elevated risk."
          >
            protective variant
          </span>
        )}
      </div>

      {marker.description && (
        <p className="text-xs text-gray-400 mt-2 leading-relaxed">{marker.description}</p>
      )}

      {implications && implications !== marker.description && (
        <p className="text-xs text-gray-300 mt-2 leading-relaxed">
          <span className="text-gray-500">What this means: </span>
          {implications}
        </p>
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
