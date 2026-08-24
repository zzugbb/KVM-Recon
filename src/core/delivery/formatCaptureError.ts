export type CaptureErrorCode =
  | 'BMC_UNREACHABLE'
  | 'PERMISSION_LIMITED'
  | 'CERTIFICATE_BLOCKED'
  | 'EXPORT_FAILED'
  | 'UNKNOWN';

interface FormatCaptureErrorInput {
  code: CaptureErrorCode;
  detail?: string;
}

export interface FormattedCaptureError {
  title: string;
  impact: string;
  action: string;
  detail: string;
}

function errorText(error: unknown): string {
  if (error && typeof error === 'object') {
    const record = error as { message?: unknown; code?: unknown };
    return `${record.code ?? ''} ${record.message ?? ''}`.toLowerCase();
  }
  return String(error).toLowerCase();
}

export function classifyCaptureError(error: unknown): CaptureErrorCode {
  const text = errorText(error);
  if (/eperm|eacces|erofs|not permitted|permission denied/.test(text)) {
    return 'PERMISSION_LIMITED';
  }
  if (/enospc|no space left|export/.test(text)) {
    return 'EXPORT_FAILED';
  }
  if (/cert|certificate|err_cert|untrusted|self.?signed/.test(text)) {
    return 'CERTIFICATE_BLOCKED';
  }
  if (
    /econnrefused|etimedout|enotfound|ehostunreach|enetunreach|econnreset|unreachable|timed out/.test(
      text,
    )
  ) {
    return 'BMC_UNREACHABLE';
  }
  return 'UNKNOWN';
}

function cleanDetail(detail = '') {
  return detail.split('\n')[0]?.slice(0, 300) || '';
}

export function formatCaptureError(input: FormatCaptureErrorInput): FormattedCaptureError {
  const detail = cleanDetail(input.detail);

  if (input.code === 'BMC_UNREACHABLE') {
    return {
      title: '无法连接目标 BMC',
      impact: '当前无法采集登录、KVM 入口和 WebSocket 资料，建议不要离场。',
      action: '请现场确认 BMC 地址、端口、网线/VLAN、防火墙和本机网络连通性后重试。',
      detail,
    };
  }

  if (input.code === 'PERMISSION_LIMITED') {
    return {
      title: '当前权限不足',
      impact: '工具无法写入采集文件或导出包，可能导致资料包不完整。',
      action: '请将导出位置改为当前用户可写目录，或联系现场管理员授予写入权限后重试。',
      detail,
    };
  }

  if (input.code === 'CERTIFICATE_BLOCKED') {
    return {
      title: '证书策略阻止访问',
      impact: '内嵌浏览器无法打开目标 BMC 页面，后续登录和 KVM 链路无法采集。',
      action: '请确认目标地址与采集配置一致；仅允许目标 BMC 主机的自签证书例外。',
      detail,
    };
  }

  if (input.code === 'EXPORT_FAILED') {
    return {
      title: 'Capture Pack 导出失败',
      impact: '当前资料尚未形成可带离现场的 zip 包。',
      action: '请确认磁盘空间充足、导出目录可写，然后重新执行“停止采集并导出”。',
      detail,
    };
  }

  return {
    title: '采集过程发生未知错误',
    impact: '资料完整性无法确认，请根据离场验收清单判断是否需要补采。',
    action: '请保留当前报告截图和错误详情，尝试重新采集；若仍失败，请记录目标型号和操作步骤。',
    detail,
  };
}
