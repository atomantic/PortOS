import { useRef, useState } from 'react';
import toast from '../components/ui/Toast';
import * as api from '../services/api';
import { applyOrganizationSuggestion } from '../components/goals/applyOrganization';

export function useGoalOrganize(onRefresh) {
  const [organizing, setOrganizing] = useState(false);
  const [orgSuggestion, setOrgSuggestion] = useState(null);
  const [applyingOrg, setApplyingOrg] = useState(false);
  const busy = useRef(false);

  const requestOrganize = async ({ providerId, model }) => {
    if (busy.current) return;
    if (!providerId) { toast.error('No API provider available'); return; }
    busy.current = true;
    setOrganizing(true);
    const result = await api.organizeGoals({ providerId, model }, { silent: true }).catch(() => null);
    busy.current = false;
    setOrganizing(false);
    if (result) setOrgSuggestion(result);
    else toast.error('Failed to organize goals');
  };

  const applySuggestion = async () => {
    if (!orgSuggestion || busy.current) return;
    busy.current = true;
    setApplyingOrg(true);
    const applied = await applyOrganizationSuggestion(orgSuggestion);
    busy.current = false;
    setApplyingOrg(false);
    setOrgSuggestion(null);
    // A failed apply can still have created part of the hierarchy.
    onRefresh();
    if (!applied) { toast.error('Failed to apply goal hierarchy'); return; }
    toast.success('Goal hierarchy applied');
  };

  const dismiss = () => { if (!busy.current) setOrgSuggestion(null); };
  return { organizing, orgSuggestion, applyingOrg, requestOrganize, applySuggestion, dismiss };
}

export function useGoalCreate(onRefresh) {
  const [isCreating, setIsCreating] = useState(false);
  const busy = useRef(false);
  const submit = async (goal) => {
    if (!goal.title.trim() || busy.current) return false;
    busy.current = true;
    setIsCreating(true);
    try {
      await api.createGoal(goal, { silent: true });
      onRefresh();
      return true;
    } catch {
      toast.error('Failed to create goal');
      return false;
    } finally {
      busy.current = false;
      setIsCreating(false);
    }
  };
  return {
    isCreating,
    createGoal: submit,
    quickAddGoal: (title, defaults) => submit({ ...defaults, title: title.trim() }),
  };
}
