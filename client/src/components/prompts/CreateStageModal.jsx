import { useState } from 'react';
import { Save } from 'lucide-react';
import Modal from '../ui/Modal';
import { FormField } from '../ui/FormField';
import StageModelField from './StageModelField';

const BLANK_STAGE_FORM = Object.freeze({
  stageName: '',
  name: '',
  description: '',
  model: 'default',
  returnsJson: false,
  variables: [],
  template: '',
});

// The form outlives the modal's open state, so Cancel keeps a half-typed stage
// for the next open; only a successful create clears it.
// `onCreate(form)` resolves true when the stage was created.
export default function CreateStageModal({ open, onClose, providers, saving, onCreate }) {
  const [form, setForm] = useState(BLANK_STAGE_FORM);
  const patch = (fields) => setForm((prev) => ({ ...prev, ...fields }));

  const submit = async () => {
    if (await onCreate(form)) setForm(BLANK_STAGE_FORM);
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      backdropClassName="bg-black/50"
      closeOnBackdrop={false}
      ariaLabelledBy="create-stage-title"
      panelClassName="bg-port-card border border-port-border rounded-xl p-6 overflow-y-auto [--dvh-cap:90dvh]"
    >
      <div className="flex items-center justify-between mb-4">
        <h3 id="create-stage-title" className="text-lg font-medium text-white">Create New Stage</h3>
        <button
          onClick={onClose}
          aria-label="Close"
          className="text-gray-400 hover:text-white min-h-[44px] min-w-[44px] flex items-center justify-center"
        >
          ✕
        </button>
      </div>

      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <FormField label="Stage Key *">
            <input
              type="text"
              value={form.stageName}
              onChange={(e) => patch({ stageName: e.target.value })}
              placeholder="my-stage"
              className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-hidden"
            />
            <p className="text-xs text-gray-500 mt-1">Lowercase, hyphens only</p>
          </FormField>
          <FormField label="Display Name *">
            <input
              type="text"
              value={form.name}
              onChange={(e) => patch({ name: e.target.value })}
              placeholder="Pipeline — My Stage"
              className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-hidden"
            />
            <p className="text-xs text-gray-500 mt-1">
              Name it <span className="text-gray-400">Family — Specific</span> to file it under an existing group
            </p>
          </FormField>
        </div>

        <FormField label="Description">
          <input
            type="text"
            value={form.description}
            onChange={(e) => patch({ description: e.target.value })}
            placeholder="What this stage does"
            className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-hidden"
          />
        </FormField>

        <div className="space-y-4">
          <StageModelField value={form} onChange={patch} providers={providers} />
          <div>
            <label className="flex items-center gap-2 text-sm text-gray-400">
              <input
                type="checkbox"
                checked={form.returnsJson}
                onChange={(e) => patch({ returnsJson: e.target.checked })}
                className="rounded"
              />
              Returns JSON
            </label>
          </div>
        </div>

        <FormField label="Template">
          <textarea
            value={form.template}
            onChange={(e) => patch({ template: e.target.value })}
            className="w-full h-64 px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white font-mono text-sm focus:border-port-accent focus:outline-hidden"
            placeholder="Enter your prompt template here..."
          />
        </FormField>

        <div className="flex gap-2 justify-end">
          <button
            onClick={onClose}
            className="px-4 py-2 text-gray-400 hover:text-white"
          >
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={saving || !form.stageName || !form.name}
            className="flex items-center gap-1 px-4 py-2 bg-port-accent hover:bg-port-accent/80 text-white rounded disabled:opacity-50"
          >
            <Save size={14} /> Create Stage
          </button>
        </div>
      </div>
    </Modal>
  );
}
