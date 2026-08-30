export function normalizeExternalSessionId(sourceApp: string, externalSessionId: string): string {
  let normalized = externalSessionId.trim();
  const normalizedSourceApp = sourceApp.trim().toLowerCase();
  if (!normalizedSourceApp) return normalized;

  const prefix = `${normalizedSourceApp}:`;
  while (normalized.toLowerCase().startsWith(prefix)) {
    normalized = normalized.slice(prefix.length).trim();
  }
  return normalized;
}
