import {
  CHRONOTYPE_FILE,
  LONGEVITY_FILE,
  GOALS_FILE,
  DEFAULT_CHRONOTYPE,
  DEFAULT_LONGEVITY,
  DEFAULT_GOALS,
  loadJSON
} from './store.js';

const INSIGHT_RULES = [
  {
    id: 'caffeine-chronotype',
    category: 'lifestyle',
    evaluate({ chronotype }) {
      if (!chronotype?.caffeineMarkers || !chronotype?.recommendations?.caffeineCutoff) return null;
      const { cyp1a2, ada } = chronotype.caffeineMarkers;
      if (!cyp1a2 && !ada) return null;

      const markers = [cyp1a2?.rsid, ada?.rsid].filter(Boolean);
      const sources = ['genome', 'chronotype'];
      const isSlowMetabolizer = cyp1a2?.status === 'concern' || ada?.status === 'concern';
      const cutoff = chronotype.recommendations.caffeineCutoff;
      const type = chronotype.type || 'intermediate';

      if (isSlowMetabolizer) {
        return {
          severity: 'warning', title: 'Caffeine Sensitivity', markers, sources,
          text: `Your caffeine metabolism markers suggest slower processing. Combined with your ${type} chronotype, cut caffeine by ${cutoff} to protect sleep quality.`
        };
      }

      return {
        severity: 'info', title: 'Caffeine Timing', markers, sources,
        text: `Your caffeine metabolism is typical. With your ${type} chronotype, a ${cutoff} cutoff keeps caffeine from interfering with your sleep window.`
      };
    }
  },

  {
    id: 'mtnr1b-meal-timing',
    category: 'lifestyle',
    evaluate({ chronotype }) {
      const mtnr1b = chronotype?.geneticMarkers?.mtnr1b;
      if (!mtnr1b || mtnr1b.status === 'not_found') return null;

      const cutoff = chronotype?.recommendations?.lastMealCutoff;
      if (!cutoff || mtnr1b.status !== 'concern') return null;

      return {
        severity: 'warning', title: 'Late Eating Risk',
        text: `Your MTNR1B variant (${mtnr1b.genotype}) impairs nighttime glucose handling. Finish eating by ${cutoff} to avoid metabolic disruption during sleep.`,
        markers: [mtnr1b.rsid], sources: ['genome', 'chronotype']
      };
    }
  },

  {
    id: 'chronotype-deep-work',
    category: 'productivity',
    evaluate({ chronotype }) {
      if (!chronotype?.recommendations?.peakFocusStart) return null;
      const { peakFocusStart, peakFocusEnd } = chronotype.recommendations;
      const type = chronotype.type || 'intermediate';
      const confidence = chronotype.confidence ?? 0;
      if (confidence < 0.3) return null;

      return {
        severity: 'info', title: 'Peak Focus Window',
        text: `Your ${type} chronotype (${Math.round(confidence * 100)}% confidence) suggests peak focus between ${peakFocusStart}–${peakFocusEnd}. Schedule demanding cognitive work in this window.`,
        markers: [], sources: ['chronotype']
      };
    }
  },

  {
    id: 'longevity-overview',
    category: 'health',
    evaluate({ longevity }) {
      if (!longevity?.derivedAt) return null;
      const { lifeExpectancy, confidence } = longevity;
      if (confidence < 0.5) return null;

      const adjustment = (lifeExpectancy?.longevityAdjustment ?? 0) + (lifeExpectancy?.cardiovascularAdjustment ?? 0);
      const direction = adjustment >= 0 ? 'favorable' : 'unfavorable';

      return {
        severity: adjustment >= 0 ? 'success' : 'warning', title: 'Genetic Life Expectancy',
        text: `Your genome markers shift life expectancy by ${adjustment >= 0 ? '+' : ''}${Math.round(adjustment * 10) / 10} years from the ${lifeExpectancy?.baseline ?? 78.5}-year baseline (${direction} overall). Adjusted estimate: ${lifeExpectancy?.adjusted ?? '—'} years.`,
        markers: [], sources: ['genome', 'longevity']
      };
    }
  },

  {
    id: 'inflammation-health-goals',
    category: 'health',
    evaluate({ longevity, goals }) {
      const il6 = longevity?.cardiovascularMarkers?.il6;
      const tnfa = longevity?.cardiovascularMarkers?.tnfa;
      if (!il6 && !tnfa) return null;
      if (il6?.status !== 'concern' && tnfa?.status !== 'concern') return null;

      const healthGoals = (goals?.goals || []).filter(g => g.category === 'health' && g.status === 'active');
      const concernMarkers = [
        il6?.status === 'concern' ? `IL-6 (${il6.genotype})` : null,
        tnfa?.status === 'concern' ? `TNF-alpha (${tnfa.genotype})` : null
      ].filter(Boolean);

      const goalNote = healthGoals.length > 0
        ? `Your ${healthGoals.length} active health goal${healthGoals.length > 1 ? 's' : ''} align${healthGoals.length === 1 ? 's' : ''} with managing this risk.`
        : 'Consider adding health goals focused on anti-inflammatory lifestyle changes.';

      return {
        severity: 'warning', title: 'Inflammation Risk',
        text: `Elevated inflammation markers: ${concernMarkers.join(', ')}. These increase cardiovascular risk over time. ${goalNote}`,
        markers: [il6?.rsid, tnfa?.rsid].filter(Boolean), sources: ['genome', 'longevity', 'goals']
      };
    }
  },

  {
    id: 'longevity-goal-urgency',
    category: 'goals',
    evaluate({ longevity, goals }) {
      if (!longevity?.timeHorizons?.yearsRemaining) return null;
      const activeGoals = (goals?.goals || []).filter(g => g.status === 'active');
      if (!activeGoals.length) return null;

      const { yearsRemaining, percentLifeComplete } = longevity.timeHorizons;
      const horizonYears = { '1-year': 1, '3-year': 3, '5-year': 5, '10-year': 10, 'lifetime': yearsRemaining };
      const atRiskGoals = activeGoals.filter(g => (horizonYears[g.horizon] ?? 999) > yearsRemaining * 0.8);

      if (!atRiskGoals.length) {
        return {
          severity: 'info', title: 'Goal Timeline',
          text: `At ${Math.round(percentLifeComplete)}% life complete with ~${Math.round(yearsRemaining)} years remaining, all ${activeGoals.length} active goals fit within your projected timeline.`,
          markers: [], sources: ['longevity', 'goals']
        };
      }

      return {
        severity: 'warning', title: 'Goal Timeline Pressure',
        text: `At ${Math.round(percentLifeComplete)}% life complete, ${atRiskGoals.length} goal${atRiskGoals.length > 1 ? 's' : ''} may need reprioritization: ${atRiskGoals.map(g => g.title).join(', ')}. ~${Math.round(yearsRemaining)} estimated years remaining.`,
        markers: [], sources: ['longevity', 'goals']
      };
    }
  },

  {
    id: 'foxo3a-longevity',
    category: 'health',
    evaluate({ longevity }) {
      const foxo3a = longevity?.longevityMarkers?.foxo3a;
      if (!foxo3a || foxo3a.status !== 'concern') return null;

      return {
        severity: 'warning', title: 'FOXO3A Longevity Variant',
        text: `Your FOXO3A variant (${foxo3a.genotype}) is associated with reduced longevity. FOXO3A regulates stress resistance and cellular repair. Caloric moderation, exercise, and stress management can help activate compensatory pathways.`,
        markers: [foxo3a.rsid], sources: ['genome', 'longevity']
      };
    }
  },

  {
    id: 'terc-telomere',
    category: 'health',
    evaluate({ longevity }) {
      const terc = longevity?.longevityMarkers?.terc;
      if (!terc || terc.status !== 'concern') return null;

      return {
        severity: 'warning', title: 'Telomere Length',
        text: `Your TERC variant (${terc.genotype}) is linked to shorter telomere length, a marker of cellular aging. Regular aerobic exercise and stress reduction are associated with slower telomere attrition.`,
        markers: [terc.rsid], sources: ['genome', 'longevity']
      };
    }
  },

  {
    id: 'cardiovascular-protection',
    category: 'health',
    evaluate({ longevity }) {
      if (!longevity?.cardiovascularMarkers) return null;
      const markers = Object.values(longevity.cardiovascularMarkers);
      const beneficial = markers.filter(m => m.status === 'beneficial');
      if (beneficial.length < 2) return null;

      return {
        severity: 'success', title: 'Cardiovascular Protection',
        text: `${beneficial.length} of ${markers.length} cardiovascular markers show protective variants: ${beneficial.map(m => m.gene).join(', ')}. This provides a favorable baseline for heart health.`,
        markers: beneficial.map(m => m.rsid), sources: ['genome', 'longevity']
      };
    }
  }
];

export async function getCrossInsights() {
  const [chronotype, longevity, goalsData] = await Promise.all([
    loadJSON(CHRONOTYPE_FILE, DEFAULT_CHRONOTYPE),
    loadJSON(LONGEVITY_FILE, DEFAULT_LONGEVITY),
    loadJSON(GOALS_FILE, DEFAULT_GOALS)
  ]);

  const context = { chronotype, longevity, goals: goalsData };

  // Rules return partial objects; engine injects id/category from rule definition
  const insights = INSIGHT_RULES
    .map(rule => {
      const result = rule.evaluate(context);
      return result ? { id: rule.id, category: rule.category, ...result } : null;
    })
    .filter(Boolean);

  console.log(`🔮 Cross-insights generated: ${insights.length} insights from ${INSIGHT_RULES.length} rules`);

  return {
    insights,
    generatedAt: new Date().toISOString(),
    dataSources: {
      chronotype: !!chronotype?.derivedAt,
      longevity: !!longevity?.derivedAt,
      goals: (goalsData?.goals || []).length > 0
    }
  };
}
