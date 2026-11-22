import { useEffect, useState } from 'react';
import { Navigate, useLocation, useNavigate, useParams, useSearchParams } from 'react-router';
import { FileText, RefreshCw } from 'lucide-react';
import useContainerWidth from '../hooks/useContainerWidth';
import SettingsTabsHeader from '../components/settings/SettingsTabsHeader';
import PageHeader from '../components/PageHeader';
import TabPills from '../components/ui/TabPills';
import InlineConfirmRow from '../components/ui/InlineConfirmRow';
import StagesEditor from '../components/prompts/StagesEditor';
import VariablesEditor from '../components/prompts/VariablesEditor';
import JobSkillsEditor from '../components/prompts/JobSkillsEditor';
import AgentSkillsEditor from '../components/prompts/AgentSkillsEditor';
import { PROMPT_TABS, canonicalPromptsUrl } from '../components/prompts/promptTabs';

const EDITORS = {
  stages: StagesEditor,
  variables: VariablesEditor,
  'job-skills': JobSkillsEditor,
  'agent-skills': AgentSkillsEditor,
};

// The page keeps catalogue and editor side by side only while its own content
// box (not the viewport — the sidebar takes a variable share) leaves the
// catalogue column a usable width. Below it the selected editor leads and the
// catalogue moves behind a Drawer (#11142). 0 = not measured yet / no
// ResizeObserver, which renders the side-by-side layout.
const SPLIT_PANE_MIN_WIDTH = 720;

export default function PromptManager() {
  const { tab } = useParams();
  const { search, hash, state } = useLocation();
  const canonical = canonicalPromptsUrl(tab, search, hash);
  if (canonical) return <Navigate to={canonical} state={state} replace />;
  return <PromptManagerTabs tab={tab} />;
}

function PromptManagerTabs({ tab }) {
  const navigate = useNavigate();
  const { search } = useLocation();
  const [searchParams] = useSearchParams();
  // Bumped by Reload; each editor re-reads its own catalogues on change.
  const [reloadKey, setReloadKey] = useState(0);
  // The active editor reports the label of a record holding unsaved edits (or
  // null). Switching tabs unmounts that editor, so a dirty one must be
  // confirmed away first, the same way a record switch is.
  const [dirtyLabel, setDirtyLabel] = useState(null);
  const [pendingTab, setPendingTab] = useState(null);
  // The scroll box is measured (see SPLIT_PANE_MIN_WIDTH) and reset to the top
  // when a record opens, so a narrow layout lands on the editor, not the
  // scrolled-away catalogue.
  const [pageRef, pageWidth] = useContainerWidth();
  const splitPane = pageWidth === 0 || pageWidth >= SPLIT_PANE_MIN_WIDTH;
  const stage = searchParams.get('stage');
  const variable = searchParams.get('var');
  const skill = searchParams.get('skill');
  const agentSkill = searchParams.get('agentSkill');

  // Opening a record lands on its editor. In the narrow layout the catalogue
  // that was scrolled through unmounts and the editor takes its place; without
  // this the scroll offset of the old, longer content can be kept.
  useEffect(() => {
    pageRef.current?.scrollTo?.({ top: 0 });
  }, [pageRef, tab, stage, variable, skill, agentSkill]);

  // A clean editor has nothing to discard, so the question goes once the edit
  // is undone or saved.
  useEffect(() => {
    if (!dirtyLabel) setPendingTab(null);
  }, [dirtyLabel]);

  // The tab is a view toggle, so it replaces history; each tab's open record
  // (`?stage=` / `?var=` / `?skill=` / `?agentSkill=`) rides along so a round-trip restores it.
  const switchTab = (next) => {
    setPendingTab(null);
    navigate(`/prompts/${next}${search}`, { replace: true });
  };
  const requestTab = (next) => {
    if (next === tab) { setPendingTab(null); return; }
    if (dirtyLabel) { setPendingTab(next); return; }
    switchTab(next);
  };

  const Editor = EDITORS[tab];
  const pendingTabLabel = PROMPT_TABS.find((t) => t.id === pendingTab)?.label;

  return (
    <div className="flex flex-col h-full">
      <PageHeader
        icon={FileText}
        title="Prompt Manager"
        subtitle="Customize AI prompts for backend operations"
        actions={(
          <button
            onClick={() => setReloadKey((k) => k + 1)}
            className="pointer-coarse:min-h-11 pointer-coarse:min-w-11 p-2 text-gray-400 hover:text-white"
            title="Reload" aria-label="Reload"
          >
            <RefreshCw size={20} />
          </button>
        )}
      />

      <SettingsTabsHeader activeTab="prompts" />

      <div ref={pageRef} className="flex-1 overflow-auto p-4">
        <TabPills
          tabs={PROMPT_TABS}
          activeTab={tab}
          onChange={requestTab}
          ariaLabel="Prompt sections"
          className="mb-6"
        />
        {pendingTab && dirtyLabel && (
          <InlineConfirmRow
            className="mb-4 rounded-lg"
            question={`Discard unsaved changes to "${dirtyLabel}" and open ${pendingTabLabel}?`}
            confirmText="Discard"
            cancelText="Keep editing"
            aria-label={`Confirm discarding unsaved changes to ${dirtyLabel}`}
            autoFocus
            onConfirm={() => switchTab(pendingTab)}
            onCancel={() => setPendingTab(null)}
          />
        )}
        <Editor splitPane={splitPane} reloadKey={reloadKey} onDirtyChange={setDirtyLabel} />
      </div>
    </div>
  );
}
