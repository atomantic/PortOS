import { useState, useEffect } from 'react';
import * as api from '../../services/api';

/**
 * ChronotypeOverlay renders colored energy zone bands and marker lines
 * behind the Calendar DayView time grid. It fetches the user's
 * genome-derived chronotype schedule and renders:
 *   - Colored bands for zones (peak focus, exercise, wind-down)
 *   - Dashed marker lines for cutoffs (caffeine, last meal)
 *   - Labels that appear on hover via CSS (pointer-events-none so
 *     calendar events remain clickable through the overlay)
 */
export default function ChronotypeOverlay({ startHour, pxPerHour }) {
  const [schedule, setSchedule] = useState(null);

  useEffect(() => {
    api.getChronotypeEnergySchedule().then(setSchedule).catch(() => null);
  }, []);

  if (!schedule?.zones?.length) return null;

  const startMinutes = startHour * 60;

  const minToTop = (min) => ((min - startMinutes) / 60) * pxPerHour;

  return (
    <>
      {schedule.zones.map(zone => {
        if (zone.marker) {
          // Render a dashed horizontal marker line
          const top = minToTop(zone.startMin);
          if (top < 0) return null;
          return (
            <div
              key={zone.id}
              className="absolute left-0 right-0 flex items-center pointer-events-none z-0"
              style={{ top }}
            >
              <div
                className="flex-1 border-t border-dashed"
                style={{ borderColor: zone.color }}
              />
              <span
                className="absolute right-1 -top-4 text-[10px] font-medium px-1.5 py-0.5 rounded"
                style={{ color: zone.color, backgroundColor: `${zone.color}20` }}
              >
                {zone.label}
              </span>
            </div>
          );
        }

        // Render a zone band
        const top = minToTop(zone.startMin);
        const height = ((zone.endMin - zone.startMin) / 60) * pxPerHour;
        if (height <= 0) return null;
        return (
          <div
            key={zone.id}
            className="absolute left-0 right-0 pointer-events-none z-0"
            style={{
              top: Math.max(top, 0),
              height,
              backgroundColor: zone.color,
              opacity: zone.opacity
            }}
          >
            <span
              className="absolute right-1 top-0.5 text-[10px] font-medium px-1.5 py-0.5 rounded"
              style={{ color: zone.color, backgroundColor: `${zone.color}30`, opacity: 1 }}
            >
              {zone.label}
            </span>
          </div>
        );
      })}
    </>
  );
}
