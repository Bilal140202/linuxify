/**
 * Unit tests for `src/doctor/profiles.ts` — profile definitions.
 *
 * Covers:
 *   - PROFILE_CHECKS contains all six built-in profiles.
 *   - Each profile's check ID list is non-empty.
 *   - The critical `minimal` profile contains exactly the four critical IDs.
 *   - `deep` includes network checks that `standard` excludes.
 *   - `pre-flight` contains only host checks.
 *   - `post-install` contains bootstrap + distro + runtime + path + compat.
 *   - `ci` matches `deep`.
 *   - Every check ID referenced by a profile corresponds to a real
 *     registered check.
 *   - `isBuiltinProfile` recognizes all six profiles.
 *   - `checksForProfile` returns the standard list for unknown names.
 *   - `timeoutForProfile` returns sensible values per profile.
 *   - `ALL_PROFILES` lists all six profiles.
 */

import { describe, it, expect } from 'vitest';

import {
  PROFILE_CHECKS,
  PROFILE_TIMEOUT_MS,
  ALL_PROFILES,
  isBuiltinProfile,
  checksForProfile,
  timeoutForProfile,
} from '../../../src/doctor/profiles.js';
import { ALL_CHECKS, getCheck } from '../../../src/doctor/checks/index.js';
import type { DoctorProfile } from '../../../src/doctor/types.js';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('doctor/profiles — PROFILE_CHECKS', () => {
  it('contains all six built-in profile names', () => {
    const profileNames = Object.keys(PROFILE_CHECKS);
    expect(profileNames.sort()).toEqual(
      ['ci', 'deep', 'minimal', 'post-install', 'pre-flight', 'standard'].sort(),
    );
  });

  it('every profile has a non-empty check ID list', () => {
    for (const [name, ids] of Object.entries(PROFILE_CHECKS)) {
      expect(ids.length, `${name} should be non-empty`).toBeGreaterThan(0);
    }
  });

  it('minimal profile contains exactly the 4 critical checks', () => {
    expect(PROFILE_CHECKS.minimal).toEqual([
      'bootstrap.completed',
      'distro.installed',
      'runtime.node',
      'path.linuxify_bin',
    ]);
  });

  it('standard profile includes all host checks', () => {
    const std = PROFILE_CHECKS.standard;
    expect(std).toContain('host.termux');
    expect(std).toContain('host.android');
    expect(std).toContain('host.arch');
    expect(std).toContain('host.storage');
    expect(std).toContain('host.memory');
  });

  it('standard profile excludes network checks', () => {
    const std = PROFILE_CHECKS.standard;
    expect(std).not.toContain('network.dns');
    expect(std).not.toContain('network.github');
    expect(std).not.toContain('network.npm');
  });

  it('deep profile includes network checks that standard excludes', () => {
    const deep = PROFILE_CHECKS.deep;
    expect(deep).toContain('network.dns');
    expect(deep).toContain('network.github');
    expect(deep).toContain('network.npm');
    // deep is a strict superset of standard (for the built-in checks).
    for (const id of PROFILE_CHECKS.standard) {
      expect(deep).toContain(id);
    }
  });

  it('ci profile matches deep profile', () => {
    expect(PROFILE_CHECKS.ci).toEqual(PROFILE_CHECKS.deep);
  });

  it('pre-flight profile contains only host checks', () => {
    expect(PROFILE_CHECKS['pre-flight']).toEqual([
      'host.termux',
      'host.android',
      'host.arch',
      'host.storage',
    ]);
  });

  it('post-install profile contains bootstrap + distro + runtime + path + compat', () => {
    const pi = PROFILE_CHECKS['post-install'];
    expect(pi).toContain('bootstrap.completed');
    expect(pi).toContain('distro.installed');
    expect(pi).toContain('distro.bootable');
    expect(pi).toContain('runtime.node');
    expect(pi).toContain('path.linuxify_bin');
    expect(pi).toContain('compat.platform');
    // No host or network checks in post-install.
    expect(pi.some((id) => id.startsWith('host.'))).toBe(false);
    expect(pi.some((id) => id.startsWith('network.'))).toBe(false);
  });
});

describe('doctor/profiles — cross-reference with registry', () => {
  it('every check ID referenced by any profile exists in ALL_CHECKS', () => {
    const registered = new Set(ALL_CHECKS.map((c) => c.id));
    for (const [profile, ids] of Object.entries(PROFILE_CHECKS)) {
      for (const id of ids) {
        expect(registered.has(id), `${profile} references unknown check '${id}'`).toBe(true);
      }
    }
  });

  it('every registered check appears in at least one profile', () => {
    const referenced = new Set<string>();
    for (const ids of Object.values(PROFILE_CHECKS)) {
      for (const id of ids) referenced.add(id);
    }
    for (const check of ALL_CHECKS) {
      expect(
        referenced.has(check.id),
        `check '${check.id}' is not in any profile`,
      ).toBe(true);
    }
  });

  it('getCheck returns the check for every profile ID', () => {
    for (const ids of Object.values(PROFILE_CHECKS)) {
      for (const id of ids) {
        expect(getCheck(id), `getCheck('${id}') should be defined`).toBeDefined();
      }
    }
  });
});

describe('doctor/profiles — ALL_PROFILES', () => {
  it('lists all six profiles', () => {
    expect(ALL_PROFILES).toHaveLength(6);
    expect(ALL_PROFILES).toContain('minimal');
    expect(ALL_PROFILES).toContain('standard');
    expect(ALL_PROFILES).toContain('deep');
    expect(ALL_PROFILES).toContain('pre-flight');
    expect(ALL_PROFILES).toContain('post-install');
    expect(ALL_PROFILES).toContain('ci');
  });

  it('is frozen (immutable)', () => {
    expect(Object.isFrozen(ALL_PROFILES)).toBe(true);
  });
});

describe('doctor/profiles — isBuiltinProfile', () => {
  it('returns true for all six built-in profiles', () => {
    expect(isBuiltinProfile('minimal')).toBe(true);
    expect(isBuiltinProfile('standard')).toBe(true);
    expect(isBuiltinProfile('deep')).toBe(true);
    expect(isBuiltinProfile('pre-flight')).toBe(true);
    expect(isBuiltinProfile('post-install')).toBe(true);
    expect(isBuiltinProfile('ci')).toBe(true);
  });

  it('returns false for unknown names', () => {
    expect(isBuiltinProfile('quick')).toBe(false);
    expect(isBuiltinProfile('full')).toBe(false);
    expect(isBuiltinProfile('default')).toBe(false);
    expect(isBuiltinProfile('')).toBe(false);
  });

  it('acts as a type guard', () => {
    const name: string = 'standard';
    if (isBuiltinProfile(name)) {
      // Inside this branch, TypeScript narrows `name` to DoctorProfile.
      const ids = PROFILE_CHECKS[name];
      expect(ids.length).toBeGreaterThan(0);
    }
  });
});

describe('doctor/profiles — checksForProfile', () => {
  it('returns the standard list for the standard profile', () => {
    expect(checksForProfile('standard')).toEqual(PROFILE_CHECKS.standard);
  });

  it('returns the deep list for the deep profile', () => {
    expect(checksForProfile('deep')).toEqual(PROFILE_CHECKS.deep);
  });

  it('returns the standard list for unknown profile names (fallback)', () => {
    // The function accepts DoctorProfile (a union) but tolerates casts
    // from arbitrary strings by returning the standard fallback.
    const unknown = 'made-up-profile' as DoctorProfile;
    expect(checksForProfile(unknown)).toEqual(PROFILE_CHECKS.standard);
  });
});

describe('doctor/profiles — timeoutForProfile', () => {
  it('returns a longer timeout for deep than for standard', () => {
    expect(timeoutForProfile('deep')).toBeGreaterThan(timeoutForProfile('standard'));
  });

  it('returns 5000 ms for standard', () => {
    expect(timeoutForProfile('standard')).toBe(5000);
  });

  it('returns 15000 ms for deep', () => {
    expect(timeoutForProfile('deep')).toBe(15000);
  });

  it('returns 3000 ms for minimal', () => {
    expect(timeoutForProfile('minimal')).toBe(3000);
  });

  it('returns 15000 ms for ci (same as deep)', () => {
    expect(timeoutForProfile('ci')).toBe(15000);
  });

  it('returns the standard timeout for unknown profile names', () => {
    const unknown = 'made-up-profile' as DoctorProfile;
    expect(timeoutForProfile(unknown)).toBe(timeoutForProfile('standard'));
  });
});

describe('doctor/profiles — PROFILE_TIMEOUT_MS', () => {
  it('has an entry for every built-in profile', () => {
    for (const p of ALL_PROFILES) {
      expect(PROFILE_TIMEOUT_MS[p], `timeout for ${p}`).toBeDefined();
    }
  });

  it('every timeout is a positive integer', () => {
    for (const [name, ms] of Object.entries(PROFILE_TIMEOUT_MS)) {
      expect(Number.isInteger(ms), `${name} timeout is integer`).toBe(true);
      expect(ms, `${name} timeout is positive`).toBeGreaterThan(0);
    }
  });
});
