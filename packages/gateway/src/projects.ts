/**
 * Projects layer. A grouping
 * level ABOVE rooms — Room itself carries no projectId field (packages/shared
 * is frozen), so the room<->project relationship lives entirely in this
 * gateway-local side-table, same shape-of-problem as router.ts's
 * data/router.json and index.ts's data/autoroute.json.
 *
 * "Unsorted" is a UI-only label, never a stored project: a room with no entry
 * in `assignments` IS unsorted, the same way a Room with no `archivedAt` IS
 * active. project.delete therefore just deletes the assignment keys pointing
 * at the deleted project rather than reassigning them to a synthetic id.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';

export interface ProjectRecord {
  id: string;
  name: string;
}

export interface ProjectsState {
  projects: ProjectRecord[];
  /** roomId -> projectId. Absent key = Unsorted. */
  assignments: Record<string, string>;
}

function projectsFilePath(dataDir: string): string {
  return join(dataDir, 'projects.json');
}

/** Defensive shape validation so a hand-edited or truncated file degrades to empty state, never a crash. */
function isProjectRecord(v: unknown): v is ProjectRecord {
  return (
    typeof v === 'object' &&
    v != null &&
    typeof (v as { id?: unknown }).id === 'string' &&
    typeof (v as { name?: unknown }).name === 'string'
  );
}

function sanitizeAssignments(raw: unknown, validProjectIds: Set<string>): Record<string, string> {
  if (typeof raw !== 'object' || raw == null) return {};
  const out: Record<string, string> = {};
  for (const [roomId, projectId] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof projectId === 'string' && validProjectIds.has(projectId)) {
      out[roomId] = projectId;
    }
  }
  return out;
}

/** Load `data/projects.json`. Absent file (not yet created) or a corrupt one both fall back to the empty default — same try/catch-return-default idiom as loadAutorouteRooms (index.ts). */
export function loadProjects(dataDir: string): ProjectsState {
  const path = projectsFilePath(dataDir);
  if (!existsSync(path)) return { projects: [], assignments: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { projects?: unknown; assignments?: unknown };
    const projects = Array.isArray(parsed.projects) ? parsed.projects.filter(isProjectRecord) : [];
    const validIds = new Set(projects.map((p) => p.id));
    return { projects, assignments: sanitizeAssignments(parsed.assignments, validIds) };
  } catch {
    return { projects: [], assignments: {} };
  }
}

/** Persist the full state. Create-on-first-write, same as autoroute.json — not boot-created. */
export function saveProjects(dataDir: string, state: ProjectsState): void {
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
  writeFileSync(projectsFilePath(dataDir), JSON.stringify(state, null, 2), 'utf8');
}

/**
 * Project-name rule: trimmed, 1..60 chars (same length contract as
 * validRoomName in index.ts). Projects are their own namespace — no 'The
 * Quad' reserved literal — but 'Unsorted' is rejected to avoid colliding with
 * the synthetic grouping label the UI renders for unassigned rooms (that
 * label has no backing project row, so a REAL project named "Unsorted" would
 * be visually indistinguishable from it).
 */
export function validProjectName(raw: unknown): { ok: true; name: string } | { ok: false; error: string } {
  const name = typeof raw === 'string' ? raw.trim() : '';
  if (name.length < 1 || name.length > 60) {
    return { ok: false, error: 'Project name must be 1–60 characters after trimming.' };
  }
  if (name.toLowerCase() === 'unsorted') {
    return { ok: false, error: "'Unsorted' is reserved for rooms with no project." };
  }
  return { ok: true, name };
}

export function createProject(state: ProjectsState, rawName: unknown): { ok: true; state: ProjectsState; project: ProjectRecord } | { ok: false; error: string } {
  const validated = validProjectName(rawName);
  if (!validated.ok) return { ok: false, error: validated.error };
  const project: ProjectRecord = { id: randomUUID(), name: validated.name };
  return { ok: true, state: { ...state, projects: [...state.projects, project] }, project };
}

export function renameProject(state: ProjectsState, projectId: string, rawName: unknown): { ok: true; state: ProjectsState } | { ok: false; error: string } {
  const idx = state.projects.findIndex((p) => p.id === projectId);
  if (idx < 0) return { ok: false, error: 'Project not found.' };
  const validated = validProjectName(rawName);
  if (!validated.ok) return { ok: false, error: validated.error };
  const projects = [...state.projects];
  projects[idx] = { ...projects[idx], name: validated.name };
  return { ok: true, state: { ...state, projects } };
}

/** Deletes the project and unassigns (not reassigns) every room that pointed at it — absence of the assignment key IS Unsorted. */
export function deleteProject(state: ProjectsState, projectId: string): { ok: true; state: ProjectsState } | { ok: false; error: string } {
  if (!state.projects.some((p) => p.id === projectId)) return { ok: false, error: 'Project not found.' };
  const projects = state.projects.filter((p) => p.id !== projectId);
  const assignments: Record<string, string> = {};
  for (const [roomId, pid] of Object.entries(state.assignments)) {
    if (pid !== projectId) assignments[roomId] = pid;
  }
  return { ok: true, state: { ...state, projects, assignments } };
}

/** projectId: null clears the assignment (room becomes Unsorted); a non-null id must reference an existing project. */
export function setRoomProject(state: ProjectsState, roomId: string, projectId: string | null): { ok: true; state: ProjectsState } | { ok: false; error: string } {
  if (projectId != null && !state.projects.some((p) => p.id === projectId)) {
    return { ok: false, error: 'Project not found.' };
  }
  const assignments = { ...state.assignments };
  if (projectId == null) delete assignments[roomId];
  else assignments[roomId] = projectId;
  return { ok: true, state: { ...state, assignments } };
}
