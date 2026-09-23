import { describe, expect, it } from 'vitest';

import {
  buildPackStatusTriple,
  canUpgradeCaptureIntegrity,
  checkPackStatus,
  classificationStatusFromKvmFamilyDetection,
  derivePackIntegrity,
  resolveLegacyPackImportStatus,
} from './packStatus';
import { INTEGRITY_POSITIVE_FIXTURE, INTEGRITY_FAILURE_FIXTURES } from './integrityFixtures';
import type { DerivedPackIntegrity, PackIntegrityEvidenceSummary } from './types';

function allPresentSummary(): PackIntegrityEvidenceSummary {
  return INTEGRITY_POSITIVE_FIXTURE.summary;
}

describe('checkPackStatus（规范 §6 三正交状态）', () => {
  it('允许 COMPLETE + KVM_REACHED + UNKNOWN（协议未知不影响完整度）', () => {
    const check = checkPackStatus({
      captureIntegrity: 'COMPLETE',
      workflowStatus: 'KVM_REACHED',
      classificationStatus: 'UNKNOWN',
    });
    expect(check.legal).toBe(true);
  });

  it('允许 COMPLETE + KVM_REACHED + KNOWN', () => {
    expect(
      checkPackStatus({
        captureIntegrity: 'COMPLETE',
        workflowStatus: 'KVM_REACHED',
        classificationStatus: 'KNOWN',
      }).legal,
    ).toBe(true);
  });

  it('拒绝 COMPLETE + LOGIN_REACHED / TARGET_OPENED（未到达 KVM 不能完整）', () => {
    for (const workflowStatus of ['LOGIN_REACHED', 'TARGET_OPENED'] as const) {
      const check = checkPackStatus({
        captureIntegrity: 'COMPLETE',
        workflowStatus,
        classificationStatus: 'UNKNOWN',
      });
      expect(check.legal).toBe(false);
      expect(check.violations.join('')).toContain('INCOMPLETE_WORKFLOW_NOT_REACHED');
    }
  });

  it('INCOMPLETE 可以与任何 workflow / classification 组合', () => {
    for (const workflowStatus of ['KVM_REACHED', 'LOGIN_REACHED', 'TARGET_OPENED'] as const) {
      for (const classificationStatus of ['KNOWN', 'UNKNOWN'] as const) {
        expect(
          checkPackStatus({
            captureIntegrity: 'INCOMPLETE',
            workflowStatus,
            classificationStatus,
          }).legal,
        ).toBe(true);
      }
    }
  });
});

describe('classificationStatusFromKvmFamilyDetection（规范 §15）', () => {
  it('已知三族 → KNOWN；采集桶 → UNKNOWN', () => {
    expect(classificationStatusFromKvmFamilyDetection('ami-megarac')).toBe('KNOWN');
    expect(classificationStatusFromKvmFamilyDetection('openbmc-h5')).toBe('KNOWN');
    expect(classificationStatusFromKvmFamilyDetection('huawei-ibmc')).toBe('KNOWN');
    expect(classificationStatusFromKvmFamilyDetection('unknown-h5')).toBe('UNKNOWN');
    expect(classificationStatusFromKvmFamilyDetection('not-h5')).toBe('UNKNOWN');
    expect(classificationStatusFromKvmFamilyDetection('dell-idrac-h5')).toBe('UNKNOWN');
  });
});

describe('derivePackIntegrity（规范 §14 门禁）', () => {
  it('全部证据在且到达 KVM → COMPLETE，十项门禁全过', () => {
    const derived = derivePackIntegrity(allPresentSummary());
    expect(derived.captureIntegrity).toBe('COMPLETE');
    expect(derived.reasons).toEqual([]);
    expect(derived.gates).toHaveLength(10);
    expect(derived.gates.every(gate => gate.passed)).toBe(true);
    expect(derived.gates.map(gate => gate.id)).toEqual([
      'collector-ready-before-first-navigation',
      'targets-attached',
      'http-bodies-complete',
      'scripts-workers-wasm-complete',
      'realtime-channels-complete',
      'no-uncollected-channel',
      'raw-journals-closed',
      'browser-state-written',
      'evidence-references-closed',
      'zip-self-validated',
    ]);
  });

  it('INCOMPLETE 不携带原因代码时 buildPackStatusTriple 拒绝', () => {
    expect(() =>
      buildPackStatusTriple({
        derived: { captureIntegrity: 'INCOMPLETE', reasons: [], gates: [] },
        workflowStatus: 'KVM_REACHED',
        classificationStatus: 'UNKNOWN',
      }),
    ).toThrow(/INCOMPLETE 必须至少携带一个稳定原因代码/);
  });

  it('COMPLETE 携带原因代码时 buildPackStatusTriple 拒绝', () => {
    expect(() =>
      buildPackStatusTriple({
        derived: {
          captureIntegrity: 'COMPLETE',
          reasons: ['INCOMPLETE_BODY_MISSING'],
          gates: [],
        },
        workflowStatus: 'KVM_REACHED',
        classificationStatus: 'UNKNOWN',
      }),
    ).toThrow(/COMPLETE 不允许携带完整度原因代码/);
  });

  it('多个缺失按规范 §14 固定顺序输出原因代码', () => {
    const derived = derivePackIntegrity({
      ...allPresentSummary(),
      missingBodies: [{ id: 'http-000009' }],
      unsupportedChannels: [{ id: 'plugin-channel-1' }],
      workflowStatus: 'TARGET_OPENED',
    });
    expect(derived.reasons).toEqual([
      'INCOMPLETE_BODY_MISSING',
      'INCOMPLETE_UNSUPPORTED_CHANNEL',
      'INCOMPLETE_WORKFLOW_NOT_REACHED',
    ]);
  });
});

describe('resolveLegacyPackImportStatus（规范 §6 / §17）', () => {
  it('旧包 YES / PARTIAL / NO 一律 LEGACY_UNVERIFIED，不能升级 COMPLETE', () => {
    for (const oldReadiness of ['YES', 'PARTIAL', 'NO'] as const) {
      const result = resolveLegacyPackImportStatus({
        oldReadiness,
        hadKvmWebSocketEvidence: true,
        hadLoginEvidence: true,
      });
      expect(result.captureIntegrity).toBe('LEGACY_UNVERIFIED');
      expect(result.workflowStatus).toBe('KVM_REACHED');
      expect(result.classificationStatus).toBe('UNKNOWN');
      expect(canUpgradeCaptureIntegrity(result.captureIntegrity, 'COMPLETE')).toBe(false);
      expect(result.legacyNote).toContain('LEGACY_UNVERIFIED');
    }
  });

  it('旧包按证据映射 workflowStatus，但完整度不变', () => {
    expect(
      resolveLegacyPackImportStatus({ oldReadiness: 'PARTIAL', hadLoginEvidence: true })
        .workflowStatus,
    ).toBe('LOGIN_REACHED');
    expect(resolveLegacyPackImportStatus({ oldReadiness: 'NO' }).workflowStatus).toBe(
      'TARGET_OPENED',
    );
  });

  it('LEGACY_UNVERIFIED 之外的状态允许按证据重判', () => {
    expect(canUpgradeCaptureIntegrity('INCOMPLETE', 'COMPLETE')).toBe(true);
    expect(canUpgradeCaptureIntegrity('COMPLETE', 'INCOMPLETE')).toBe(true);
  });
});

describe('完整度失败 fixtures（规范 §19 阶段 0 / §20）', () => {
  it('每个 INCOMPLETE 稳定代码都有失败 fixture，且派生结果精确命中该代码', () => {
    expect(INTEGRITY_FAILURE_FIXTURES).toHaveLength(11);
    const coveredCodes = new Set(INTEGRITY_FAILURE_FIXTURES.map(fixture => fixture.reason));
    for (const code of [
      'INCOMPLETE_BODY_MISSING',
      'INCOMPLETE_TARGET_ATTACH',
      'INCOMPLETE_WORKER_SOURCE',
      'INCOMPLETE_CHANNEL_GAP',
      'INCOMPLETE_UNSUPPORTED_CHANNEL',
      'INCOMPLETE_STORAGE_LIMIT',
      'INCOMPLETE_EXPORT_VALIDATION',
      'INCOMPLETE_WORKFLOW_NOT_REACHED',
      'INCOMPLETE_RAW_JOURNAL',
      'INCOMPLETE_BROWSER_STATE',
      'INCOMPLETE_EVIDENCE_REFERENCE',
    ] as const) {
      expect(coveredCodes.has(code), code).toBe(true);
    }
    for (const fixture of INTEGRITY_FAILURE_FIXTURES) {
      const derived = derivePackIntegrity(fixture.summary);
      expect(derived.captureIntegrity, fixture.id).toBe('INCOMPLETE');
      expect(derived.reasons, fixture.id).toEqual([fixture.reason]);
      expect(fixture.expected.reasons).toEqual([fixture.reason]);
    }
  });

  it('十项门禁中任何一项失败都会产生原因代码，不允许门禁失败但 COMPLETE', () => {
    // 逐项翻转每个门禁对应的证据字段，派生结果必须是 INCOMPLETE 且带原因。
    const flips: Array<[string, () => PackIntegrityEvidenceSummary]> = [
      ['collector-ready-before-first-navigation', () => ({ ...allPresentSummary(), collectorReadyBeforeFirstNavigation: false })],
      ['targets-attached', () => ({ ...allPresentSummary(), targetAttachFailures: [{ id: 'target-oopif-0001' }] })],
      ['http-bodies-complete', () => ({ ...allPresentSummary(), missingBodies: [{ id: 'http-000001' }] })],
      ['scripts-workers-wasm-complete', () => ({ ...allPresentSummary(), missingWorkerSources: [{ id: 'script-worker-0001' }] })],
      ['realtime-channels-complete', () => ({ ...allPresentSummary(), channelGaps: [{ id: 'ws-0001' }] })],
      ['no-uncollected-channel', () => ({ ...allPresentSummary(), unsupportedChannels: [{ id: 'plugin-1' }] })],
      ['raw-journals-closed', () => ({ ...allPresentSummary(), rawJournalsClosed: false })],
      ['browser-state-written', () => ({ ...allPresentSummary(), browserStateWritten: false })],
      ['evidence-references-closed', () => ({ ...allPresentSummary(), evidenceReferencesClosed: false })],
      ['zip-self-validated', () => ({ ...allPresentSummary(), exportValidationFailures: [{ id: 'checksums.sha256' }] })],
    ];
    expect(flips).toHaveLength(10);
    for (const [gateId, flip] of flips) {
      const derived = derivePackIntegrity(flip());
      expect(derived.captureIntegrity, gateId).toBe('INCOMPLETE');
      expect(derived.reasons.length, gateId).toBeGreaterThan(0);
      const failedGates = derived.gates.filter(gate => !gate.passed).map(gate => gate.id);
      expect(failedGates, gateId).toContain(gateId);
    }
  });

  it('第 12 轮新数组通道：written=true 但 gaps 非空同样失败，缺口明细在列（布尔与数组双通道）', () => {
    // browserStateWritten=true + browserStateGaps 非空：步骤级缺口路径
    const browserStateGap = derivePackIntegrity({
      ...allPresentSummary(),
      browserStateGaps: [{ id: 'cookies', detail: '返回缺少 cookies 数组' }],
    });
    expect(browserStateGap.captureIntegrity).toBe('INCOMPLETE');
    expect(browserStateGap.reasons).toContain('INCOMPLETE_BROWSER_STATE');
    const browserGate = browserStateGap.gates.find(gate => gate.id === 'browser-state-written');
    expect(browserGate?.passed).toBe(false);
    expect(browserGate?.detail).toContain('cookies');

    const evidenceGraphGap = derivePackIntegrity({
      ...allPresentSummary(),
      evidenceGraphFailures: [{ id: 'evidence-graph', detail: 'ai/value-flow.json 写盘失败' }],
    });
    expect(evidenceGraphGap.captureIntegrity).toBe('INCOMPLETE');
    expect(evidenceGraphGap.reasons).toContain('INCOMPLETE_EVIDENCE_REFERENCE');
    const evidenceGate = evidenceGraphGap.gates.find(
      gate => gate.id === 'evidence-references-closed',
    );
    expect(evidenceGate?.passed).toBe(false);
    expect(evidenceGate?.detail).toContain('ai/value-flow.json');

    // 布尔通道 fallback：gaps 空但布尔为假
    const notWritten = derivePackIntegrity({
      ...allPresentSummary(),
      browserStateWritten: false,
    });
    expect(
      notWritten.gates.find(gate => gate.id === 'browser-state-written')?.detail,
    ).toContain('浏览器状态快照未写入');
    const notClosed = derivePackIntegrity({
      ...allPresentSummary(),
      evidenceReferencesClosed: false,
    });
    expect(
      notClosed.gates.find(gate => gate.id === 'evidence-references-closed')?.detail,
    ).toContain('证据图未闭环');
  });

  it('buildPackStatusTriple 拒绝 COMPLETE + 失败门禁', () => {
    const derived = derivePackIntegrity(allPresentSummary());
    // 人为构造「无原因但存在失败门禁」的非法派生结果（回归 0.2 式界面显示完整但资料缺失）。
    const forged: DerivedPackIntegrity = {
      captureIntegrity: 'COMPLETE',
      reasons: [],
      gates: derived.gates.map(gate =>
        gate.id === 'raw-journals-closed' ? { ...gate, passed: false } : gate,
      ),
    };
    expect(() =>
      buildPackStatusTriple({
        derived: forged,
        workflowStatus: 'KVM_REACHED',
        classificationStatus: 'UNKNOWN',
      }),
    ).toThrow(/COMPLETE 不允许存在未通过的门禁/);
  });

  it('buildPackStatusTriple 拒绝空门禁集合与残缺门禁集合', () => {
    expect(() =>
      buildPackStatusTriple({
        derived: { captureIntegrity: 'COMPLETE', reasons: [], gates: [] },
        workflowStatus: 'KVM_REACHED',
        classificationStatus: 'UNKNOWN',
      }),
    ).toThrow(/门禁必须恰好覆盖十个唯一门禁 ID/);
    const derived = derivePackIntegrity(allPresentSummary());
    expect(() =>
      buildPackStatusTriple({
        derived: { ...derived, gates: derived.gates.slice(0, 9) },
        workflowStatus: 'KVM_REACHED',
        classificationStatus: 'UNKNOWN',
      }),
    ).toThrow(/门禁必须恰好覆盖十个唯一门禁 ID/);
    const duplicated: DerivedPackIntegrity = {
      ...derived,
      gates: [...derived.gates.slice(0, 9), derived.gates[0]],
    };
    expect(() =>
      buildPackStatusTriple({
        derived: duplicated,
        workflowStatus: 'KVM_REACHED',
        classificationStatus: 'UNKNOWN',
      }),
    ).toThrow(/门禁必须恰好覆盖十个唯一门禁 ID/);
  });

  it('除目标缺失外其余门禁全部通过（fixture 不夹带别的缺失）', () => {
    for (const fixture of INTEGRITY_FAILURE_FIXTURES) {
      const derived = derivePackIntegrity(fixture.summary);
      const passedGates = new Set(
        derived.gates.filter(gate => gate.passed).map(gate => gate.id),
      );
      expect(passedGates.size, fixture.id).toBeGreaterThanOrEqual(9);
    }
  });

  it('正向 fixture：未知协议全部证据在 → COMPLETE + KVM_REACHED + UNKNOWN 合法', () => {
    const derived = derivePackIntegrity(INTEGRITY_POSITIVE_FIXTURE.summary);
    const triple = buildPackStatusTriple({
      derived,
      workflowStatus: INTEGRITY_POSITIVE_FIXTURE.summary.workflowStatus,
      classificationStatus: 'UNKNOWN',
    });
    expect(triple).toEqual({
      captureIntegrity: 'COMPLETE',
      workflowStatus: 'KVM_REACHED',
      classificationStatus: 'UNKNOWN',
    });
  });
});
