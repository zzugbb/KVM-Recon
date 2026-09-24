/**
 * 页面阶段派生（规范 §5.3：主窗口只表现这 8 个阶段）。
 *
 * 纯函数：从状态载荷（+ 渲染层本地的启动中标志）映射页面阶段与
 * 阶段条（连接目标 / 登录活动 / Viewer 活动 / 完整性校验）的三态。
 * 收尾后的预导出完整度只用于阶段文案；没有派生出 COMPLETE 就按
 * incomplete 处理（不主张未验证的完整）。
 */

export type PageStage =
  | 'idle'
  | 'launching'
  | 'capturing-login'
  | 'capturing-viewer'
  | 'finalizing'
  | 'complete'
  | 'incomplete'
  | 'exported';

export interface StageInput {
  job: {
    state: 'capturing' | 'stopped' | 'exported';
    workflowStatus: 'TARGET_OPENED' | 'LOGIN_REACHED' | 'KVM_REACHED';
    finalizing: boolean;
    captureIntegrity: 'COMPLETE' | 'INCOMPLETE' | null;
  } | null;
  /** startCapture invoke 进行中（渲染层本地状态，载荷里没有）。 */
  launching: boolean;
}

export function derivePageStage(input: StageInput): PageStage {
  const { job } = input;
  if (!job) return input.launching ? 'launching' : 'idle';
  if (job.state === 'exported') return 'exported';
  if (job.state === 'capturing') {
    if (job.finalizing) return 'finalizing';
    if (job.workflowStatus === 'KVM_REACHED') return 'finalizing';
    return job.workflowStatus === 'LOGIN_REACHED' ? 'capturing-viewer' : 'capturing-login';
  }
  return job.captureIntegrity === 'COMPLETE' ? 'complete' : 'incomplete';
}

export const STAGE_BAR_STEPS = ['连接目标', '登录活动', 'Viewer 活动', '完整性校验'] as const;

export type StageStepState = 'pending' | 'active' | 'done';

/** 阶段条三态：按阶段顺序点亮，后一阶段开始即前一阶段完成。 */
export function stageBarOf(stage: PageStage): StageStepState[] {
  switch (stage) {
    case 'idle':
      return ['pending', 'pending', 'pending', 'pending'];
    case 'launching':
      return ['active', 'pending', 'pending', 'pending'];
    case 'capturing-login':
      return ['done', 'active', 'pending', 'pending'];
    case 'capturing-viewer':
      return ['done', 'done', 'active', 'pending'];
    case 'finalizing':
      return ['done', 'done', 'done', 'active'];
    case 'complete':
    case 'incomplete':
    case 'exported':
      return ['done', 'done', 'done', 'done'];
  }
}

/** §5.3 阶段表的用户可见状态短句。 */
export function stageStatusText(stage: PageStage): string {
  switch (stage) {
    case 'idle':
      return '新建采集';
    case 'launching':
      return '正在准备隔离浏览器';
    case 'capturing-login':
      return '请在采集窗口登录 BMC';
    case 'capturing-viewer':
      return '请打开 HTML5 KVM';
    case 'finalizing':
      return '已检测到远程控制台，正在收尾';
    case 'complete':
      return '采集完整，可以导出';
    case 'incomplete':
      return '采集不完整，已列出具体缺失';
    case 'exported':
      return '已导出并校验';
  }
}

/** 状态标题下的下一步提示：只说现场人员此刻要做什么（规范 §5.1：不显示大段说明）。 */
export function stageHintText(stage: PageStage): string {
  switch (stage) {
    case 'idle':
      return '填写 BMC 地址后开始采集，工具会打开隔离的采集窗口。';
    case 'launching':
      return '正在挂载记录器，采集窗口随后打开。';
    case 'capturing-login':
      return '在弹出的采集窗口中手动登录，登录成功后这里会自动进入下一步。';
    case 'capturing-viewer':
      return '登录已确认。点击设备的远程控制台 / HTML5 KVM，并保持弹窗打开。';
    case 'finalizing':
      return '请保持 Viewer 窗口打开，画面稳定后自动收尾，无需操作。';
    case 'complete':
      return '十项门禁全部通过，点击导出并选择保存位置。';
    case 'incomplete':
      return '仍可导出未完整包；需要完整资料时，导出后重新采集这台设备。';
    case 'exported':
      return '采集包已写入并通过自校验，可以打开所在文件夹或采集下一台。';
  }
}

export type StageTone = 'neutral' | 'info' | 'accent' | 'success' | 'warning';

/**
 * 状态面板色调：进行中为信息蓝，收尾为主强调色，完整为绿，
 * 不完整为琥珀（仍可导出，不是失败）。导出后按导出结果着色。
 */
export function stageToneOf(stage: PageStage, exportedIntegrity?: string | null): StageTone {
  switch (stage) {
    case 'idle':
      return 'neutral';
    case 'launching':
    case 'capturing-login':
    case 'capturing-viewer':
      return 'info';
    case 'finalizing':
      return 'accent';
    case 'complete':
      return 'success';
    case 'incomplete':
      return 'warning';
    case 'exported':
      return exportedIntegrity === 'COMPLETE' ? 'success' : 'warning';
  }
}
