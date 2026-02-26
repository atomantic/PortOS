import { useState, useEffect, useRef } from 'react';

/**
 * 1-second countdown hook for death clock display.
 * Takes a deathDate ISO string, returns live countdown breakdown.
 */
export function useDeathClock(deathDateISO) {
  const [countdown, setCountdown] = useState(null);
  const intervalRef = useRef(null);

  useEffect(() => {
    if (!deathDateISO) {
      setCountdown(null);
      return;
    }

    const deathDate = new Date(deathDateISO);

    const update = () => {
      const now = new Date();
      const diff = deathDate.getTime() - now.getTime();

      if (diff <= 0) {
        setCountdown({ expired: true, years: 0, months: 0, weeks: 0, days: 0, hours: 0, minutes: 0, seconds: 0 });
        return;
      }

      // Calculate breakdown
      const totalSeconds = Math.floor(diff / 1000);
      const totalMinutes = Math.floor(totalSeconds / 60);
      const totalHours = Math.floor(totalMinutes / 60);
      const totalDays = Math.floor(totalHours / 24);

      const years = Math.floor(totalDays / 365.25);
      const remainingDaysAfterYears = totalDays - Math.floor(years * 365.25);
      const months = Math.floor(remainingDaysAfterYears / 30.44);
      const remainingDaysAfterMonths = remainingDaysAfterYears - Math.floor(months * 30.44);
      const weeks = Math.floor(remainingDaysAfterMonths / 7);
      const days = remainingDaysAfterMonths - weeks * 7;
      const hours = totalHours % 24;
      const minutes = totalMinutes % 60;
      const seconds = totalSeconds % 60;

      setCountdown({
        expired: false,
        years,
        months,
        weeks,
        days,
        hours,
        minutes,
        seconds,
        totalDays,
        totalHours: totalHours % 24
      });
    };

    update();
    intervalRef.current = setInterval(update, 1000);

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [deathDateISO]);

  return countdown;
}
