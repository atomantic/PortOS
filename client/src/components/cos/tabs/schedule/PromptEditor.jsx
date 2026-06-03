import { useState, useEffect } from 'react';

export default function PromptEditor({ config, promptValue, setPromptValue, editingPrompt, setEditingPrompt, handleSavePrompt, updating, activeApps }) {
  const stages = config.taskMetadata?.pipeline?.stages;
  const stagePrompts = config.stagePrompts;
  const hasPipeline = stages?.length > 0 && stagePrompts?.length > 0;
  const [activeTab, setActiveTab] = useState(0);

  useEffect(() => {
    if (activeTab >= (stages?.length || 1)) setActiveTab(0);
  }, [stages?.length, activeTab]);

  if (!hasPipeline) {
    // Standard single prompt editor
    return (
      <div>
        <div className="flex items-center justify-between mb-2">
          <label className="text-sm text-gray-400">Task Prompt</label>
          {!editingPrompt && (
            <button onClick={() => setEditingPrompt(true)} className="text-xs text-port-accent hover:text-port-accent/80">Edit</button>
          )}
        </div>
        {editingPrompt ? (
          <div className="space-y-2">
            <textarea
              value={promptValue}
              onChange={(e) => setPromptValue(e.target.value)}
              disabled={updating}
              rows={12}
              className="w-full bg-port-bg border border-port-border rounded px-3 py-2 text-white text-sm font-mono"
              placeholder="Enter task prompt"
            />
            <div className="flex gap-2">
              <button onClick={handleSavePrompt} disabled={updating} className="px-3 py-1.5 text-sm bg-port-accent hover:bg-port-accent/80 text-white rounded transition-colors">Save Prompt</button>
              <button onClick={() => { setPromptValue(config.prompt || ''); setEditingPrompt(false); }} disabled={updating} className="px-3 py-1.5 text-sm bg-port-border hover:bg-port-border/80 text-white rounded transition-colors">Cancel</button>
            </div>
            {activeApps.length > 0 && (
              <p className="text-xs text-gray-500">
                Use <code className="bg-port-border px-1 rounded">{'{appName}'}</code> and <code className="bg-port-border px-1 rounded">{'{repoPath}'}</code> as placeholders.
              </p>
            )}
          </div>
        ) : (
          <div className="bg-port-bg border border-port-border rounded px-3 py-2 text-xs text-gray-400 font-mono max-h-32 overflow-y-auto cursor-pointer hover:border-port-accent/50" onClick={() => setEditingPrompt(true)} title="Click to edit prompt">
            <pre className="whitespace-pre-wrap">{promptValue || 'No prompt configured'}</pre>
          </div>
        )}
      </div>
    );
  }

  // Pipeline tabbed prompt viewer
  return (
    <div>
      <label className="text-sm text-gray-400 block mb-2">Stage Prompts</label>
      <div className="border border-port-border rounded-lg overflow-hidden">
        <div className="flex border-b border-port-border bg-port-card">
          {stages.map((stage, i) => (
            <button
              key={i}
              onClick={() => setActiveTab(i)}
              className={`flex-1 px-3 py-2 text-xs font-medium transition-colors ${
                activeTab === i
                  ? 'text-purple-400 bg-purple-500/10 border-b-2 border-purple-400'
                  : 'text-gray-400 hover:text-gray-300 hover:bg-port-border/30'
              }`}
            >
              <span className="text-[10px] text-gray-500 mr-1">Stage {i + 1}</span>
              {stage.name}
              {stage.readOnly && <span className="ml-1 text-[10px] text-gray-500">(read-only)</span>}
            </button>
          ))}
        </div>
        <div className="bg-port-bg px-3 py-2 text-xs text-gray-400 font-mono max-h-64 overflow-y-auto">
          <pre className="whitespace-pre-wrap">{stagePrompts[activeTab] || 'No prompt configured'}</pre>
        </div>
      </div>
      <p className="text-xs text-gray-500 mt-2">Stage prompts use the default templates. Edit the main task prompt to override all stages with a single prompt.</p>
    </div>
  );
}
