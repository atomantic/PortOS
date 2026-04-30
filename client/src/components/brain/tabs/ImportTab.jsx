import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {Upload,
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCircle2,
  AlertCircle,
  FileJson,
  ExternalLink,
  X,
  Sparkles} from 'lucide-react';
import * as api from '../../../services/api';
import toast from '../../ui/Toast';
import BrailleSpinner from '../../BrailleSpinner';

// Sources we plan to support. Only `available` ones are clickable.
const SOURCES = [
  {
    id: 'chatgpt',
    label: 'ChatGPT',
    blurb: 'Conversations and projects from chatgpt.com',
    status: 'available'
  },
  {
    id: 'claude',
    label: 'Claude',
    blurb: 'Coming soon — claude.ai conversations',
    status: 'coming-soon'
  },
  {
    id: 'notion',
    label: 'Notion',
    blurb: 'Coming soon — pages and databases',
    status: 'coming-soon'
  },
  {
    id: 'obsidian',
    label: 'Obsidian',
    blurb: 'Already supported via Brain → Notes',
    status: 'see-other',
    href: '/brain/notes'
  }
];

const STEPS = [
  { id: 'instructions', label: 'Get your data' },
  { id: 'upload', label: 'Upload' },
  { id: 'preview', label: 'Preview' },
  { id: 'configure', label: 'Configure' },
  { id: 'run', label: 'Import' },
  { id: 'done', label: 'Done' }
];

const formatBytes = (bytes) => {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i += 1; }
  return `${n.toFixed(n < 10 ? 1 : 0)} ${units[i]}`;
};

const formatDate = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
};

export default function ImportTab() {
  const navigate = useNavigate();
  const [source, setSource] = useState(null);

  if (!source) {
    return <SourcePicker onPick={setSource} navigate={navigate} />;
  }
  if (source === 'chatgpt') {
    return <ChatGPTWizard onExit={() => setSource(null)} navigate={navigate} />;
  }
  return null;
}

function SourcePicker({ onPick, navigate }) {
  return (
    <div className="max-w-4xl mx-auto">
      <div className="mb-6">
        <h2 className="text-lg font-semibold text-white flex items-center gap-2">
          <Sparkles size={20} className="text-port-accent" aria-hidden="true" />
          Import from a third-party source
        </h2>
        <p className="text-sm text-gray-400 mt-1">
          Bring conversations, notes, and history from other tools into your second brain.
          Each source has a guided step-by-step wizard.
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {SOURCES.map((s) => {
          const available = s.status === 'available';
          const seeOther = s.status === 'see-other';
          const onClick = available
            ? () => onPick(s.id)
            : seeOther
              ? () => navigate(s.href)
              : undefined;
          return (
            <button
              key={s.id}
              onClick={onClick}
              disabled={!available && !seeOther}
              className={`text-left p-4 rounded-lg border transition-colors min-h-[80px] flex flex-col justify-between
                ${available
                  ? 'bg-port-card border-port-border hover:border-port-accent hover:bg-port-card/70'
                  : seeOther
                    ? 'bg-port-card border-port-border hover:border-port-accent/50'
                    : 'bg-port-card/50 border-port-border opacity-60 cursor-not-allowed'}`}
            >
              <div className="flex items-center justify-between">
                <span className="font-medium text-white">{s.label}</span>
                {available && (
                  <span className="text-xs px-2 py-0.5 rounded bg-port-accent/20 text-port-accent">Available</span>
                )}
                {s.status === 'coming-soon' && (
                  <span className="text-xs px-2 py-0.5 rounded bg-port-warning/20 text-port-warning">Soon</span>
                )}
                {seeOther && (
                  <ExternalLink size={14} className="text-gray-400" aria-hidden="true" />
                )}
              </div>
              <p className="text-xs text-gray-400 mt-2">{s.blurb}</p>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function ChatGPTWizard({ onExit, navigate }) {
  const [stepIdx, setStepIdx] = useState(0);
  const [parsedRaw, setParsedRaw] = useState(null);   // the original parsed JSON from the file
  const [preview, setPreview] = useState(null);
  const [fileMeta, setFileMeta] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [tagsInput, setTagsInput] = useState('chatgpt-import');
  const [skipEmpty, setSkipEmpty] = useState(true);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const fileInputRef = useRef(null);

  const step = STEPS[stepIdx];
  const goNext = () => setStepIdx((i) => Math.min(i + 1, STEPS.length - 1));
  const goBack = () => setStepIdx((i) => Math.max(i - 1, 0));

  const handleFile = async (file) => {
    if (!file) return;
    if (!/\.json$/i.test(file.name)) {
      setError('Please select the conversations.json file from your ChatGPT export.');
      return;
    }
    if (file.size > 50 * 1024 * 1024) {
      setError(`File is ${formatBytes(file.size)}, larger than the 50 MB upload limit. See instructions for splitting the file.`);
      return;
    }
    setError(null);
    setUploading(true);
    setFileMeta({ name: file.name, size: file.size });

    const text = await file.text();
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      setError(`Could not parse JSON: ${err.message}`);
      setUploading(false);
      return;
    }

    const res = await api.previewChatgptImport(parsed).catch((err) => ({ error: err.message }));
    setUploading(false);
    if (res?.error || !res?.ok) {
      setError(res?.error || 'Server rejected the upload.');
      return;
    }
    setParsedRaw(parsed);
    setPreview(res);
    goNext();
  };

  const runImport = async () => {
    if (!parsedRaw) return;
    setImporting(true);
    setError(null);
    const tags = tagsInput
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
    const res = await api.runChatgptImport(parsedRaw, { tags, skipEmpty }).catch((err) => ({ error: err.message }));
    setImporting(false);
    if (res?.error || !res?.ok) {
      setError(res?.error || 'Import failed.');
      return;
    }
    setResult(res);
    toast.success(`Imported ${res.imported} conversation${res.imported === 1 ? '' : 's'} into Memory`);
    setStepIdx(STEPS.findIndex((s) => s.id === 'done'));
  };

  return (
    <div className="max-w-4xl mx-auto">
      <Header onExit={onExit} />
      <Stepper steps={STEPS} activeIdx={stepIdx} />
      {error && (
        <div className="mb-4 p-3 rounded border border-port-error/30 bg-port-error/10 text-sm text-port-error flex items-start gap-2">
          <AlertCircle size={16} className="mt-0.5 flex-shrink-0" aria-hidden="true" />
          <span>{error}</span>
          <button className="ml-auto text-gray-400 hover:text-white" onClick={() => setError(null)} aria-label="Dismiss">
            <X size={14} />
          </button>
        </div>
      )}

      {step.id === 'instructions' && <StepInstructions onNext={goNext} />}

      {step.id === 'upload' && (
        <StepUpload
          uploading={uploading}
          fileMeta={fileMeta}
          onPick={() => fileInputRef.current?.click()}
          onFile={handleFile}
          fileInputRef={fileInputRef}
          onBack={goBack}
        />
      )}

      {step.id === 'preview' && preview && (
        <StepPreview preview={preview} fileMeta={fileMeta} onNext={goNext} onBack={goBack} />
      )}

      {step.id === 'configure' && (
        <StepConfigure
          tagsInput={tagsInput}
          setTagsInput={setTagsInput}
          skipEmpty={skipEmpty}
          setSkipEmpty={setSkipEmpty}
          onBack={goBack}
          onNext={() => { setStepIdx(STEPS.findIndex((s) => s.id === 'run')); runImport(); }}
        />
      )}

      {step.id === 'run' && (
        <div className="text-center py-12">
          <BrailleSpinner />
          <p className="text-white">Importing conversations into Memory…</p>
          <p className="text-xs text-gray-500 mt-1">
            {importing ? 'Don\'t close this tab.' : 'Finalising…'}
          </p>
        </div>
      )}

      {step.id === 'done' && result && (
        <StepDone result={result} onExit={onExit} navigate={navigate} />
      )}
    </div>
  );
}

function Header({ onExit }) {
  return (
    <div className="flex items-center justify-between mb-6">
      <div className="flex items-center gap-3">
        <Upload size={24} className="text-port-accent" aria-hidden="true" />
        <div>
          <h2 className="text-lg font-semibold text-white">Import from ChatGPT</h2>
          <p className="text-xs text-gray-400">Bring all your conversations into Brain → Memory</p>
        </div>
      </div>
      <button
        onClick={onExit}
        className="text-sm text-gray-400 hover:text-white flex items-center gap-1"
      >
        <ArrowLeft size={14} aria-hidden="true" /> All sources
      </button>
    </div>
  );
}

function Stepper({ steps, activeIdx }) {
  return (
    <ol className="hidden sm:flex items-center gap-2 mb-6 text-xs">
      {steps.map((s, i) => {
        const active = i === activeIdx;
        const done = i < activeIdx;
        return (
          <li key={s.id} className="flex items-center gap-2">
            <span
              className={`flex items-center justify-center w-6 h-6 rounded-full border text-xs
                ${active ? 'bg-port-accent text-white border-port-accent' :
                  done ? 'bg-port-success/20 text-port-success border-port-success/40' :
                  'bg-port-card text-gray-500 border-port-border'}`}
            >
              {done ? <Check size={12} /> : i + 1}
            </span>
            <span className={active ? 'text-white' : done ? 'text-gray-300' : 'text-gray-500'}>{s.label}</span>
            {i < steps.length - 1 && <span className="text-gray-700">›</span>}
          </li>
        );
      })}
    </ol>
  );
}

function StepInstructions({ onNext }) {
  return (
    <div className="space-y-4">
      <p className="text-sm text-gray-300">
        OpenAI lets you export everything you've ever said to ChatGPT as a downloadable archive.
        Follow these steps in your ChatGPT account, then come back here to upload the file.
      </p>
      <ol className="space-y-3 list-decimal list-inside text-sm text-gray-300">
        <li>
          Open <span className="font-mono text-port-accent">chatgpt.com</span> and sign in.
        </li>
        <li>
          Click your avatar → <span className="font-medium text-white">Settings</span> →
          {' '}<span className="font-medium text-white">Data Controls</span> →
          {' '}<span className="font-medium text-white">Export data</span> → <span className="font-medium text-white">Confirm export</span>.
        </li>
        <li>
          OpenAI emails you a download link (usually within a few minutes; the link expires in 24 hours).
        </li>
        <li>
          Download the ZIP and unzip it on your machine. You'll see <span className="font-mono text-port-accent">conversations.json</span> alongside other files.
        </li>
        <li>
          On the next step, upload that <span className="font-mono text-port-accent">conversations.json</span> file.
        </li>
      </ol>
      <div className="flex items-center justify-between pt-4">
        <a
          href="https://help.openai.com/en/articles/7260999-how-do-i-export-my-chatgpt-history-and-data"
          target="_blank"
          rel="noreferrer"
          className="text-xs text-port-accent hover:underline flex items-center gap-1"
        >
          Official OpenAI help page <ExternalLink size={12} aria-hidden="true" />
        </a>
        <button
          onClick={onNext}
          className="px-4 py-2 bg-port-accent text-white text-sm font-medium rounded hover:bg-port-accent/90 flex items-center gap-1 min-h-[40px]"
        >
          I have the file <ArrowRight size={14} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

function StepUpload({ uploading, fileMeta, onPick, onFile, fileInputRef, onBack }) {
  const handleDrop = (e) => {
    e.preventDefault();
    const file = e.dataTransfer.files?.[0];
    if (file) onFile(file);
  };

  return (
    <div className="space-y-4">
      <p className="text-sm text-gray-300">
        Drop your <span className="font-mono text-port-accent">conversations.json</span> file here, or click to browse.
        The file stays on this device — nothing is uploaded to OpenAI or any third party.
      </p>

      <div
        onClick={onPick}
        onDragOver={(e) => e.preventDefault()}
        onDrop={handleDrop}
        className="border-2 border-dashed border-port-border rounded-lg p-8 text-center cursor-pointer hover:border-port-accent hover:bg-port-card/40 transition-colors"
      >
        <FileJson size={32} className="text-gray-500 mx-auto mb-3" aria-hidden="true" />
        {fileMeta ? (
          <div>
            <p className="text-white font-medium">{fileMeta.name}</p>
            <p className="text-xs text-gray-400 mt-1">{formatBytes(fileMeta.size)}</p>
          </div>
        ) : (
          <>
            <p className="text-white font-medium">Drop conversations.json here</p>
            <p className="text-xs text-gray-400 mt-1">or click to browse — max 50 MB</p>
          </>
        )}
        {uploading && (
          <div className="mt-3 text-xs text-port-accent flex items-center justify-center gap-1">
            <BrailleSpinner /> Parsing…
          </div>
        )}
        <input
          ref={fileInputRef}
          type="file"
          accept=".json,application/json"
          className="hidden"
          onChange={(e) => onFile(e.target.files?.[0])}
        />
      </div>

      <div className="flex items-center justify-between pt-2">
        <button
          onClick={onBack}
          className="px-4 py-2 text-sm text-gray-400 hover:text-white flex items-center gap-1 min-h-[40px]"
        >
          <ArrowLeft size={14} aria-hidden="true" /> Back
        </button>
        <p className="text-xs text-gray-500">
          Tip: if your export is larger than 50 MB, split <span className="font-mono">conversations.json</span> into chunks and import each.
        </p>
      </div>
    </div>
  );
}

function StepPreview({ preview, fileMeta, onNext, onBack }) {
  const { summary, conversations } = preview;
  const sample = conversations.slice(0, 8);
  const remaining = conversations.length - sample.length;

  return (
    <div className="space-y-4">
      <p className="text-sm text-gray-300">
        Found <span className="text-white font-medium">{summary.totalConversations}</span> conversations
        in <span className="font-mono text-gray-200">{fileMeta?.name}</span>. Quick stats:
      </p>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <Stat label="Conversations" value={summary.totalConversations.toLocaleString()} />
        <Stat label="Messages" value={summary.totalMessages.toLocaleString()} />
        <Stat label="Total chars" value={summary.totalChars.toLocaleString()} />
        <Stat label="Custom GPTs" value={summary.gizmoCount.toString()} />
        <Stat label="Earliest" value={formatDate(summary.earliest)} />
        <Stat label="Latest" value={formatDate(summary.latest)} />
      </div>

      <div className="border border-port-border rounded">
        <div className="px-3 py-2 border-b border-port-border text-xs font-medium text-gray-400 uppercase">
          Sample conversations
        </div>
        <ul className="divide-y divide-port-border">
          {sample.map((c) => (
            <li key={c.id || c.title} className="px-3 py-2 flex items-center justify-between gap-2">
              <span className="text-sm text-white truncate">{c.title}</span>
              <span className="text-xs text-gray-500 flex-shrink-0">
                {c.messageCount} msg · {formatDate(c.createTime)}
              </span>
            </li>
          ))}
          {remaining > 0 && (
            <li className="px-3 py-2 text-xs text-gray-500">
              …and {remaining.toLocaleString()} more
            </li>
          )}
        </ul>
      </div>

      <div className="flex items-center justify-between pt-2">
        <button
          onClick={onBack}
          className="px-4 py-2 text-sm text-gray-400 hover:text-white flex items-center gap-1 min-h-[40px]"
        >
          <ArrowLeft size={14} aria-hidden="true" /> Back
        </button>
        <button
          onClick={onNext}
          className="px-4 py-2 bg-port-accent text-white text-sm font-medium rounded hover:bg-port-accent/90 flex items-center gap-1 min-h-[40px]"
        >
          Configure import <ArrowRight size={14} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

function Stat({ label, value }) {
  return (
    <div className="p-3 bg-port-card border border-port-border rounded">
      <div className="text-xs text-gray-500 uppercase">{label}</div>
      <div className="text-base text-white font-medium">{value}</div>
    </div>
  );
}

function StepConfigure({ tagsInput, setTagsInput, skipEmpty, setSkipEmpty, onBack, onNext }) {
  return (
    <div className="space-y-4">
      <p className="text-sm text-gray-300">
        Each conversation becomes a Memory entry in Brain → Memory. The full transcript is also archived to
        <span className="font-mono text-port-accent"> data/brain/imports/chatgpt</span>.
      </p>

      <div>
        <label className="block text-sm text-white mb-1">Tags</label>
        <input
          type="text"
          value={tagsInput}
          onChange={(e) => setTagsInput(e.target.value)}
          placeholder="chatgpt-import, archive"
          className="w-full px-3 py-2 bg-port-card border border-port-border rounded text-sm text-white focus:outline-none focus:border-port-accent min-h-[40px]"
        />
        <p className="text-xs text-gray-500 mt-1">
          Comma-separated. Each conversation gets these tags so you can filter on them later in Memory.
        </p>
      </div>

      <label className="flex items-center gap-2 text-sm text-gray-300 select-none">
        <input
          type="checkbox"
          checked={skipEmpty}
          onChange={(e) => setSkipEmpty(e.target.checked)}
          className="rounded border-port-border bg-port-card"
        />
        Skip empty conversations (chats started but never sent)
      </label>

      <div className="flex items-center justify-between pt-2">
        <button
          onClick={onBack}
          className="px-4 py-2 text-sm text-gray-400 hover:text-white flex items-center gap-1 min-h-[40px]"
        >
          <ArrowLeft size={14} aria-hidden="true" /> Back
        </button>
        <button
          onClick={onNext}
          className="px-4 py-2 bg-port-success text-white text-sm font-medium rounded hover:bg-port-success/90 flex items-center gap-1 min-h-[40px]"
        >
          Run import <ArrowRight size={14} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

function StepDone({ result, onExit, navigate }) {
  return (
    <div className="space-y-4">
      <div className="text-center py-6">
        <CheckCircle2 size={48} className="text-port-success mx-auto mb-3" aria-hidden="true" />
        <h3 className="text-lg font-semibold text-white">Import complete</h3>
        <p className="text-sm text-gray-400 mt-1">
          {result.imported} imported · {result.skipped} skipped · {result.archived} archived
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <button
          onClick={() => navigate('/brain/memory')}
          className="px-4 py-3 bg-port-accent text-white text-sm font-medium rounded hover:bg-port-accent/90 min-h-[44px]"
        >
          View in Memory
        </button>
        <button
          onClick={onExit}
          className="px-4 py-3 bg-port-card border border-port-border text-white text-sm font-medium rounded hover:bg-port-card/70 min-h-[44px]"
        >
          Import another source
        </button>
      </div>

      <details className="text-xs text-gray-400">
        <summary className="cursor-pointer hover:text-white">Per-conversation results ({result.results.length})</summary>
        <ul className="mt-2 max-h-64 overflow-auto divide-y divide-port-border border border-port-border rounded">
          {result.results.map((r, i) => (
            <li key={r.id || i} className="px-2 py-1 flex items-center justify-between gap-2">
              <span className="truncate text-gray-300">{r.title || '(untitled)'}</span>
              <span className={r.status === 'imported' ? 'text-port-success' : 'text-gray-500'}>
                {r.status === 'imported' ? `${r.messageCount} msg` : r.reason || r.status}
              </span>
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}
