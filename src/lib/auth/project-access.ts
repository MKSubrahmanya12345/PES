/**
 * Multi-tenant project access checks.
 */

import type { ProjectState } from '@/types/project';
import type { AuthContext } from '@/lib/auth/session';
import { AuthError } from '@/lib/auth/session';
import { getProjectState } from '@/lib/mongodb/projects';

export async function loadOwnedProject(projectId: string, auth: AuthContext): Promise<ProjectState> {
  const project = await getProjectState(projectId.trim());
  if (!project) {
    throw new AuthError(404, 'not_found', `Project ${projectId} does not exist.`);
  }
  assertCanRead(project, auth);
  return project;
}

export function assertCanRead(project: ProjectState, auth: AuthContext): void {
  if (auth.user.role === 'admin') return;
  if (auth.user.id === 'local-dev') return; // WIREUP_AUTH_REQUIRED=false harness
  if (project.ownerId && project.ownerId === auth.user.id) return;
  if (project.orgId && auth.user.orgId && project.orgId === auth.user.orgId) return;
  if (project.visibility === 'public') return;
  // Legacy fixtures / pre-auth documents with no owner: readable only by admin (above)
  // or when the same process created them under local-dev.
  if (!project.ownerId) {
    throw new AuthError(403, 'forbidden', 'You do not have access to this project.');
  }
  throw new AuthError(403, 'forbidden', 'You do not have access to this project.');
}

export function assertCanWrite(project: ProjectState, auth: AuthContext): void {
  if (auth.user.role === 'admin') return;
  if (auth.user.id === 'local-dev') return;
  if (project.ownerId === auth.user.id) return;
  if (project.orgId && auth.user.orgId && project.orgId === auth.user.orgId) return;
  if (!project.ownerId && auth.user.id === 'local-dev') return;
  throw new AuthError(403, 'forbidden', 'You do not have write access to this project.');
}
