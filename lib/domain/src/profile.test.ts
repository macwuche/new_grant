import { describe, expect, it } from 'vitest';
import * as P from './profile';
import { adoptServerProfile } from './sync';
import { createSeedState } from './seed';

const today = new Date('2026-09-29T12:00:00Z');
const valid: P.PersonalDetails = { name: 'Sharon Spears Henderson', displayName: 'Henderson', phone: '+234 803 555 0100', telegram: '@sharon_h', birthDate: '1990-04-02', address: '' };

describe('personal details', () => {
  it('accepts complete details and leaves optional ones empty', () => {
    expect(P.validatePersonalDetails(valid, today)).toEqual({});
    expect(P.validatePersonalDetails({ ...valid, displayName: '', phone: '', telegram: '', birthDate: '', address: '' }, today)).toEqual({});
  });

  it('rejects a bad handle, phone without a country code, a future or under-age birth date, and a short name', () => {
    const errors = P.validatePersonalDetails({ name: 'S', displayName: '!x', phone: '0803 555 0100', telegram: '@ab', birthDate: '2027-01-01', address: 'x' }, today);
    expect(Object.keys(errors).sort()).toEqual(['address', 'birthDate', 'displayName', 'name', 'phone', 'telegram']);
    expect(P.validatePersonalDetails({ ...valid, birthDate: '2015-01-01' }, today).birthDate).toMatch(/at least 16/);
    expect(P.validatePersonalDetails({ ...valid, birthDate: '1990-02-30' }, today).birthDate).toMatch(/real date/);
    expect(P.validatePersonalDetails({ ...valid, telegram: '1abcde' }, today).telegram).toBeDefined();
  });

  it('turns an @name or t.me link into a bare Telegram username', () => {
    expect(P.normalizeTelegram(' https://t.me/sharon_h ')).toBe('sharon_h');
    expect(P.cleanPersonalDetails({ ...valid, phone: '+234  803 555   0100', telegram: '@sharon_h' })).toMatchObject({ phone: '+234 803 555 0100', telegram: 'sharon_h' });
  });

  it('derives the handle from the display name, or the first name', () => {
    expect(P.profileHandle({ name: 'Sharon Spears', displayName: 'Henderson' })).toBe('@henderson');
    expect(P.profileHandle({ name: 'Sharon Spears', displayName: '' })).toBe('@sharon');
  });

  it('saves details and privacy switches on the preview profile', () => {
    const s = createSeedState();
    const saved = P.updatePersonalDetails(s, { ...valid, birthDate: '' }, today);
    if (!saved.ok) throw new Error(saved.error);
    expect(saved.state.profile).toMatchObject({ name: valid.name, displayName: 'Henderson', telegram: 'sharon_h' });
    expect(saved.state.profile.birthDate).toBeUndefined();
    const refused = P.updatePersonalDetails(s, { ...valid, phone: '12' }, today);
    expect(refused.ok).toBe(false);
    expect(P.privacyOf(s.profile)).toEqual(P.DEFAULT_PRIVACY);
    const off = P.setPrivacy(s, { activityLogging: false, unusualActivityEmail: true });
    if (!off.ok) throw new Error(off.error);
    expect(P.privacyOf(off.state.profile).activityLogging).toBe(false);
  });

  it('adopts the profile-center fields the server sends', () => {
    const s = createSeedState();
    const r = adoptServerProfile(s, { ...s.profile, birthDate: '1991-01-01', displayName: 'Alex', telegram: 'alex_m', privacy: { activityLogging: false, unusualActivityEmail: false } });
    if (!r.ok) throw new Error(r.error);
    expect(r.state.profile).toMatchObject({ birthDate: '1991-01-01', displayName: 'Alex', telegram: 'alex_m', privacy: { activityLogging: false, unusualActivityEmail: false } });
  });
});

describe('password strength', () => {
  it('scores length and variety, and says what is missing', () => {
    expect(P.passwordStrength('').score).toBe(0);
    expect(P.passwordStrength('abc').score).toBe(1);
    expect(P.passwordStrength('abcdefgh')).toMatchObject({ score: 1, missing: ['upper- and lower-case letters', 'a number', 'a symbol'] });
    expect(P.passwordStrength('Abcdefg1').score).toBe(3);
    expect(P.passwordStrength('Abcdefg1!').label).toBe('Strong');
    expect(P.passwordStrength('Abcdefghijklm1').score).toBe(4);
  });
});
