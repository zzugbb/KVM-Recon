import { createHash } from 'node:crypto';

type JsonLike =
  | string
  | number
  | boolean
  | null
  | JsonLike[]
  | { [key: string]: JsonLike };

interface RedactionResult<T> {
  data: T;
  redactedFields: number;
}

const SENSITIVE_KEY_RE =
  /password|passwd|pwd|token|csrf|cookie|sessionid|session_id|qsessionid|uniqueid|authparam|garc|x-auth-token/i;

function redactValue(value: unknown): string {
  const text = String(value ?? '');
  const hash = createHash('sha256').update(text).digest('hex').slice(0, 16);
  return `<redacted:sha256:${hash}:len:${text.length}>`;
}

function redactCookieHeader(value: string): string {
  return value.replace(/([^;=\s]+)=([^;]*)/g, (full, name, cookieValue) => {
    if (/^(path|domain|expires|max-age|samesite)$/i.test(name)) return full;
    return `${name}=${redactValue(cookieValue)}`;
  });
}

function redactAny(value: JsonLike, parentKey = ''): RedactionResult<JsonLike> {
  if (SENSITIVE_KEY_RE.test(parentKey)) {
    if (/^(cookie|set-cookie)$/i.test(parentKey) && typeof value === 'string') {
      return {
        data: redactCookieHeader(value),
        redactedFields: 1,
      };
    }
    return {
      data: redactValue(value),
      redactedFields: 1,
    };
  }

  if (Array.isArray(value)) {
    let redactedFields = 0;
    const data = value.map(item => {
      const redacted = redactAny(item);
      redactedFields += redacted.redactedFields;
      return redacted.data;
    });
    return { data, redactedFields };
  }

  if (value && typeof value === 'object') {
    let redactedFields = 0;
    const data: Record<string, JsonLike> = {};
    for (const [key, item] of Object.entries(value)) {
      const redacted = redactAny(item, key);
      data[key] = redacted.data;
      redactedFields += redacted.redactedFields;
    }
    return { data, redactedFields };
  }

  return {
    data: value,
    redactedFields: 0,
  };
}

export function redactSensitiveData<T extends JsonLike>(data: T): RedactionResult<T> {
  const result = redactAny(data);
  return {
    data: result.data as T,
    redactedFields: result.redactedFields,
  };
}

export function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    let changed = false;
    for (const [key, value] of parsed.searchParams.entries()) {
      if (SENSITIVE_KEY_RE.test(key)) {
        parsed.searchParams.set(key, redactValue(value));
        changed = true;
      }
    }
    return changed ? parsed.toString() : url;
  } catch {
    return url;
  }
}

export function assertNoSensitivePlaintext(
  data: unknown,
  sensitiveValues: string[],
): { ok: boolean; leaks: string[] } {
  const serialized = JSON.stringify(data);
  const leaks = sensitiveValues.filter(value => value && serialized.includes(value));

  return {
    ok: leaks.length === 0,
    leaks,
  };
}
