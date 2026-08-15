import { describe, expect, it } from 'vitest';
import {
  CUSTOM_MINUTE_MAX as serverMinuteMax,
  CUSTOM_MINUTE_MIN as serverMinuteMin,
  CUSTOM_PAGE_MAX as serverPageMax,
  CUSTOM_PAGE_MIN as serverPageMin,
  DEFAULT_LENGTH_PROFILE as serverDefaultProfile,
  LENGTH_PROFILES as serverProfiles,
} from './issueLength.js';
import {
  CUSTOM_MINUTE_MAX as clientMinuteMax,
  CUSTOM_MINUTE_MIN as clientMinuteMin,
  CUSTOM_PAGE_MAX as clientPageMax,
  CUSTOM_PAGE_MIN as clientPageMin,
  DEFAULT_LENGTH_PROFILE as clientDefaultProfile,
  LENGTH_PROFILES as clientProfiles,
} from '../../client/src/lib/issueLength.js';

describe('issueLength — server/client picker parity', () => {
  it('keeps the profiles the client displays aligned with server targets', () => {
    const serverPickerProfiles = Object.fromEntries(Object.entries(serverProfiles).map(([id, profile]) => [
      id,
      {
        label: profile.label,
        pageTarget: profile.pageTarget,
        minutesTarget: profile.minutesTarget,
      },
    ]));
    const clientPickerProfiles = Object.fromEntries(Object.entries(clientProfiles).map(([id, profile]) => [
      id,
      {
        label: profile.label,
        pageTarget: profile.pageTarget,
        minutesTarget: profile.minutesTarget,
      },
    ]));

    expect(clientPickerProfiles).toEqual(serverPickerProfiles);
    expect(clientDefaultProfile).toBe(serverDefaultProfile);
  });

  it('keeps every custom-override bound identical', () => {
    expect({
      pageMin: clientPageMin,
      pageMax: clientPageMax,
      minuteMin: clientMinuteMin,
      minuteMax: clientMinuteMax,
    }).toEqual({
      pageMin: serverPageMin,
      pageMax: serverPageMax,
      minuteMin: serverMinuteMin,
      minuteMax: serverMinuteMax,
    });
  });
});
