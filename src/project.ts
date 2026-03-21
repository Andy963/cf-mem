export interface ProjectScope {
  projectId: string;
  namespace: string;
}

const PROJECT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function normalizeProjectId(value: unknown): string | null {
  if (typeof value !== "string") return null;

  const projectId = value.trim();
  if (!projectId || !PROJECT_ID_PATTERN.test(projectId)) return null;
  return projectId;
}

export function createProjectScope(projectId: string): ProjectScope {
  return {
    projectId,
    namespace: `project:${projectId}`,
  };
}

export function scopeSegmentId(scope: ProjectScope, segmentId: string): string {
  return `${scope.namespace}:${segmentId}`;
}
