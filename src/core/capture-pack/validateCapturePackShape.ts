function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function missing(path: string, value: unknown, errors: string[]) {
  errors.push(`缺少字段 ${path}`);
  void value;
}

export function validateManifestShape(value: unknown): string[] {
  const errors: string[] = [];
  if (!isRecord(value)) {
    return ['manifest.json 不是对象'];
  }
  if (value.schemaVersion !== '1.0.0') {
    errors.push('manifest.schemaVersion 必须是 1.0.0');
  }
  if (!isRecord(value.tool) || value.tool.name !== 'KVM-Recon') {
    missing('manifest.tool.name', value.tool, errors);
  }
  if (!isRecord(value.job) || typeof value.job.id !== 'string') {
    missing('manifest.job.id', value.job, errors);
  }
  if (!isRecord(value.target) || typeof value.target.host !== 'string') {
    missing('manifest.target.host', value.target, errors);
  }
  if (!isRecord(value.family) || typeof value.family.primary !== 'string') {
    missing('manifest.family.primary', value.family, errors);
  }
  if (!isRecord(value.readiness) || !['YES', 'PARTIAL', 'NO'].includes(String(value.readiness.status))) {
    missing('manifest.readiness.status', value.readiness, errors);
  }
  if (!isRecord(value.redaction) || !['pass', 'fail'].includes(String(value.redaction.status))) {
    missing('manifest.redaction.status', value.redaction, errors);
  }
  return errors;
}

export function validateChecklistShape(value: unknown): string[] {
  const errors: string[] = [];
  if (!isRecord(value)) {
    return ['checklist.json 不是对象'];
  }
  if (!['YES', 'PARTIAL', 'NO'].includes(String(value.readiness))) {
    errors.push('checklist.readiness 必须是 YES / PARTIAL / NO');
  }
  if (!Array.isArray(value.items)) {
    errors.push('checklist.items 必须是数组');
    return errors;
  }
  for (const [index, item] of value.items.entries()) {
    if (!isRecord(item) || typeof item.id !== 'string' || typeof item.title !== 'string') {
      errors.push(`checklist.items[${index}] 缺少 id 或 title`);
    }
  }
  return errors;
}

export function validateWebSocketListShape(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return ['ws/sockets.json 必须是数组'];
  }
  const errors: string[] = [];
  for (const [index, item] of value.entries()) {
    if (!isRecord(item) || typeof item.id !== 'string' || typeof item.url !== 'string') {
      errors.push(`ws/sockets.json[${index}] 缺少 id 或 url`);
    }
  }
  return errors;
}

export function validateHttpRequestLineShape(value: unknown): string[] {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.url !== 'string') {
    return ['http/requests.jsonl 行缺少 id 或 url'];
  }
  return [];
}
