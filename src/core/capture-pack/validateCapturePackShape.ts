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

export function validateRequiredPackFiles(paths: string[]): string[] {
  if (paths.includes('README.md')) {
    return [];
  }
  return ['缺少 README.md'];
}

const SCREENSHOT_ROLES = ['login', 'home', 'kvm-entry', 'viewer', 'error', 'unknown'];

export function validateScreenshotIndexShape(value: unknown): string[] {
  if (value == null) {
    return [];
  }
  if (!Array.isArray(value)) {
    return ['page/screenshots.json 必须是数组'];
  }
  const errors: string[] = [];
  for (const [index, item] of value.entries()) {
    if (!isRecord(item) || typeof item.path !== 'string') {
      errors.push(`page/screenshots.json[${index}] 缺少 path`);
      continue;
    }
    if (typeof item.role !== 'string' || !SCREENSHOT_ROLES.includes(item.role)) {
      errors.push(`page/screenshots.json[${index}] 缺少 role`);
    }
  }
  return errors;
}

export function validateTimelineLineShape(value: unknown): string[] {
  if (!isRecord(value) || typeof value.type !== 'string') {
    return ['page/timeline.jsonl 行缺少 type'];
  }
  if (value.type === 'navigate') {
    return ['page/timeline.jsonl 导航类型必须是 navigation，不是 navigate'];
  }
  if (value.type === 'screenshot') {
    if (typeof value.path !== 'string' || !value.path) {
      return ['page/timeline.jsonl 截图行缺少 path'];
    }
    if (typeof value.role !== 'string' || !SCREENSHOT_ROLES.includes(value.role)) {
      return ['page/timeline.jsonl 截图行缺少 role'];
    }
  }
  if (value.type === 'page-scripts' && !Array.isArray(value.scripts)) {
    return ['page/timeline.jsonl page-scripts 行缺少 scripts'];
  }
  return [];
}

export function validateSourceInventoryShape(value: unknown): string[] {
  if (value == null) return [];
  if (!isRecord(value) || !Array.isArray(value.files)) {
    return ['http/sources.json 必须包含 files 数组'];
  }
  const errors: string[] = [];
  const paths = new Set<string>();
  for (const [index, item] of value.files.entries()) {
    if (
      !isRecord(item) ||
      typeof item.id !== 'string' ||
      typeof item.url !== 'string' ||
      typeof item.path !== 'string' ||
      typeof item.sha256 !== 'string' ||
      typeof item.bytes !== 'number'
    ) {
      errors.push(`http/sources.json.files[${index}] 缺少 id/url/path/sha256/bytes`);
      continue;
    }
    if (paths.has(item.path)) {
      errors.push(`http/sources.json 重复路径 ${item.path}`);
    }
    paths.add(item.path);
  }
  if (value.referenced != null) {
    if (!Array.isArray(value.referenced)) {
      errors.push('http/sources.json.referenced 必须是数组');
    } else {
      for (const [index, item] of value.referenced.entries()) {
        if (!isRecord(item) || typeof item.url !== 'string') {
          errors.push(`http/sources.json.referenced[${index}] 缺少 url`);
        }
      }
    }
  }
  return errors;
}

export function validateSourceInventoryIntegrity(input: {
  inventory: unknown;
  packPaths: string[];
  fileBytes: Map<string, { bytes: number; sha256: string }>;
  family?: string;
  readiness?: string;
}): string[] {
  const inventory = input.inventory;
  if (inventory == null) {
    if (
      input.readiness === 'YES' &&
      (input.family === 'unknown-h5' || input.family === 'not-h5')
    ) {
      return ['未知族 YES 缺少 http/sources.json 完整源码'];
    }
    return [];
  }
  const errors = validateSourceInventoryShape(inventory);
  if (!isRecord(inventory) || !Array.isArray(inventory.files)) return errors;
  let completeFiles = 0;
  for (const [index, item] of inventory.files.entries()) {
    if (!isRecord(item) || typeof item.path !== 'string') continue;
    if (!input.packPaths.includes(item.path)) {
      errors.push(`http/sources.json.files[${index}] 引用的文件不存在: ${item.path}`);
      continue;
    }
    const actual = input.fileBytes.get(item.path);
    if (!actual) continue;
    if (typeof item.bytes === 'number' && item.bytes !== actual.bytes) {
      errors.push(`http/sources.json.files[${index}] 字节数不匹配`);
    }
    if (typeof item.sha256 === 'string' && item.sha256 && item.sha256 !== actual.sha256) {
      errors.push(`http/sources.json.files[${index}] SHA-256 不匹配`);
    }
    if (item.truncated === false) completeFiles += 1;
  }
  if (Array.isArray(inventory.referenced)) {
    for (const [index, item] of inventory.referenced.entries()) {
      if (isRecord(item) && item.missing === true && input.readiness === 'YES') {
        errors.push(`http/sources.json.referenced[${index}] 页面引用缺失源码文件`);
      }
    }
  }
  if (
    input.readiness === 'YES' &&
    (input.family === 'unknown-h5' || input.family === 'not-h5') &&
    completeFiles === 0
  ) {
    errors.push('未知族 YES 必须包含至少一份完整源码文件');
  }
  return errors;
}
