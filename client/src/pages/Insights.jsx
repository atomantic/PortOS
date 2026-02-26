import { useState, useEffect } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { Dna, Palette, Link2, Lightbulb, ArrowRight } from 'lucide-react';
import {
  getGenomeHealthCorrelations,
  getInsightThemes,
  getInsightNarrative
} from '../services/api';
import GenomeHealthTab from '../components/insights/GenomeHealthTab';
import TasteIdentityTab from '../components/insights/TasteIdentityTab';
import CrossDomainTab from '../components/insights/CrossDomainTab';
import ConfidenceBadge from '../components/insights/ConfidenceBadge';

const TABS = [
  { id: 'overview', label: 'Overview', icon: Lightbulb },
  { id: 'genome-health', label: 'Genome-Health', icon: Dna },
  { id: 'taste-identity', label: 'Taste & Identity', icon: Palette },
  { id: 'cross-domain', label: 'Cross-Domain Patterns', icon: Link2 }
];

const VALID_TAB_IDS = new Set(TABS.map(t => t.id));

function formatRelativeTime(isoString) {
  if (!isoString) return null;
  const diffMs = Date.now() - new Date(isoString).getTime();
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
}

function SummaryCardSkeleton() {
  return (
    <div className="bg-port-card border border-port-border rounded-lg p-6 animate-pulse">
      <div className="h-5 bg-gray-700 rounded w-2/3 mb-3" />
      <div className="h-8 bg-gray-800 rounded w-1/2 mb-2" />
      <div className="h-3 bg-gray-800 rounded w-full mb-1" />
      <div className="h-3 bg-gray-800 rounded w-4/5" />
    </div>
  );
}

function OverviewTab() {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [genomeData, setGenomeData] = useState(null);
  const [themesData, setThemesData] = useState(null);
  const [narrativeData, setNarrativeData] = useState(null);

  useEffect(() => {
    Promise.allSettled([
      getGenomeHealthCorrelations(),
      getInsightThemes(),
      getInsightNarrative()
    ]).then(([genome, themes, narrative]) => {
      setGenomeData(genome.status === 'fulfilled' ? genome.value : null);
      setThemesData(themes.status === 'fulfilled' ? themes.value : null);
      setNarrativeData(narrative.status === 'fulfilled' ? narrative.value : null);
      setLoading(false);
    });
  }, []);

  if (loading) {
    return (
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <SummaryCardSkeleton />
        <SummaryCardSkeleton />
        <SummaryCardSkeleton />
      </div>
    );
  }

  // Genome-Health card data
  const genomeAvailable = genomeData?.available;
  const topMarker = genomeAvailable
    ? genomeData.categories
        ?.flatMap(c => c.markers)
        .find(m => m.status === 'elevated_risk' || m.status === 'moderate_risk')
    : null;

  // Taste-Identity card data
  const themesAvailable = themesData?.available;
  const firstTheme = themesAvailable ? themesData.themes?.[0] : null;

  // Cross-Domain card data
  const narrativeAvailable = narrativeData?.available;
  const firstSentence = narrativeAvailable
    ? (narrativeData.text ?? '').split(/[.!?]/)[0]?.trim()
    : null;

  const cards = [
    {
      tabId: 'genome-health',
      label: 'Genome-Health',
      icon: Dna,
      iconColor: 'text-port-success',
      stat: genomeAvailable
        ? `${genomeData.totalMarkers} markers analyzed`
        : 'Upload genome to get started',
      topInsight: topMarker
        ? topMarker.name ?? topMarker.rsid
        : genomeAvailable
          ? 'All markers reviewed'
          : 'No genome data uploaded',
      badge: topMarker
        ? <ConfidenceBadge level={topMarker.confidence?.level ?? 'unknown'} label={topMarker.confidence?.label} />
        : null,
      sources: genomeData?.sources ?? []
    },
    {
      tabId: 'taste-identity',
      label: 'Taste & Identity',
      icon: Palette,
      iconColor: 'text-port-warning',
      stat: themesAvailable
        ? `${themesData.themes?.length ?? 0} themes identified`
        : 'Not yet generated',
      topInsight: firstTheme
        ? firstTheme.title
        : themesAvailable
          ? 'Themes loaded'
          : 'Complete taste profile to begin',
      badge: firstTheme
        ? <ConfidenceBadge level={firstTheme.strength === 'tentative' ? 'weak' : firstTheme.strength ?? 'unknown'} label={firstTheme.strength} />
        : null,
      sources: []
    },
    {
      tabId: 'cross-domain',
      label: 'Cross-Domain Patterns',
      icon: Link2,
      iconColor: 'text-port-accent',
      stat: narrativeAvailable
        ? `Last analyzed ${formatRelativeTime(narrativeData.generatedAt)}`
        : 'Not yet generated',
      topInsight: firstSentence
        ? `${firstSentence}.`
        : 'Click Refresh to analyze patterns across all your data',
      badge: null,
      sources: []
    }
  ];

  return (
    <div className="space-y-6">
      <p className="text-sm text-gray-500 max-w-2xl">
        Cross-domain insights surface patterns connecting your genome, health data, and personal identity. Each domain is analyzed independently and then synthesized into a unified narrative.
      </p>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {cards.map(({ tabId, label, icon: Icon, iconColor, stat, topInsight, badge, sources }) => (
          <button
            key={tabId}
            onClick={() => navigate(`/insights/${tabId}`)}
            className="text-left bg-port-card border border-port-border rounded-lg p-6 hover:border-port-accent/50 hover:bg-port-card/80 transition-all group"
          >
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <Icon size={20} className={iconColor} />
                <span className="text-sm font-semibold text-white">{label}</span>
              </div>
              <ArrowRight size={16} className="text-gray-600 group-hover:text-port-accent transition-colors" />
            </div>

            <div className="text-xl font-bold text-white mb-1">{stat}</div>

            <p className="text-xs text-gray-400 leading-relaxed mb-3 line-clamp-2">{topInsight}</p>

            <div className="flex items-center justify-between">
              {badge ?? <span />}
              {sources.length > 0 && (
                <div className="flex gap-1">
                  {sources.map((src, i) => (
                    <span key={i} className="text-[10px] text-gray-600 bg-gray-800 px-1.5 py-0.5 rounded">{src}</span>
                  ))}
                </div>
              )}
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

export default function Insights() {
  const { tab } = useParams();
  const navigate = useNavigate();
  const activeTab = VALID_TAB_IDS.has(tab) ? tab : 'overview';

  const renderTabContent = () => {
    switch (activeTab) {
      case 'overview':
        return <OverviewTab />;
      case 'genome-health':
        return <GenomeHealthTab />;
      case 'taste-identity':
        return <TasteIdentityTab />;
      case 'cross-domain':
        return <CrossDomainTab />;
      default:
        return <OverviewTab />;
    }
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex-shrink-0 px-6 pt-6 pb-4 border-b border-port-border">
        <div className="flex items-center gap-3 mb-4">
          <Lightbulb size={24} className="text-port-accent" />
          <h1 className="text-2xl font-bold text-white">Insights</h1>
          <span className="text-sm text-gray-500">Cross-Domain Intelligence</span>
        </div>

        {/* Tab bar */}
        <div className="flex gap-1 overflow-x-auto">
          {TABS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => navigate(`/insights/${id}`)}
              className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium whitespace-nowrap transition-colors ${
                activeTab === id
                  ? 'bg-port-accent/10 text-port-accent'
                  : 'text-gray-400 hover:text-white hover:bg-port-border/50'
              }`}
            >
              <Icon size={16} />
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-auto p-6">
        {renderTabContent()}
      </div>
    </div>
  );
}
