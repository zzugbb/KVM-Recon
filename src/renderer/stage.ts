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
      return '等待输入';
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
