const accessRestrictedStatuses = new Set([401, 403, 429]);

export function isAccessRestrictedStatus(status: number): boolean {
  return accessRestrictedStatuses.has(status);
}
