import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import OpenWorldSpeedometer from './OpenWorldSpeedometer';

describe('OpenWorldSpeedometer', () => {
  it('renders stationary parked state by default', () => {
    render(<OpenWorldSpeedometer playerPose={{ speed: 0 }} collectedCount={3} totalShards={18} />);
    expect(screen.getByText('0')).toBeDefined();
    expect(screen.getByText('KM/H')).toBeDefined();
    expect(screen.getByText('PARK')).toBeDefined();
    expect(screen.getByText('3/18')).toBeDefined();
  });

  it('renders driving speed and mode badge when moving forward', () => {
    render(<OpenWorldSpeedometer playerPose={{ speed: 10 }} collectedCount={5} totalShards={18} />);
    // 10 units/s * 3.6 = 36 km/h
    expect(screen.getByText('36')).toBeDefined();
    expect(screen.getByText('DRIVE')).toBeDefined();
  });

  it('renders BOOST mode when sprinting or high speed', () => {
    render(<OpenWorldSpeedometer playerPose={{ speed: 30, boosting: true }} collectedCount={8} totalShards={18} />);
    expect(screen.getByText('BOOST')).toBeDefined();
  });

  it('renders DRIFT badge when skidding', () => {
    render(<OpenWorldSpeedometer playerPose={{ speed: 12, skid: 0.6 }} collectedCount={2} totalShards={18} />);
    expect(screen.getByText('DRIFT')).toBeDefined();
  });

  it('renders AIRBORNE badge when in flight', () => {
    render(<OpenWorldSpeedometer playerPose={{ speed: 10, airborne: true }} collectedCount={4} totalShards={18} />);
    expect(screen.getByText('AIRBORNE')).toBeDefined();
  });
});
