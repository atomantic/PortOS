/** Shared horizon durations for goal urgency, feasibility, and timeline insights. */
export const GOAL_HORIZON_YEARS = {
  '1-year': 1,
  '3-year': 3,
  '5-year': 5,
  '10-year': 10,
  '20-year': 20,
  lifetime: null
};

export function getHorizonYears(horizon, timeHorizons) {
  if (horizon === 'lifetime') return timeHorizons.yearsRemaining;
  return GOAL_HORIZON_YEARS[horizon] ?? 5;
}
