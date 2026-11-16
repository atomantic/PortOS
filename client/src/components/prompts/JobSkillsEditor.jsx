// The Prompt Manager's Job Skills tab: the versioned prompt templates that
// recurring autonomous jobs execute.
import { useEffect, useRef, useState } from 'react';
import { Eye, Save } from 'lucide-react';
import toast from '../ui/Toast';
import { FormField } from '../ui/FormField';
import InlineConfirmRow from '../ui/InlineConfirmRow';
import {
  getJobSkills, getJobSkill, saveJobSkill as apiSaveJobSkill, previewJobSkill as apiPreviewJobSkill,
} from '../../services/apiPrompts';
import CatalogueNotice from './CatalogueNotice';
import PromptWorkspace from './PromptWorkspace';
import usePromptCatalogue from './usePromptCatalogue';
import useRecordEditor from './useRecordEditor';
import useSelectionParam from './useSelectionParam';

const EMPTY_SKILLS = Object.freeze([]);
const loadSkills = () => getJobSkills({ silent: true });
const selectSkills = (res) => res.skills || [];
const loadSkill = (name) => getJobSkill(name, { silent: true });

export default function JobSkillsEditor({ splitPane, reloadKey, onDirtyChange }) {
  const [selectedJobSkill, setSelectedJobSkill] = useSelectionParam('skill');
  const catalogue = usePromptCatalogue(loadSkills, selectSkills, EMPTY_SKILLS, reloadKey);
  const jobSkills = catalogue.data;
  const [chooserOpen, setChooserOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [meta, setMeta] = useState({});
  const [preview, setPreview] = useState('');
  const [previewLoading, setPreviewLoading] = useState(false);
  const previewSeqRef = useRef(0);

  const editor = useRecordEditor({
    selected: selectedJobSkill,
    blank: '',
    load: loadSkill,
    hydrate: (res) => {
      setMeta({ jobName: res.jobName, jobId: res.jobId, category: res.category, interval: res.interval });
      return res.content || '';
    },
    onReset: () => {
      setPreview('');
      setPreviewLoading(false);
      previewSeqRef.current++;
      setMeta({});
    },
    noun: 'job skill',
    onSwitch: (name) => switchJobSkill(name),
    onReselect: () => setChooserOpen(false),
  });
  const openLabel = meta.jobName || selectedJobSkill;

  useEffect(() => {
    onDirtyChange?.(editor.dirty ? openLabel : null);
    return () => onDirtyChange?.(null);
  }, [editor.dirty, openLabel, onDirtyChange]);

  // A failed save must say so: the button re-enabling on its own reads as
  // "saved" and the edit is silently lost. `silent: true` + an explicit toast
  // keeps the notification to one layer (see client/src/AGENTS.md).
  const saveJobSkill = async () => {
    if (!editor.ready || saving) return;
    setSaving(true);
    // Snapshot what we actually sent — the textarea may change while the PUT is
    // in flight, and only the persisted text may become the clean baseline.
    const sent = editor.value;
    const sentFor = selectedJobSkill;
    const ok = await apiSaveJobSkill(sentFor, sent, { silent: true })
      .then(() => true)
      .catch((err) => { toast.error(`Failed to save job skill: ${err.message || 'Unknown error'}`); return false; });
    setSaving(false);
    if (!ok) return;
    editor.markSaved(sentFor, sent);
    toast.success('Job skill saved');
  };

  // Cleared in the same tick as the selection (#3939).
  const switchJobSkill = (name) => {
    setChooserOpen(false);
    editor.reset();
    setSelectedJobSkill(name);
  };

  const previewJobSkill = async () => {
    if (!editor.ready || saving) return;
    const previewFor = selectedJobSkill;
    const seq = ++previewSeqRef.current;
    setPreviewLoading(true);
    const res = await apiPreviewJobSkill(previewFor, { silent: true })
      .catch((err) => { toast.error(`Failed to preview: ${err.message || 'Unknown error'}`); return null; });
    if (previewSeqRef.current === seq) setPreviewLoading(false);
    if (!res) return;
    // A preview that lands after the user moved on belongs to the previous
    // skill — rendering it under the new one's heading would misattribute it.
    if (previewFor !== editor.liveRef.current.selected) return;
    if (previewSeqRef.current !== seq) return;
    setPreview(res.preview || '');
  };

  const skillCatalogue = (
    <>
      <div className="mb-3">
        <h3 className="text-sm font-medium text-gray-400">Autonomous Job Skills</h3>
        <p className="text-xs text-gray-500 mt-1">Versioned prompt templates for recurring jobs</p>
      </div>
      {catalogue.failed && (
        <CatalogueNotice label="Job skills" stale={catalogue.loaded} onRetry={catalogue.reload} />
      )}
      <div className="space-y-1">
        {jobSkills.map((skill) => (
          editor.isPending(skill.name) ? (
            <InlineConfirmRow
              key={skill.name}
              className="rounded-lg"
              question={`Discard unsaved changes to "${openLabel}"?`}
              confirmText="Discard"
              cancelText="Keep editing"
              aria-label={`Confirm discarding unsaved changes to ${openLabel}`}
              autoFocus
              onConfirm={() => switchJobSkill(skill.name)}
              onCancel={editor.cancelPending}
            />
          ) : (
            <button
              key={skill.name}
              onClick={() => editor.request(skill.name)}
              className={`w-full text-left px-3 py-2 rounded-lg text-sm ${
                selectedJobSkill === skill.name
                  ? 'bg-port-accent/20 text-port-accent'
                  : 'text-gray-300 hover:bg-port-border'
              }`}
            >
              <div className="flex items-center gap-1">
                <span className="font-medium">{skill.name}</span>
                {skill.hasTemplate && (
                  <span className="shrink-0 text-[10px] px-1.5 py-0.5 bg-port-success/20 text-port-success rounded uppercase font-semibold">
                    Active
                  </span>
                )}
                {selectedJobSkill === skill.name && editor.dirty && (
                  <span className="shrink-0 text-[10px] px-1.5 py-0.5 bg-port-warning/20 text-port-warning rounded uppercase font-semibold">
                    Unsaved
                  </span>
                )}
              </div>
              <div className="text-xs text-gray-500">{skill.jobId}</div>
            </button>
          )
        ))}
        {jobSkills.length === 0 && !catalogue.failed && (
          <div className="text-sm text-gray-500 px-3 py-2">No job skill templates found</div>
        )}
      </div>
    </>
  );

  const skillEditor = selectedJobSkill ? (
    <>
      <div className="bg-port-card border border-port-border rounded-xl p-4 @container">
        <div className="flex flex-col gap-3 mb-4 @sm:flex-row @sm:items-start @sm:justify-between">
          <div className="min-w-0 @sm:flex-1">
            <h3 className="break-words text-lg font-medium text-white">{openLabel}</h3>
            <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-gray-500 [overflow-wrap:anywhere]">
              {meta.category && <span>Category: {meta.category}</span>}
              {meta.interval && <span>Interval: {meta.interval}</span>}
              {meta.jobId && <span>ID: {meta.jobId}</span>}
              {editor.dirty && <span className="text-port-warning">Unsaved changes</span>}
            </div>
          </div>
          <div className="flex w-full max-w-full flex-wrap gap-2 @sm:w-auto @sm:shrink-0">
            <button
              onClick={previewJobSkill}
              disabled={!editor.ready || saving || previewLoading}
              className="flex items-center gap-1 px-3 py-1 text-sm bg-port-border hover:bg-port-border/80 text-white rounded disabled:opacity-50"
            >
              <Eye size={14} /> Preview
            </button>
            <button
              onClick={saveJobSkill}
              disabled={!editor.ready || saving}
              className="flex items-center gap-1 px-3 py-1 text-sm bg-port-accent hover:bg-port-accent/80 text-white rounded disabled:opacity-50"
            >
              <Save size={14} /> Save
            </button>
          </div>
        </div>

        {!editor.ready && (
          <div role={editor.readFailed ? 'alert' : 'status'} className="mb-4 text-sm text-gray-400">
            {editor.readFailed ? (
              <>Failed to load job skill: {editor.read.error}{' '}
                <button onClick={editor.retryRead} className="text-port-accent hover:underline">Retry</button>
              </>
            ) : 'Loading job skill details…'}
          </div>
        )}
        <FormField label="Skill Template (Markdown)">
          <textarea
            disabled={!editor.ready}
            value={editor.value}
            onChange={(e) => editor.setValue(e.target.value)}
            className="w-full h-96 px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white font-mono text-sm focus:border-port-accent focus:outline-hidden"
          />
          <p className="text-xs text-gray-500 mt-1">
            Sections: ## Prompt Template, ## Steps, ## Expected Outputs, ## Success Criteria
          </p>
        </FormField>
      </div>

      {preview && (
        <div className="bg-port-card border border-port-border rounded-xl p-4">
          <h4 className="text-sm font-medium text-gray-400 mb-2">Effective Prompt Preview</h4>
          <pre className="text-sm text-gray-300 whitespace-pre-wrap break-words bg-port-bg p-3 rounded max-h-64 overflow-auto">
            {preview}
          </pre>
        </div>
      )}
    </>
  ) : (
    <div className="bg-port-card border border-port-border rounded-xl p-12 text-center text-gray-500">
      <p>Select a job skill to edit its prompt template</p>
      <p className="text-xs mt-2">These templates define how recurring autonomous jobs execute</p>
    </div>
  );

  return (
    <PromptWorkspace
      splitPane={splitPane}
      loading={!catalogue.settled}
      catalogue={skillCatalogue}
      editor={skillEditor}
      active={Boolean(selectedJobSkill)}
      noun="job skill"
      title="Autonomous Job Skills"
      chooserOpen={chooserOpen}
      onChooserOpenChange={setChooserOpen}
    />
  );
}
