export default function StatusIndicator({ running }) {
  return (
    <div className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-sm ${
      running
        ? 'bg-port-success/20 text-port-success'
        : 'bg-gray-700 text-gray-400'
    }`}>
      <span className={`w-2 h-2 rounded-full ${running ? 'bg-port-success animate-pulse' : 'bg-gray-500'}`} />
      {running ? 'Running' : 'Stopped'}
    </div>
  );
}
