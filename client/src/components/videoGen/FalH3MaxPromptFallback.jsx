import Modal from '../ui/Modal';

export default function FalH3MaxPromptFallback({ prompt, onClose }) {
  return (
    <Modal
      open={Boolean(prompt)}
      onClose={onClose}
      size="lg"
      usePortal
      ariaLabel="Copy fal H3 Max prompt manually"
    >
      <div className="space-y-3 rounded-xl border border-port-border bg-port-card p-4">
        <div>
          <h2 className="text-base font-semibold text-port-text">Copy the fal H3 Max prompt</h2>
          <p className="mt-1 text-sm text-port-text-muted">
            Automatic clipboard access is unavailable here. Select the prepared prompt below,
            copy it manually, and paste it into the fal.ai tab.
          </p>
        </div>
        <textarea
          aria-label="Prepared fal H3 Max prompt"
          readOnly
          value={prompt || ''}
          onFocus={(event) => event.currentTarget.select()}
          rows={12}
          className="w-full resize-y rounded-lg border border-port-border bg-port-bg p-3 text-sm text-port-text"
        />
        <div className="flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-port-border px-3 py-2 text-sm text-port-text hover:border-port-accent hover:text-port-accent"
          >
            Done
          </button>
        </div>
      </div>
    </Modal>
  );
}
