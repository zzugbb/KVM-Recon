import type { CapturePackArtifact, CaptureReadiness } from '../capture-pack/types';
import type { OperatorObservedAsset } from './operatorObserved';
import { hasStructuredObserved, normalizeOperatorObserved } from './operatorObserved';

interface BuildPackReadmeArtifactInput {
  kvmFamily: string;
  familyConfidence: number;
  readiness: CaptureReadiness;
  blockingTitles: string[];
  warningTitles: string[];
  operatorNote?: string;
  operatorObserved?: Partial<OperatorObservedAsset> | null;
  httpRequestCount: number;
  webSocketCount: number;
  webSocketUrls: string[];
  screenshotCount: number;
  hasOemProfile: boolean;
  hasAuthenticated: boolean;
  cookieNames: string[];
}

function joinOrNone(values: string[]) {
  return values.filter(Boolean).join('、') || '（无）';
}

function titleList(titles: string[]) {
  if (titles.length === 0) return '（无）';
  return titles.join('、');
}

export function buildPackReadmeArtifact(input: BuildPackReadmeArtifactInput): CapturePackArtifact {
  const observed = normalizeOperatorObserved({
    ...input.operatorObserved,
    note: input.operatorObserved?.note ?? input.operatorNote,
  });
  const profileLine = input.hasOemProfile
    ? '已知族草稿在 `artifacts/oem-profile.yaml`，只供审核，不是可上线的 Adapter。'
    : '未知/非 H5 族没有 Profile 草稿。阅读本包判断协议即可，不要指望采集工具写出 Adapter。';
  const readinessAdvice =
    input.readiness === 'YES'
      ? '资料较齐，可按下面地图阅读后做适配。'
      : input.readiness === 'PARTIAL'
        ? '能分析，但可能缺项。先看未齐项，再决定写草稿还是回现场补采。'
        : '关键资料不足。不要用残缺包硬写网关，按 checklist 补采。';

  return {
    path: 'README.md',
    content: [
      '# KVM-Recon Capture Pack',
      '',
      '这是一份**脱敏事实包**，用来给现有 KVM 网关做 HTML5 兼容适配。',
      'KVM-Recon 只负责机房离线采集，**不写 Adapter**。解压后先读本文件即可，不必再打开采集工具仓库。',
      '',
      '## 本包摘要',
      '',
      `- kvmFamily：${input.kvmFamily}（置信度 ${input.familyConfidence}）`,
      `- 离场结论：${input.readiness}。${readinessAdvice}`,
      `- HTTP 请求：${input.httpRequestCount}；WebSocket：${input.webSocketCount}；KVM 画面截图：${input.screenshotCount}`,
      `- WebSocket URL：${joinOrNone(input.webSocketUrls)}`,
      `- 登录后复验：${input.hasAuthenticated ? '有 `probe/authenticated.json`' : '未做'}`,
      `- Cookie 名（无值）：${joinOrNone(input.cookieNames)}`,
      `- 未齐（阻断）：${titleList(input.blockingTitles)}`,
      `- 未齐（警告）：${titleList(input.warningTitles)}`,
      `- 现场厂商：${observed.vendor || '（无）'}`,
      `- 现场型号：${observed.product || '（无）'}`,
      `- 现场固件：${observed.firmware || '（无）'}`,
      `- 机柜位置：${observed.location || '（无）'}`,
      `- 作业备注：${observed.note || '（无）'}`,
      ...(hasStructuredObserved(observed)
        ? ['- 现场厂商/型号只是铭牌证据，不能替代 kvmFamily。']
        : []),
      `- ${profileLine}`,
      '',
      '## 阅读顺序',
      '',
      '1. 本文件。',
      '2. `manifest.json`：作业、目标、kvmFamily、就绪结论。',
      '3. `checklist.json` 或 `report.html`：缺什么、要不要补采。',
      '4. 按「文件做什么」打开对应目录，不要通读全部 jsonl。',
      '',
      '## 文件做什么',
      '',
      '| 路径 | 用来回答 |',
      '| --- | --- |',
      '| `manifest.json` | 这是哪次作业、目标地址、工具判定的 kvmFamily |',
      '| `checklist.json` / `report.html` | 离场能否适配、缺哪一项 |',
      '| `probe/bmc-basic.json` | 匿名探测到的厂商/型号/固件（可能为空） |',
      '| `probe/family-signatures.json` | 为何判成这一族、证据路径 |',
      '| `probe/path-evidence.json` | 指纹路径是否为 JSON/API 命中（HTML 200 不算） |',
      '| `probe/redfish.json` | Redfish 根是否通、根上的原始字段 |',
      '| `probe/operator-observed.json` | 现场看铭牌填的厂商/型号（可选） |',
      '| `probe/authenticated.json` | 登录后复验：Cookie 名和带会话后的路径（可选，无 Cookie 值） |',
      '| `http/requests.jsonl` | 登录、KVM token、入口相关 HTTP；看 tags 与 URL |',
      '| `http/har.json` | 同上，HAR 格式，便于用现成工具打开 |',
      '| `ws/sockets.json` | KVM WebSocket 的 URL、子协议、帧数量、是否 popup |',
      '| `ws/frames.jsonl` | 采样帧的 headHex / magic，不是完整视频 |',
      '| `page/timeline.jsonl` | 打开了哪些页、点了什么、何时截图 |',
      '| `page/selectors.json` | 登录/KVM 入口/viewer 的候选选择器 |',
      '| `page/storage.json` | storage 的 key 列表，不含明文值 |',
      '| `page/screenshots.json` 与 `page/screenshots/` | 证明当时画面形态，不是码流 |',
      '| `tls/certificate.json` | 自签/协议/cipher，方便网关侧 TLS 策略 |',
      '| `artifacts/oem-profile.yaml` | 已知族的审核草稿，不是生产 Adapter |',
      '| `artifacts/notes.md` | 未知族备注（若有） |',
      '',
      '## 动手前先裁定',
      '',
      '### 本包已经能回答',
      '',
      `- 工具判定的族是 ${input.kvmFamily}，离场结论是 ${input.readiness}。`,
      `- 登录相关 HTTP 在 \`http/requests.jsonl\`（tags 含 login / kvm-token / kvm-entry）。`,
      `- KVM 画面通道看 \`ws/sockets.json\` 与 \`ws/frames.jsonl\`。URL：${joinOrNone(input.webSocketUrls)}。`,
      `- 有没有 viewer 截图：${input.screenshotCount > 0 ? `有 ${input.screenshotCount} 张` : '没有'}。`,
      `- 还缺什么：阻断 ${titleList(input.blockingTitles)}；警告 ${titleList(input.warningTitles)}。`,
      '',
      '### 必须问人或看网关仓库（本包没有）',
      '',
      '- 要适配进哪套网关代码？接口、目录、已有 Adapter 长什么样？',
      '- 那边是否已有 `ami-megarac` / `openbmc-h5` / `huawei-ibmc` 实现，这次是改 Profile 还是新建 Adapter？',
      '- 成功标准是什么：能反代登录即可，还是必须打通 WS / 画面 / WebCrypto？',
      '- 若结论不是 YES：先写草稿，还是等现场补采后再写？',
      '',
      '答不出上面四项时，先问人，不要假设一套网关 API 然后生成代码。',
      '',
      '## 不要做',
      '',
      '- 不要把本包当成可上线 Adapter，也不要补造 BMC 未出现的接口。',
      '- 不要把铭牌厂商/型号当成 kvmFamily。',
      '- 包内没有明文密码、Cookie 值、storage 值、完整 KVM 视频；不要向现场人员索要这些往包里填。',
      '- 结论为 NO 时不要硬写网关。',
      '',
    ].join('\n'),
  };
}
