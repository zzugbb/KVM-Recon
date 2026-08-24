import type {
  CaptureChecklist,
  CapturePackDraft,
  ChecklistItem,
  ChecklistSeverity,
} from '../capture-pack/types';

function problemItems(checklist: CaptureChecklist): ChecklistItem[] {
  return checklist.items.filter(
    item => item.status !== 'pass' && item.status !== 'not_applicable',
  );
}

function countProblems(checklist: CaptureChecklist, severity: ChecklistSeverity) {
  return problemItems(checklist).filter(item => item.severity === severity).length;
}

function markdownLineForItem(item: ChecklistItem) {
  const evidence = item.evidence.length ? `证据：${item.evidence.join(', ')}` : '证据：无';
  const action = item.userAction ? `补采动作：${item.userAction}` : '补采动作：无';
  return `- ${item.title}：${item.status} / ${item.severity}；${evidence}；${action}`;
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildReadinessReportMarkdown(checklist: CaptureChecklist): string {
  const blockingCount = countProblems(checklist, 'blocking');
  const warningCount = countProblems(checklist, 'warning');
  const problems = problemItems(checklist);

  return [
    '# KVM-Recon Capture Report',
    '',
    `离场适配就绪：${checklist.readiness}`,
    '',
    `阻断项：${blockingCount}`,
    `警告项：${warningCount}`,
    '',
    '## 检查项',
    ...checklist.items.map(markdownLineForItem),
    '',
    '## 现场补采提示',
    ...(problems.length
      ? problems.map(item => `- ${item.title}：${item.userAction || '无需现场动作。'}`)
      : ['- 当前关键资料完整，可离场后继续分析。']),
  ].join('\n');
}

function buildReadinessReportHtml(checklist: CaptureChecklist): string {
  const markdown = buildReadinessReportMarkdown(checklist);
  const lines = markdown
    .split('\n')
    .map(line => {
      if (line.startsWith('# ')) return `<h1>${escapeHtml(line.slice(2))}</h1>`;
      if (line.startsWith('## ')) return `<h2>${escapeHtml(line.slice(3))}</h2>`;
      if (line.startsWith('- ')) return `<li>${escapeHtml(line.slice(2))}</li>`;
      if (!line) return '';
      return `<p>${escapeHtml(line)}</p>`;
    })
    .join('\n');

  return [
    '<!doctype html>',
    '<html lang="zh-CN">',
    '<head>',
    '<meta charset="utf-8" />',
    '<title>KVM-Recon Capture Report</title>',
    '<style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;line-height:1.6;padding:24px;color:#111827;}li{margin:6px 0;}code{background:#f3f4f6;padding:2px 4px;border-radius:4px;}</style>',
    '</head>',
    '<body>',
    lines,
    '</body>',
    '</html>',
  ].join('\n');
}

function uniqueFiles(files: string[]) {
  return [...new Set(files)];
}

export function applyReadinessToCapturePack(
  pack: CapturePackDraft,
  checklist: CaptureChecklist,
): CapturePackDraft {
  const blockingCount = countProblems(checklist, 'blocking');
  const warningCount = countProblems(checklist, 'warning');

  return {
    ...pack,
    manifest: {
      ...pack.manifest,
      readiness: {
        status: checklist.readiness,
        blockingCount,
        warningCount,
      },
    },
    checklist,
    reportMarkdown: buildReadinessReportMarkdown(checklist),
    reportHtml: buildReadinessReportHtml(checklist),
    files: uniqueFiles([...pack.files, 'report.html']),
  };
}
