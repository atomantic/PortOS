export default function StatusBubble({ message }) {
  return (
    <div className="relative mt-4 px-4 py-3 rounded-2xl max-w-[280px] text-center text-sm leading-relaxed bg-port-accent-2/10 border border-port-accent-2/30">
      <div
        className="absolute -top-2 left-1/2 -translate-x-1/2 rotate-45 w-3.5 h-3.5 bg-port-accent-2/10 border-l border-t border-port-accent-2/30"
      />
      <div>{message}</div>
    </div>
  );
}
