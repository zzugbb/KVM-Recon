import type { IncompleteReasonCode } from './types';

/**
 * 完整度原因稳定代码与面向现场用户的元数据（规范 §14）。
 * 顺序固定为规范 §14 列出顺序；派生原因时按此顺序输出。
 */

export interface IncompleteReasonInfo {
  code: IncompleteReasonCode;
  title: string;
  summary: string;
  userAction: string;
}

export const INCOMPLETE_REASON_CODES: readonly IncompleteReasonCode[] = [
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
];

const REASON_INFOS: ReadonlyMap<IncompleteReasonCode, IncompleteReasonInfo> = new Map(
  INCOMPLETE_REASON_CODES.map(code => {
    const infos: Record<IncompleteReasonCode, IncompleteReasonInfo> = {
      INCOMPLETE_BODY_MISSING: {
        code,
        title: '响应正文缺失',
        summary: '部分 HTTP 响应正文没有写入磁盘，离场后无法还原请求与响应的完整内容。',
        userAction: '回到采集窗口刷新相关页面，或关闭 HTML5 KVM 后重新打开一次，再导出。',
      },
      INCOMPLETE_TARGET_ATTACH: {
        code,
        title: '浏览器目标未挂载',
        summary: '有窗口、iframe 或 Worker 未能自动挂载记录器，该目标内的网络事实可能缺失。',
        userAction: '关闭弹窗或 Viewer 后重新打开一次；仍失败请导出未完整包并记录提示。',
      },
      INCOMPLETE_WORKER_SOURCE: {
        code,
        title: '脚本 / Worker / WASM 源码缺失',
        summary: 'Viewer 依赖的脚本、Worker 或 WASM 内容没有完整写入磁盘。',
        userAction: '关闭 HTML5 KVM 后重新打开一次；仍缺失请导出未完整包并记录提示。',
      },
      INCOMPLETE_CHANNEL_GAP: {
        code,
        title: '实时通道断档',
        summary: 'WebSocket 等实时通道的部分握手或双向数据没有写入磁盘。',
        userAction: '关闭 HTML5 KVM 后重新打开一次，让通道重新建立，再导出。',
      },
      INCOMPLETE_UNSUPPORTED_CHANNEL: {
        code,
        title: '存在无法采集的通道',
        summary: '检测到浏览器之外的客户端通道（如 Java 控制台、本地进程或浏览器插件），工具无法记录其内容。',
        userAction: '改用 HTML5 KVM 入口重新采集；若该设备只有浏览器外通道，请按未完整包导出并记录。',
      },
      INCOMPLETE_STORAGE_LIMIT: {
        code,
        title: '磁盘安全余量不足',
        summary: '磁盘接近安全余量，采集已停止写入新的大流量数据。',
        userAction: '清理磁盘空间后新建作业重新采集。',
      },
      INCOMPLETE_EXPORT_VALIDATION: {
        code,
        title: '导出包自校验失败',
        summary: '导出的 ZIP 重新打开校验时发现清单、大小或 SHA-256 不一致。',
        userAction: '重新导出到其他位置；仍失败请更换导出目录或磁盘后重试。',
      },
      INCOMPLETE_WORKFLOW_NOT_REACHED: {
        code,
        title: '未到达 HTML5 KVM',
        summary: '还没有观察到登录后打开 HTML5 KVM 的活动，适配所需的关键事实尚未采集。',
        userAction: '在采集窗口登录 BMC 后点击「远程控制台 / HTML5 KVM」，等状态变为采集完整后再导出。',
      },
      INCOMPLETE_RAW_JOURNAL: {
        code,
        title: '原始浏览器日志未正常写入',
        summary: '原始 CDP journal 或 NetLog 没有正常关闭并写入磁盘，未来重新分析所需的原始事实可能缺失。',
        userAction: '新建作业重新采集；再次出现请导出未完整包并记录提示。',
      },
      INCOMPLETE_BROWSER_STATE: {
        code,
        title: '浏览器状态资料写入失败',
        summary: '页面、截图、Storage、console 或运行环境资料没有成功写入磁盘。',
        userAction: '回到采集窗口刷新页面或重开 HTML5 KVM 后再导出；仍失败请导出未完整包。',
      },
      INCOMPLETE_EVIDENCE_REFERENCE: {
        code,
        title: '证据引用存在悬空',
        summary: '资源图引用的正文、脚本或通道文件在包内缺失或校验不一致。',
        userAction: '重新导出一次；仍出现请更换导出位置后重试，并保留失败包供分析。',
      },
    };
    return [code, infos[code]];
  }),
);

export function incompleteReasonInfo(code: IncompleteReasonCode): IncompleteReasonInfo {
  const info = REASON_INFOS.get(code);
  if (!info) {
    throw new Error(`未知完整度原因代码：${code}`);
  }
  return info;
}

/** 按 INCOMPLETE_REASON_CODES 的固定顺序对原因代码排序去重。 */
export function sortIncompleteReasons(codes: readonly IncompleteReasonCode[]): IncompleteReasonCode[] {
  const unique = new Set(codes);
  return INCOMPLETE_REASON_CODES.filter(code => unique.has(code));
}
