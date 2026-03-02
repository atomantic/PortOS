import { useRef, useEffect, useCallback } from 'react';

export default function useKeyboardControls(onToggleMode) {
  const keysRef = useRef(new Set());

  const handleKeyDown = useCallback((e) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      onToggleMode?.();
      return;
    }
    keysRef.current.add(e.key.toLowerCase());
  }, [onToggleMode]);

  const handleKeyUp = useCallback((e) => {
    keysRef.current.delete(e.key.toLowerCase());
  }, []);

  const handleBlur = useCallback(() => {
    keysRef.current.clear();
  }, []);

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    window.addEventListener('blur', handleBlur);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('blur', handleBlur);
    };
  }, [handleKeyDown, handleKeyUp, handleBlur]);

  return keysRef;
}
