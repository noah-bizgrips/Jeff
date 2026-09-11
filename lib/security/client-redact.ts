/** Client-safe heuristic (mirrors the server patterns) used to block pasting secrets into forms/chat. */
export function looksSensitiveClient(text: string): boolean {
  return /(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{16,}|(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{10,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{15,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|Bearer\s+[A-Za-z0-9._-]{15,}|(?:api[_-]?key|access[_-]?token|secret|password)\s*[:=]\s*["']?[^\s"']{10,}|https?:\/\/[^\s/]+:[^\s@]+@|[?&#](?:token|key|secret|signature|x-amz-signature|access_token|code)=[^\s&]+)/i.test(
    text,
  );
}
