// The Prompt Manager's editors and the URL shape that selects one:
// `/prompts/:tab`, with the open record in `?stage=` / `?var=` / `?skill=` /
// `?agentSkill=`.
import { Briefcase, FileText, Sparkles, Variable } from 'lucide-react';

export const PROMPT_TABS = [
  { id: 'stages', label: 'Stages', icon: FileText },
  { id: 'variables', label: 'Variables', icon: Variable },
  { id: 'job-skills', label: 'Job Skills', icon: Briefcase },
  { id: 'agent-skills', label: 'Agent Skills', icon: Sparkles },
];

export const DEFAULT_PROMPT_TAB = 'stages';

export const isPromptTab = (id) => PROMPT_TABS.some((t) => t.id === id);

// The canonical URL for a Prompt Manager location, or null when it already is
// one. `/prompts` and an unknown tab land on Stages, and a pre-route `?tab=`
// link (bookmarks, other installs' copy) moves into the path while every other
// query param — the open record — rides along. A valid path tab wins over a
// stray `?tab=`, which is only ever a leftover from the old shape.
export function canonicalPromptsUrl(tabParam, search = '', hash = '') {
  const params = new URLSearchParams(search);
  if (isPromptTab(tabParam) && !params.has('tab')) return null;
  const legacy = params.get('tab');
  const tab = isPromptTab(tabParam) ? tabParam : isPromptTab(legacy) ? legacy : DEFAULT_PROMPT_TAB;
  params.delete('tab');
  const query = params.toString();
  return `/prompts/${tab}${query ? `?${query}` : ''}${hash}`;
}
