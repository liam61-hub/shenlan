const REDACTED = '[REDACTED]';
const MAX_FIELDS = 50;

function normalizedKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isSensitiveField(key: string): boolean {
  const normalized = normalizedKey(key);
  if (/(?:apikey|password|passwd|secret|authorization|bearer|credential|accesstoken|refreshtoken)/.test(normalized)) {
    return true;
  }
  const metadataSuffix = /(?:len|length|count|size|chars|tokens|bytes|code|status|id)$/;
  return !metadataSuffix.test(normalized) &&
    /(?:prompt|messages?|content|body|args|arguments|command|headers?|url|path|cwd|file|goal|task|error|stderr|stdout)/.test(normalized);
}

function summarizeValue(value: unknown): unknown {
  if (typeof value === 'string') return `[string length=${value.length}]`;
  if (Array.isArray(value)) return `[array length=${value.length}]`;
  if (value !== null && typeof value === 'object') return '[object]';
  if (typeof value === 'number') return Number.isFinite(value) ? value : '[non-finite number]';
  if (typeof value === 'boolean' || value === null) return value;
  return `[${typeof value}]`;
}

function safeLabel(value: string): string {
  return value
    .replace(/\b(?:sk|pk)-[A-Za-z0-9_-]{8,}\b/gi, REDACTED)
    .replace(/\bBearer\s+\S+/gi, `Bearer ${REDACTED}`)
    .replace(/\b(api[_-]?key|password|secret|token)\s*[:=]\s*[^\s,;]+/gi, `$1=${REDACTED}`)
    .replace(/[\r\n\t]/g, ' ')
    .slice(0, 100);
}

/** Keep scalar metadata while removing arbitrary text and nested payloads. */
export function sanitizeLogMetadata(data: Record<string, unknown>): Record<string, unknown> {
  const entries = Object.entries(data);
  const result: Record<string, unknown> = {};
  for (const [key, value] of entries.slice(0, MAX_FIELDS)) {
    const label = safeLabel(key);
    result[label || 'field'] = isSensitiveField(key) ? REDACTED : summarizeValue(value);
  }
  if (entries.length > MAX_FIELDS) result.omittedFields = entries.length - MAX_FIELDS;
  return result;
}

export function sanitizeLogSection(section: string): string {
  return safeLabel(section) || 'event';
}
