import { useState, useEffect } from 'react';

export default function useNextEvalCountdown(lastEvaluation, intervalMs, running) {
  const [countdown, setCountdown] = useState(null);

  useEffect(() => {
    if (!running || !lastEvaluation || !intervalMs) {
      setCountdown(null);
      return;
    }

    const updateCountdown = () => {
      const lastEvalTime = new Date(lastEvaluation).getTime();
      const nextEvalTime = lastEvalTime + intervalMs;
      const now = Date.now();
      const remaining = Math.max(0, nextEvalTime - now);

      if (remaining <= 0) {
        setCountdown({ seconds: 0, formatted: 'any moment...' });
      } else {
        const totalSeconds = Math.ceil(remaining / 1000);
        const minutes = Math.floor(totalSeconds / 60);
        const seconds = totalSeconds % 60;
        const formatted = minutes > 0
          ? `${minutes}m ${seconds}s`
          : `${seconds}s`;
        setCountdown({ seconds: totalSeconds, formatted });
      }
    };

    updateCountdown();
    const timer = setInterval(updateCountdown, 1000);
    return () => clearInterval(timer);
  }, [lastEvaluation, intervalMs, running]);

  return countdown;
}
