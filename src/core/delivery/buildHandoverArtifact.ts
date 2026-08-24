import type { CapturePackArtifact, CaptureReadiness } from '../capture-pack/types';
import type { OperatorObservedAsset } from './operatorObserved';
import { hasStructuredObserved, normalizeOperatorObserved } from './operatorObserved';

interface BuildHandoverArtifactInput {
  kvmFamily: string;
  readiness: CaptureReadiness;
  operatorNote?: string;
  operatorObserved?: Partial<OperatorObservedAsset> | null;
  httpRequestCount: number;
  webSocketCount: number;
  screenshotCount: number;
  hasOemProfile: boolean;
}

export function buildHandoverArtifact(input: BuildHandoverArtifactInput): CapturePackArtifact {
  const observed = normalizeOperatorObserved({
    ...input.operatorObserved,
    note: input.operatorObserved?.note ?? input.operatorNote,
  });
  const nextStep = input.hasOemProfile
    ? '已知族草稿在 `artifacts/oem-profile.yaml`，供出机房后人工或 AI 审核，不是可直接上线的 Adapter。'
    : '未知/非 H5 族没有 Profile。出机房后请将本包交给工程师或 AI 判断协议，不要期望本工具写出 Adapter。';

  return {
    path: 'artifacts/handover.md',
    content: [
      '# Capture Pack 离场交接说明',
      '',
      'KVM-Recon 是机房离线采集工具，不是 KVM 网关，也不会根据本包在现场编写 Adapter。',
      '机房内通常没有公网；分析、写 Profile/Adapter 应在出机房并联网之后进行。',
      '',
      '## 本包摘要',
      '',
      `- kvmFamily：${input.kvmFamily}`,
      `- 离场结论：${input.readiness}`,
      `- HTTP 请求：${input.httpRequestCount}`,
      `- WebSocket 连接：${input.webSocketCount}`,
      `- 页面截图：${input.screenshotCount}`,
      `- 现场厂商：${observed.vendor || '（无）'}`,
      `- 现场型号：${observed.product || '（无）'}`,
      `- 现场固件：${observed.firmware || '（无）'}`,
      `- 机柜位置：${observed.location || '（无）'}`,
      `- 作业备注：${observed.note || '（无）'}`,
      ...(hasStructuredObserved(observed)
        ? ['- 现场厂商/型号只是铭牌证据，不能替代 kvmFamily。']
        : []),
      '',
      '## 出机房后建议',
      '',
      '1. 打开 `report.html` 或 `checklist.json`，确认 YES / PARTIAL / NO。',
      '2. 将本 zip 交给工程师或 AI，重点阅读 `probe/`、`http/`、`ws/`、`page/`、`tls/`。',
      `3. ${nextStep}`,
      '4. 若结论为 NO 或关键项缺失，按报告回现场补采，不要用残缺包硬写网关。',
      '',
    ].join('\n'),
  };
}
