export default function StatusBubble({ message, countdown }) {
  return (
    <div className="relative mt-4 px-4 py-3 rounded-2xl max-w-[280px] text-center text-sm leading-relaxed bg-indigo-500/10 border border-indigo-500/30">
      <div
        className="absolute -top-2 left-1/2 -translate-x-1/2 rotate-45 w-3.5 h-3.5 bg-indigo-500/10 border-l border-t border-indigo-500/30"
      />
      <div>{message}</div>
      {countdown && (
        <div className="mt-1 text-xs text-indigo-400/70 font-mono">
          Next check in {countdown.formatted}
        </div>
      )}
    </div>
  );
}
