import Modal from './Modal';

/**
 * Confirm-dialog chrome for a consequential action that needs room to explain
 * itself (what it does, what goes, what survives) — a titled `Modal` with a
 * body, Cancel, and a toned confirm button. For a short destructive confirm in
 * a row or card, prefer the inline `InlineConfirmRow` / `ConfirmButtonPair`.
 *
 * Extracted at the third copy of the same `Modal` props + header/body/footer
 * markup, because the parts that drift when it is pasted again are the
 * accessibility ones (`aria-labelledby` wiring, the 44px close target) rather
 * than anything visible.
 *
 * `tone` picks the confirm button's colour: 'accent' for a normal action,
 * 'error' for one that destroys work. `icon` is shown in the title and on the
 * confirm button.
 */
export default function ConfirmModal({ open, onClose, titleId, icon, title, tone = 'accent', confirmLabel, onConfirm, busy = false, children }) {
  const confirmCls = tone === 'error'
    ? 'bg-port-error hover:bg-port-error/80'
    : 'bg-port-accent hover:bg-port-accent/80';
  return (
    <Modal
      open={open}
      onClose={onClose}
      size="md"
      align="center"
      backdropClassName="bg-black/50"
      panelClassName="bg-port-card border border-port-border rounded-xl overflow-hidden flex flex-col"
      ariaLabelledBy={titleId}
    >
      <div className="flex items-center justify-between shrink-0 p-4 border-b border-port-border">
        <h3 id={titleId} className="font-medium text-white flex items-center gap-2">
          {icon}
          {title}
        </h3>
        <button type="button" onClick={onClose} aria-label="Close" className="text-gray-400 hover:text-white min-h-[44px] min-w-[44px] flex items-center justify-center">×</button>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-3">{children}</div>
      <div className="flex justify-end shrink-0 gap-3 p-4 border-t border-port-border">
        <button type="button" onClick={onClose} className="px-4 py-2 text-sm text-gray-400 hover:text-white">
          Cancel
        </button>
        <button
          type="button"
          onClick={onConfirm}
          disabled={busy}
          className={`flex items-center gap-2 px-4 py-2 ${confirmCls} text-white rounded-lg text-sm disabled:opacity-50`}
        >
          {icon}
          {confirmLabel}
        </button>
      </div>
    </Modal>
  );
}
