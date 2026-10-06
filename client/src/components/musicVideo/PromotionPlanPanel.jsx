import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { CalendarClock, Sparkles } from 'lucide-react';
import useProviderModels from '../../hooks/useProviderModels.js';
import ProviderModelSelector from '../ProviderModelSelector.jsx';
import { getMusicVideoPromotionPlan, planMusicVideoPromotion } from '../../services/apiMusicVideo.js';
import { formatWeekdayTime } from '../../utils/formatters.js';

const inputCls = 'w-full bg-port-bg border border-port-border rounded px-1.5 py-1 text-xs min-h-[44px] sm:min-h-0';
const DAY_CHOICES = [3, 7, 14];

/**
 * Promotion plan: one provider call, asked for here, turns the release into a
 * few dated steps only the artist can take (post a clip, answer replies, join
 * the conversations their audience is having), each with explicit
 * instructions and the exact text to paste. The steps land in Review Hub ›
 * Actions and send a notification when due; PortOS never posts anything.
 */
export default function PromotionPlanPanel({ project }) {
  const projectId = project?.id;
  const [steps, setSteps] = useState(null);
  const [goal, setGoal] = useState('');
  const [audience, setAudience] = useState('');
  const [days, setDays] = useState(7);
  const [planning, setPlanning] = useState(false);
  const {
    providers, selectedProviderId, selectedModel, availableModels, setSelectedProviderId, setSelectedModel,
  } = useProviderModels({ allowDefault: true, silent: true });

  useEffect(() => {
    if (!projectId) return undefined;
    let active = true;
    setSteps(null);
    getMusicVideoPromotionPlan(projectId, { silent: true })
      .then((res) => { if (active) setSteps(res?.steps || []); })
      .catch(() => { if (active) setSteps([]); });
    return () => { active = false; };
  }, [projectId]);

  const plan = () => {
    setPlanning(true);
    planMusicVideoPromotion(projectId, {
      ...(selectedProviderId ? { providerId: selectedProviderId } : {}),
      ...(selectedModel ? { model: selectedModel } : {}),
      ...(goal.trim() ? { goal: goal.trim() } : {}),
      ...(audience.trim() ? { audience: audience.trim() } : {}),
      days,
    })
      .then((res) => { if (res?.created) setSteps(res.created); })
      .catch(() => {})
      .finally(() => setPlanning(false));
  };

  const idFor = (name) => `mv-promo-${name}`;
  return (
    <section aria-label="Promotion plan" className="rounded-lg border border-port-border bg-port-card p-3 space-y-2 text-xs">
      <h3 className="text-sm font-medium flex items-center gap-1.5"><CalendarClock size={14} /> Promotion plan</h3>
      <p className="text-port-text-muted">Schedules the steps only you can take, with the text ready to paste. Each one shows up in <Link to="/review" className="text-port-accent underline">Actions</Link> and notifies you when it&apos;s time. Planning again replaces the open steps.</p>
      <div className="grid gap-2 sm:grid-cols-2">
        <label htmlFor={idFor('goal')} className="space-y-1">
          <span className="text-port-text-muted">What you want (optional)</span>
          <input id={idFor('goal')} value={goal} maxLength={1500} onChange={(e) => setGoal(e.target.value)}
            placeholder="More people seeing it, more followers" className={inputCls} />
        </label>
        <label htmlFor={idFor('audience')} className="space-y-1">
          <span className="text-port-text-muted">Who to reach (optional)</span>
          <input id={idFor('audience')} value={audience} maxLength={1000} onChange={(e) => setAudience(e.target.value)}
            placeholder="People into AI consciousness" className={inputCls} />
        </label>
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <label htmlFor={idFor('days')} className="space-y-1">
          <span className="block text-port-text-muted">Over</span>
          <select id={idFor('days')} value={days} onChange={(e) => setDays(Number(e.target.value))} className={inputCls}>
            {DAY_CHOICES.map((n) => <option key={n} value={n}>{n} days</option>)}
          </select>
        </label>
        {providers.length > 0 && (
          <ProviderModelSelector providers={providers} selectedProviderId={selectedProviderId} selectedModel={selectedModel}
            availableModels={availableModels} onProviderChange={setSelectedProviderId} onModelChange={setSelectedModel}
            label="Planner" compact alwaysShowModel modelDisabled={availableModels.length === 0}
            emptyProviderOption="Active provider (default)" emptyModelOption="Default model" disabled={planning} />
        )}
        <button type="button" onClick={plan} disabled={planning || !projectId}
          className="flex items-center gap-1 bg-port-accent/20 text-port-accent disabled:opacity-50 rounded px-2 py-1.5 text-xs min-h-[44px] sm:min-h-0">
          <Sparkles size={13} /> {planning ? 'Planning…' : (steps?.length ? 'Plan again' : 'Plan promotion')}
        </button>
      </div>
      {steps?.length > 0 && (
        <ol aria-label="Scheduled steps" className="space-y-1">
          {steps.map((step) => (
            <li key={step.id} className="flex flex-wrap items-baseline gap-x-2">
              <span className="text-port-text-muted whitespace-nowrap">{formatWeekdayTime(step.dueAt)}</span>
              <Link to={`/brain/threads?thread=${encodeURIComponent(step.id)}`} className="text-port-accent underline min-w-0 break-words">{step.title}</Link>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
