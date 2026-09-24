import { describe, expect, it } from 'vitest';

import {
  INCOMPLETE_REASON_CODES,
  incompleteReasonInfo,
  sortIncompleteReasons,
} from './incompleteReasons';

describe('incompleteReasons（规范 §14 稳定代码）', () => {
  it('十一个稳定代码与规范 §14 顺序一致', () => {
    expect(INCOMPLETE_REASON_CODES).toEqual([
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
    ]);
  });

  it('每个代码都有面向现场用户的标题、影响说明与补救动作', () => {
    for (const code of INCOMPLETE_REASON_CODES) {
      const info = incompleteReasonInfo(code);
      expect(info.code).toBe(code);
      expect(info.title.length).toBeGreaterThan(0);
      expect(info.summary.length).toBeGreaterThan(0);
      expect(info.userAction.length).toBeGreaterThan(0);
    }
  });

  it('未知代码抛错；sortIncompleteReasons 按规范顺序去重排序', () => {
    expect(() => incompleteReasonInfo('INCOMPLETE_SOMETHING_NEW' as never)).toThrow();
    expect(
      sortIncompleteReasons([
        'INCOMPLETE_WORKFLOW_NOT_REACHED',
        'INCOMPLETE_BODY_MISSING',
        'INCOMPLETE_BODY_MISSING',
      ]),
    ).toEqual(['INCOMPLETE_BODY_MISSING', 'INCOMPLETE_WORKFLOW_NOT_REACHED']);
  });
});
