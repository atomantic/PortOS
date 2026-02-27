/**
 * Health Metrics Registry
 *
 * Single source of truth for all Apple Health metric display configuration.
 * Units match what Apple Health actually stores (imperial/native units).
 * Each category contains metrics with their label, unit, color, and aggregation type.
 */

export const SUM_METRICS = new Set([
  'step_count', 'active_energy', 'basal_energy_burned', 'flights_climbed',
  'apple_exercise_time', 'apple_stand_time', 'walking_running_distance',
  'distance_cycling', 'time_in_daylight'
]);

export const METRIC_CATEGORIES = [
  {
    id: 'core-vitals',
    label: 'Core Vitals',
    defaultExpanded: true,
    metrics: [
      { key: 'heart_rate', label: 'Heart Rate', unit: 'bpm', color: '#ef4444', aggregation: 'avg' },
      { key: 'resting_heart_rate', label: 'Resting Heart Rate', unit: 'bpm', color: '#f87171', aggregation: 'avg' },
      { key: 'heart_rate_variability_sdnn', label: 'HRV', unit: 'ms', color: '#22c55e', aggregation: 'avg' },
      { key: 'blood_oxygen_saturation', label: 'Blood Oxygen', unit: '%', color: '#3b82f6', aggregation: 'avg', formatValue: v => v.toFixed(1) },
      { key: 'respiratory_rate', label: 'Respiratory Rate', unit: 'breaths/min', color: '#06b6d4', aggregation: 'avg', formatValue: v => v.toFixed(1) },
      { key: 'vo2_max', label: 'VO2 Max', unit: 'mL/min/kg', color: '#8b5cf6', aggregation: 'avg', formatValue: v => v.toFixed(1) },
    ]
  },
  {
    id: 'activity',
    label: 'Activity',
    metrics: [
      { key: 'step_count', label: 'Steps', unit: 'steps', color: '#3b82f6', aggregation: 'sum', formatValue: v => Math.round(v).toLocaleString() },
      { key: 'active_energy', label: 'Active Energy', unit: 'Cal', color: '#f59e0b', aggregation: 'sum', formatValue: v => Math.round(v).toLocaleString() },
      { key: 'basal_energy_burned', label: 'Basal Energy', unit: 'Cal', color: '#d97706', aggregation: 'sum', formatValue: v => Math.round(v).toLocaleString() },
      { key: 'walking_running_distance', label: 'Walk/Run Distance', unit: 'mi', color: '#10b981', aggregation: 'sum', formatValue: v => v.toFixed(2) },
      { key: 'apple_exercise_time', label: 'Exercise Time', unit: 'min', color: '#22c55e', aggregation: 'sum', formatValue: v => Math.round(v).toLocaleString() },
      { key: 'flights_climbed', label: 'Flights Climbed', unit: 'flights', color: '#6366f1', aggregation: 'sum' },
      { key: 'physical_effort', label: 'Physical Effort', unit: 'kJ/hr/kg', color: '#ec4899', aggregation: 'avg' },
      { key: 'time_in_daylight', label: 'Time in Daylight', unit: 'min', color: '#fbbf24', aggregation: 'sum', formatValue: v => Math.round(v).toLocaleString() },
      { key: 'apple_stand_time', label: 'Stand Time', unit: 'min', color: '#14b8a6', aggregation: 'sum', formatValue: v => Math.round(v).toLocaleString() },
    ]
  },
  {
    id: 'sleep',
    label: 'Sleep',
    metrics: [
      { key: 'sleep_analysis', label: 'Sleep', unit: 'hrs', color: '#8b5cf6', aggregation: 'special' },
      { key: 'breathing_disturbances', label: 'Breathing Disturbances', unit: 'events/hr', color: '#f43f5e', aggregation: 'avg' },
    ]
  },
  {
    id: 'body',
    label: 'Body',
    metrics: [
      { key: 'body_mass', label: 'Weight', unit: 'lb', color: '#6366f1', aggregation: 'avg', formatValue: v => v.toFixed(1) },
      { key: 'body_mass_index', label: 'BMI', unit: '', color: '#8b5cf6', aggregation: 'avg', formatValue: v => v.toFixed(1) },
      { key: 'body_fat_percentage', label: 'Body Fat', unit: '%', color: '#f59e0b', aggregation: 'avg', formatValue: v => (v * 100).toFixed(1) },
      { key: 'lean_body_mass', label: 'Lean Body Mass', unit: 'lb', color: '#10b981', aggregation: 'avg', formatValue: v => v.toFixed(1) },
    ]
  },
  {
    id: 'walking',
    label: 'Walking',
    metrics: [
      { key: 'walking_speed', label: 'Walking Speed', unit: 'mi/hr', color: '#3b82f6', aggregation: 'avg', formatValue: v => v.toFixed(2) },
      { key: 'walking_step_length', label: 'Step Length', unit: 'in', color: '#06b6d4', aggregation: 'avg', formatValue: v => v.toFixed(1) },
      { key: 'walking_double_support_percentage', label: 'Double Support', unit: '%', color: '#f59e0b', aggregation: 'avg', formatValue: v => (v * 100).toFixed(1) },
      { key: 'walking_asymmetry_percentage', label: 'Asymmetry', unit: '%', color: '#ef4444', aggregation: 'avg', formatValue: v => (v * 100).toFixed(1) },
      { key: 'walking_steadiness', label: 'Steadiness', unit: '%', color: '#22c55e', aggregation: 'avg', formatValue: v => (v * 100).toFixed(0) },
      { key: 'stair_speed_up', label: 'Stair Speed (Up)', unit: 'ft/s', color: '#8b5cf6', aggregation: 'avg', formatValue: v => v.toFixed(2) },
      { key: 'stair_speed_down', label: 'Stair Speed (Down)', unit: 'ft/s', color: '#6366f1', aggregation: 'avg', formatValue: v => v.toFixed(2) },
      { key: 'six_minute_walk_test', label: '6-Min Walk Test', unit: 'm', color: '#10b981', aggregation: 'avg', formatValue: v => Math.round(v).toLocaleString() },
      { key: 'walking_heart_rate_average', label: 'Walking Heart Rate', unit: 'bpm', color: '#ef4444', aggregation: 'avg' },
    ]
  },
  {
    id: 'cycling',
    label: 'Cycling',
    metrics: [
      { key: 'distance_cycling', label: 'Cycling Distance', unit: 'mi', color: '#3b82f6', aggregation: 'sum', formatValue: v => v.toFixed(2) },
      { key: 'cycling_speed', label: 'Cycling Speed', unit: 'mi/hr', color: '#06b6d4', aggregation: 'avg', formatValue: v => v.toFixed(1) },
      { key: 'cycling_cadence', label: 'Cadence', unit: 'rpm', color: '#f59e0b', aggregation: 'avg', formatValue: v => Math.round(v).toLocaleString() },
      { key: 'cycling_power', label: 'Power', unit: 'W', color: '#ef4444', aggregation: 'avg', formatValue: v => Math.round(v).toLocaleString() },
      { key: 'cycling_ftp', label: 'FTP', unit: 'W', color: '#8b5cf6', aggregation: 'avg', formatValue: v => Math.round(v).toLocaleString() },
    ]
  },
  {
    id: 'running',
    label: 'Running',
    metrics: [
      { key: 'running_speed', label: 'Running Speed', unit: 'mi/hr', color: '#3b82f6', aggregation: 'avg', formatValue: v => v.toFixed(1) },
      { key: 'running_power', label: 'Running Power', unit: 'W', color: '#ef4444', aggregation: 'avg', formatValue: v => Math.round(v).toLocaleString() },
      { key: 'running_stride_length', label: 'Stride Length', unit: 'm', color: '#06b6d4', aggregation: 'avg', formatValue: v => v.toFixed(2) },
      { key: 'running_vertical_oscillation', label: 'Vertical Oscillation', unit: 'cm', color: '#f59e0b', aggregation: 'avg', formatValue: v => v.toFixed(1) },
      { key: 'running_ground_contact_time', label: 'Ground Contact', unit: 'ms', color: '#8b5cf6', aggregation: 'avg', formatValue: v => Math.round(v).toLocaleString() },
    ]
  },
  {
    id: 'audio',
    label: 'Audio',
    metrics: [
      { key: 'environmental_audio_exposure', label: 'Environmental Audio', unit: 'dB', color: '#f59e0b', aggregation: 'avg', formatValue: v => v.toFixed(1) },
      { key: 'headphone_audio_exposure', label: 'Headphone Audio', unit: 'dB', color: '#ef4444', aggregation: 'avg', formatValue: v => v.toFixed(1) },
    ]
  }
];
