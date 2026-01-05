import { useState } from 'react';
import AppIcon, { iconNames } from './AppIcon';

export default function IconPicker({ value, onChange }) {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <div className="relative">
      <label className="block text-sm text-gray-400 mb-1">Icon</label>
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-3 w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white hover:border-port-accent/50 focus:border-port-accent focus:outline-none transition-colors"
      >
        <div className="w-8 h-8 rounded bg-port-border flex items-center justify-center text-port-accent">
          <AppIcon icon={value || 'package'} size={20} />
        </div>
        <span className="text-sm text-gray-300">{value || 'package'}</span>
        <span className="ml-auto text-gray-500">▼</span>
      </button>

      {isOpen && (
        <>
          <div
            className="fixed inset-0 z-40"
            onClick={() => setIsOpen(false)}
          />
          <div className="absolute top-full left-0 mt-1 w-full bg-port-card border border-port-border rounded-lg shadow-xl z-50 p-2 max-h-64 overflow-auto">
            <div className="grid grid-cols-5 gap-1">
              {iconNames.map(name => (
                <button
                  key={name}
                  type="button"
                  onClick={() => {
                    onChange(name);
                    setIsOpen(false);
                  }}
                  className={`p-2 rounded-lg flex flex-col items-center gap-1 transition-colors ${
                    value === name
                      ? 'bg-port-accent/20 text-port-accent'
                      : 'hover:bg-port-border text-gray-400 hover:text-white'
                  }`}
                  title={name}
                >
                  <AppIcon icon={name} size={20} />
                  <span className="text-[10px] truncate w-full text-center">{name}</span>
                </button>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
