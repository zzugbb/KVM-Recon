const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)/;

export function packRequiresReferencedRequiredField(packVersion?: string): boolean {
  const version = String(packVersion || '').trim();
  if (!version) return true;
  const match = VERSION_RE.exec(version);
  if (!match) return true;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (major > 0) return true;
  if (minor > 2) return true;
  return minor === 2 && patch >= 7;
}

export function referencedSourceIsRequired(required: unknown): boolean {
  if (typeof required === 'boolean') return required;
  // 旧包缺字段：按关键引用处理，不能默认为非关键而放过 YES
  return true;
}
