import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Beer, Scale, HeartPulse, Dna, Eye, Dumbbell, Database, Rocket } from 'lucide-react';
import * as api from '../../../services/api';
import { useDeathClock } from '../../../hooks/useDeathClock';
import BrailleSpinner from '../../BrailleSpinner';

function HealthTile({ icon: Icon, iconColor, label, metrics, onClick }) {
  return (
    <div
      onClick={onClick}
      className={`bg-port-card border border-port-border rounded-lg p-3 ${
        onClick ? 'cursor-pointer hover:border-port-accent/50 transition-colors' : ''
      }`}
    >
      <div className="flex items-center gap-2 mb-2">
        <Icon size={14} className={iconColor} />
        <span className="text-xs font-medium text-gray-400 uppercase tracking-wider">{label}</span>
      </div>
      <div className="space-y-1">
        {metrics.map((m, i) => (
          <div key={i} className="flex justify-between items-center">
            <span className="text-xs text-gray-500">{m.label}</span>
            <span className={`text-xs font-medium ${m.color || 'text-gray-300'}`}>{m.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function CompactCountdown({ deathDate, lifeExpectancy, percentComplete }) {
  const countdown = useDeathClock(deathDate);

  if (!countdown) {
    return <p className="text-gray-500 text-sm">Death clock unavailable. Set birth date in Digital Twin &gt; Goals.</p>;
  }

  if (countdown.expired) {
    return <p className="text-port-error font-bold">Time expired. You&apos;re on borrowed time.</p>;
  }

  const units = [
    { value: countdown.years, label: 'y', color: 'text-port-accent' },
    { value: countdown.months, label: 'mo', color: 'text-purple-400' },
    { value: countdown.weeks, label: 'w', color: 'text-teal-400' },
    { value: countdown.days, label: 'd', color: 'text-port-success' },
    { value: countdown.hours, label: 'h', color: 'text-port-warning' },
    { value: countdown.minutes, label: 'm', color: 'text-orange-400' },
    { value: countdown.seconds, label: 's', color: 'text-port-error' },
  ];

  return (
    <div>
      <h3 className="text-xs font-medium text-gray-400 uppercase tracking-wider mb-2">Time Remaining</h3>
      <div className="flex items-baseline gap-1 flex-wrap mb-3">
        {units.map((u, i) => (
          <span key={i} className="whitespace-nowrap">
            <span className={`text-2xl font-mono font-bold tabular-nums ${u.color}`}>
              {String(u.value).padStart(2, '0')}
            </span>
            <span className="text-xs text-gray-500">{u.label}</span>
            {i < units.length - 1 && <span className="text-gray-600 mx-0.5">:</span>}
          </span>
        ))}
      </div>

      {lifeExpectancy && (
        <p className="text-xs text-gray-400 mb-3">
          SSA: <span className="text-gray-300">{lifeExpectancy.baseline}y</span>
          {' · '}Genome: <span className="text-gray-300">{lifeExpectancy.genomeAdjusted}y</span>
          {' · '}Lifestyle: <span className={lifeExpectancy.lifestyleAdjustment >= 0 ? 'text-port-success' : 'text-port-error'}>
            {lifeExpectancy.lifestyleAdjustment >= 0 ? '+' : ''}{lifeExpectancy.lifestyleAdjustment}y
          </span>
          {' · '}Total: <span className="text-white font-medium">{lifeExpectancy.total}y</span>
        </p>
      )}

      {percentComplete != null && (
        <div>
          <div className="flex justify-between text-xs text-gray-500 mb-1">
            <span>Life progress</span>
            <span>{percentComplete}%</span>
          </div>
          <div className="h-1.5 bg-port-border rounded-full overflow-hidden">
            <div
              className="h-full rounded-full transition-all duration-1000"
              style={{
                width: `${Math.min(100, percentComplete)}%`,
                background: percentComplete > 80 ? '#ef4444' : percentComplete > 60 ? '#f59e0b' : '#3b82f6'
              }}
            />
          </div>
        </div>
      )}
    </div>
  );
}

function CompactLEV({ lev }) {
  if (!lev) return null;
  const { ageAtLEV, yearsToLEV, onTrack, adjustedLifeExpectancy } = lev;
  const margin = Math.round((adjustedLifeExpectancy - ageAtLEV) * 10) / 10;

  return (
    <div>
      <div className="flex items-center gap-2 mb-3">
        <Rocket size={14} className="text-port-accent" />
        <h3 className="text-xs font-medium text-gray-400 uppercase tracking-wider">LEV Tracker</h3>
      </div>

      <div className="mb-3">
        <span className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium ${
          onTrack ? 'bg-port-success/10 text-port-success' : 'bg-port-error/10 text-port-error'
        }`}>
          <span className={`w-1.5 h-1.5 rounded-full ${onTrack ? 'bg-port-success' : 'bg-port-error'}`} />
          {onTrack ? 'On Track' : 'At Risk'}
        </span>
      </div>

      <div className="space-y-1.5">
        <div className="flex justify-between">
          <span className="text-xs text-gray-500">Years to LEV</span>
          <span className="text-sm font-bold text-white">{yearsToLEV}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-xs text-gray-500">Age at LEV</span>
          <span className="text-sm font-bold text-white">{ageAtLEV}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-xs text-gray-500">Margin</span>
          <span className={`text-sm font-bold ${onTrack ? 'text-port-success' : 'text-port-error'}`}>
            {onTrack ? '+' : ''}{margin}y
          </span>
        </div>
        <div className="flex justify-between">
          <span className="text-xs text-gray-500">Adjusted LE</span>
          <span className="text-sm font-bold text-white">{adjustedLifeExpectancy}y</span>
        </div>
      </div>
    </div>
  );
}

function riskColor(level) {
  if (level === 'low') return 'text-port-success';
  if (level === 'moderate') return 'text-port-warning';
  return 'text-port-error';
}

export default function OverviewTab() {
  const [data, setData] = useState(null);
  const [alcohol, setAlcohol] = useState(null);
  const [body, setBody] = useState(null);
  const [blood, setBlood] = useState(null);
  const [epigenetic, setEpigenetic] = useState(null);
  const [eyes, setEyes] = useState(null);
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();

  const fetchData = useCallback(async () => {
    const [overview, alc, bod, bld, epi, eye] = await Promise.all([
      api.getMeatspaceOverview().catch(() => null),
      api.getAlcoholSummary().catch(() => null),
      api.getBodyHistory().catch(() => null),
      api.getBloodTests().catch(() => null),
      api.getEpigeneticTests().catch(() => null),
      api.getEyeExams().catch(() => null),
    ]);
    setData(overview);
    setAlcohol(alc);
    setBody(bod);
    setBlood(bld);
    setEpigenetic(epi);
    setEyes(eye);
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 60000);
    return () => clearInterval(interval);
  }, [fetchData]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <BrailleSpinner text="Loading" />
      </div>
    );
  }

  if (!data) {
    return <p className="text-gray-500">Failed to load overview data.</p>;
  }

  const { deathClock, lev, summary } = data;
  const latestBody = Array.isArray(body) ? body[body.length - 1] : null;
  const latestBlood = blood?.tests?.[blood.tests.length - 1] ?? null;
  const latestEpigenetic = epigenetic?.tests?.[epigenetic.tests.length - 1] ?? null;
  const latestEye = eyes?.exams?.[eyes.exams.length - 1] ?? null;

  return (
    <div className="space-y-4">
      {/* Row 1 — Hero: Death Clock + LEV */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 bg-port-card border border-port-border rounded-xl p-4">
          {deathClock?.error ? (
            <p className="text-port-warning">{deathClock.error}</p>
          ) : (
            <CompactCountdown
              deathDate={deathClock?.deathDate}
              lifeExpectancy={deathClock?.lifeExpectancy}
              percentComplete={deathClock?.percentComplete}
            />
          )}
        </div>
        <div className="bg-port-card border border-port-border rounded-xl p-4">
          <CompactLEV lev={lev} />
        </div>
      </div>

      {/* Row 2 — Vitals */}
      {deathClock && !deathClock.error && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div className="bg-port-card border border-port-border rounded-lg p-3">
            <span className="text-xs text-gray-500">Current Age</span>
            <p className="text-xl font-bold text-white">{deathClock.ageYears}y</p>
          </div>
          <div className="bg-port-card border border-port-border rounded-lg p-3">
            <span className="text-xs text-gray-500">Years Remaining</span>
            <p className="text-xl font-bold text-port-warning">{deathClock.yearsRemaining}y</p>
          </div>
          <div className="bg-port-card border border-port-border rounded-lg p-3">
            <span className="text-xs text-gray-500">Healthy Years</span>
            <p className="text-xl font-bold text-port-success">{deathClock.healthyYearsRemaining}y</p>
          </div>
        </div>
      )}

      {/* Row 3 — Health Tiles */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <HealthTile
          icon={Beer}
          iconColor="text-amber-400"
          label="Alcohol"
          onClick={() => navigate('/meatspace/alcohol')}
          metrics={[
            { label: 'Today', value: alcohol ? `${alcohol.grams?.today?.toFixed(1) ?? '0'}g` : '—' },
            { label: '7d avg', value: alcohol ? `${alcohol.grams?.avg7day?.toFixed(1) ?? '0'}g` : '—' },
            { label: 'Risk', value: alcohol?.riskLevel ?? '—', color: alcohol ? riskColor(alcohol.riskLevel) : 'text-gray-500' },
          ]}
        />
        <HealthTile
          icon={Scale}
          iconColor="text-blue-400"
          label="Body"
          onClick={() => navigate('/meatspace/blood')}
          metrics={[
            { label: 'Weight', value: latestBody?.weightLbs ? `${latestBody.weightLbs} lbs` : '—' },
            { label: 'Body fat', value: latestBody?.fatPct != null ? `${latestBody.fatPct}%` : '—' },
            { label: 'Muscle', value: latestBody?.musclePct != null ? `${latestBody.musclePct}%` : '—' },
          ]}
        />
        <HealthTile
          icon={HeartPulse}
          iconColor="text-red-400"
          label="Blood"
          onClick={() => navigate('/meatspace/blood')}
          metrics={[
            { label: 'Tests', value: blood?.tests?.length ?? '—' },
            { label: 'Latest', value: latestBlood?.date ?? '—' },
          ]}
        />
        <HealthTile
          icon={Dna}
          iconColor="text-violet-400"
          label="Epigenetic"
          onClick={() => navigate('/meatspace/blood')}
          metrics={[
            { label: 'Bio age', value: latestEpigenetic?.biologicalAge != null ? `${latestEpigenetic.biologicalAge}y` : '—',
              color: latestEpigenetic?.biologicalAge != null && latestEpigenetic?.chronologicalAge != null
                ? (latestEpigenetic.biologicalAge < latestEpigenetic.chronologicalAge ? 'text-port-success' : 'text-port-error')
                : 'text-gray-300' },
            { label: 'Pace', value: latestEpigenetic?.paceOfAging != null ? latestEpigenetic.paceOfAging.toFixed(2) : '—' },
            { label: 'Chrono', value: latestEpigenetic?.chronologicalAge != null ? `${latestEpigenetic.chronologicalAge}y` : '—' },
          ]}
        />
        <HealthTile
          icon={Eye}
          iconColor="text-cyan-400"
          label="Eyes"
          onClick={() => navigate('/meatspace/blood')}
          metrics={[
            { label: 'Exams', value: eyes?.exams?.length ?? '—' },
            { label: 'Latest', value: latestEye?.date ?? '—' },
            { label: 'L SPH', value: latestEye?.leftSphere != null ? latestEye.leftSphere.toFixed(2) : '—' },
          ]}
        />
        <HealthTile
          icon={Dumbbell}
          iconColor="text-orange-400"
          label="Lifestyle"
          onClick={() => navigate('/meatspace/lifestyle')}
          metrics={[
            { label: 'Status', value: summary?.hasLifestyleData ? 'Active' : 'Not Set',
              color: summary?.hasLifestyleData ? 'text-port-success' : 'text-gray-500' },
            { label: 'Diet', value: summary?.hasLifestyleData ? 'Set' : '—' },
            { label: 'Exercise', value: summary?.hasLifestyleData ? 'Set' : '—' },
          ]}
        />
        <HealthTile
          icon={Database}
          iconColor="text-gray-400"
          label="Data"
          metrics={[
            { label: 'Entries', value: summary?.totalEntries ?? '—' },
            { label: 'Last date', value: summary?.lastEntryDate ?? '—' },
            { label: 'Genome', value: summary?.hasGenomeData ? 'Active' : 'Missing',
              color: summary?.hasGenomeData ? 'text-port-success' : 'text-gray-500' },
          ]}
        />
      </div>
    </div>
  );
}
