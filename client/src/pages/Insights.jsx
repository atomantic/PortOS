import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router';
import { useValidTab } from '../hooks/useValidTab';
import { Dna, Palette, Link2, Lightbulb, ArrowRight, Target } from 'lucide-react';
import {
  getGenomeHealthCorrelations,
  getInsightThemes,
  getInsightNarrative,
  refreshInsightThemes,
  refreshInsightNarrative
} from '../services/api';
import { useAsyncAction } from '../hooks/useAsyncAction';
import GenomeHealthTab from '../components/insights/GenomeHealthTab';
import TasteIdentityTab from '../components/insights/TasteIdentityTab';
import CrossDomainTab from '../components/insights/CrossDomainTab';
import GoalScorecardTab from '../components/insights/GoalScorecardTab';
import ConfidenceBadge from '../components/insights/ConfidenceBadge';
import PageHeader from '../components/PageHeader';
import TabPills from '../components/ui/TabPills';
import { timeAgo } from '../utils/formatters';

// Exported for the nav-manifest tab-coverage guard (server/lib/navManifest.test.js).
export const TABS = [
  { id: 'overview', label: 'Overview', icon: Lightbulb },
  { id: 'genome-health', label: 'Genome-Health', icon: Dna },
  { id: 'taste-identity', label: 'Taste & Identity', icon: Palette },
  { id: 'cross-domain', label: 'Cross-Domain Patterns', icon: Link2 },
  { id: 'goal-scorecard', label: 'Goal Scorecard', icon: Target }
];

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

export function OverviewTab() {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [genomeData, setGenomeData] = useState(null);
  const [themesData, setThemesData] = useState(null);
  const [narrativeData, setNarrativeData] = useState(null);

  // Empty cards carry the action that produces their content, so the user never
  // has to go hunting for a control the copy names (#3787).
  const [generateThemes, generatingThemes] = useAsyncAction(
    () => refreshInsightThemes(undefined, undefined, { silent: true }).then(setThemesData),
    { errorMessage: 'Failed to generate identity themes' }
  );
  const [analyzePatterns, analyzing] = useAsyncAction(
    () => refreshInsightNarrative(undefined, undefined, { silent: true }).then(setNarrativeData),
    { errorMessage: 'Failed to analyze cross-domain patterns' }
  );

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
  // A missing taste profile is a prerequisite the user fills elsewhere; anything
  // else just means themes haven't been generated from it yet.
  const needsTasteProfile = !themesAvailable && themesData?.reason === 'no_taste_data';

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
          : 'Upload a raw genome file to see which of your markers line up with your blood work.',
      badge: topMarker
        ? <ConfidenceBadge level={topMarker.confidence?.level ?? 'unknown'} label={topMarker.confidence?.label} />
        : null,
      sources: genomeData?.sources ?? [],
      action: genomeAvailable
        ? null
        : { label: 'Upload genome', onClick: () => navigate('/meatspace/genome') }
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
          : needsTasteProfile
            ? 'Answer the taste questionnaire to surface the patterns connecting your aesthetics, media, food, and values.'
            : 'Turn your taste profile into named identity themes you can read across domains.',
      badge: firstTheme
        ? <ConfidenceBadge level={firstTheme.strength === 'tentative' ? 'weak' : firstTheme.strength ?? 'unknown'} label={firstTheme.strength} />
        : null,
      sources: [],
      action: themesAvailable
        ? null
        : needsTasteProfile
          ? { label: 'Complete taste profile', onClick: () => navigate('/digital-twin/taste') }
          : {
            label: generatingThemes ? 'Generating…' : 'Generate themes',
            onClick: generateThemes,
            disabled: generatingThemes
          }
    },
    {
      tabId: 'cross-domain',
      label: 'Cross-Domain Patterns',
      icon: Link2,
      iconColor: 'text-port-accent',
      stat: narrativeAvailable
        ? `Last analyzed ${timeAgo(narrativeData.generatedAt)}`
        : 'Not yet generated',
      topInsight: firstSentence
        ? `${firstSentence}.`
        : 'Synthesize your genome, health, and taste data into one connected narrative.',
      badge: null,
      sources: [],
      action: narrativeAvailable
        ? null
        : {
          label: analyzing ? 'Analyzing…' : 'Analyze now',
          onClick: analyzePatterns,
          disabled: analyzing
        }
    }
  ];

  return (
    <div className="space-y-6">
      <p className="text-sm text-gray-500 max-w-2xl">
        Cross-domain insights surface patterns connecting your genome, health data, and personal identity. Each domain is analyzed independently and then synthesized into a unified narrative.
      </p>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {cards.map(({ tabId, label, icon: Icon, iconColor, stat, topInsight, badge, sources, action }) => (
          <div
            key={tabId}
            className="flex flex-col bg-port-card border border-port-border rounded-lg p-6 hover:border-port-accent/50 transition-all group"
          >
            {/* The summary is the drill-in target; the action below it is a
                separate control, so neither is nested inside the other. */}
            <button
              type="button"
              onClick={() => navigate(`/insights/${tabId}`)}
              className="text-left flex-1"
            >
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2">
                  <Icon size={20} className={iconColor} />
                  <span className="text-sm font-semibold text-white">{label}</span>
                </div>
                <ArrowRight size={16} className="text-gray-600 group-hover:text-port-accent transition-colors" />
              </div>

              <div className="text-xl font-bold text-white mb-1">{stat}</div>

              <p className="text-xs text-gray-400 leading-relaxed line-clamp-2">{topInsight}</p>
            </button>

            <div className="flex items-center justify-between mt-3">
              {badge ?? <span />}
              {sources.length > 0 && (
                <div className="flex gap-1">
                  {sources.map((src, i) => (
                    <span key={i} className="text-[10px] text-gray-600 bg-gray-800 px-1.5 py-0.5 rounded">{src}</span>
                  ))}
                </div>
              )}
            </div>

            {action && (
              <button
                type="button"
                onClick={action.onClick}
                disabled={action.disabled}
                className="mt-3 w-full px-3 py-2 rounded-lg text-sm font-medium bg-port-accent/10 text-port-accent hover:bg-port-accent/20 disabled:opacity-50 transition-colors"
              >
                {action.label}
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

export default function Insights() {
  const navigate = useNavigate();
  const activeTab = useValidTab(TABS, 'overview');

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
      case 'goal-scorecard':
        return <GoalScorecardTab />;
      default:
        return <OverviewTab />;
    }
  };

  return (
    <div className="flex flex-col h-full">
      <PageHeader
        icon={Lightbulb}
        title="Insights"
        subtitle="Cross-Domain Intelligence"
      />

      <TabPills
        tabs={TABS}
        activeTab={activeTab}
        onChange={(id) => navigate(`/insights/${id}`)}
        ariaLabel="Insights sections"
      />

      {/* Tab content */}
      <div className="flex-1 overflow-auto p-6">
        {renderTabContent()}
      </div>
    </div>
  );
}
