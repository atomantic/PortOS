export default function ScaleInput({ labels, value, onChange, disabled }) {
  const defaultLabels = ['Strongly Disagree', 'Disagree', 'Neutral', 'Agree', 'Strongly Agree'];
  const shortLabels = ['SD', 'D', 'N', 'A', 'SA'];
  const displayLabels = labels || defaultLabels;

  return (
    <div className="flex gap-2 justify-center">
      {[1, 2, 3, 4, 5].map((val) => {
        const selected = value === val;
        return (
          <button
            key={val}
            type="button"
            disabled={disabled}
            onClick={() => onChange(val)}
            className={`flex-1 min-w-[48px] min-h-[48px] flex flex-col items-center justify-center rounded-lg border transition-all ${
              selected
                ? 'bg-port-accent border-port-accent text-white'
                : 'bg-port-bg border-port-border text-gray-400 hover:border-gray-500 hover:text-gray-300'
            } ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
          >
            <span className="text-lg font-bold">{val}</span>
            <span className="text-[10px] leading-tight mt-0.5 hidden sm:block">{displayLabels[val - 1]}</span>
            <span className="text-[10px] leading-tight mt-0.5 sm:hidden">{shortLabels[val - 1]}</span>
          </button>
        );
      })}
    </div>
  );
}
