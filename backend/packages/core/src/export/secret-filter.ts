const SECRET_PATTERNS = [
  /sk-[a-zA-Z0-9]{20,}/,
  /ghp_[a-zA-Z0-9]{20,}/,
  /AKIA[A-Z0-9]{16}/,
  /-----BEGIN [A-Z ]+ PRIVATE KEY-----/,
  /password\s*[=:]\s*\S+/gi,
  /token\s*[=:]\s*\S+/gi,
  /secret\s*[=:]\s*\S+/gi,
];

export function filterSecrets(input: string): string {
  let result = input;
  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(pattern, '[REDACTED]');
  }
  return result;
}

export function filterSecretsDeep<T>(obj: T): T {
  if (typeof obj === 'string') return filterSecrets(obj) as T;
  if (Array.isArray(obj)) return obj.map((item) => filterSecretsDeep(item)) as T;
  if (obj && typeof obj === 'object') {
    const result: any = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = filterSecretsDeep(value);
    }
    return result;
  }
  return obj;
}
