import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  createProject,
  deleteProject,
  loadProjects,
  renameProject,
  saveProjects,
  setRoomProject,
  validProjectName,
  type ProjectsState,
} from './projects.js';

function freshDataDir(): string {
  return mkdtempSync(join(tmpdir(), 'projects-test-'));
}

describe('validProjectName', () => {
  it('accepts a trimmed 1-60 char name', () => {
    const result = validProjectName('  Acme Org  ');
    expect(result).toEqual({ ok: true, name: 'Acme Org' });
  });

  it('rejects empty / whitespace-only names', () => {
    expect(validProjectName('   ').ok).toBe(false);
    expect(validProjectName('').ok).toBe(false);
  });

  it('rejects names over 60 characters after trimming', () => {
    expect(validProjectName('x'.repeat(61)).ok).toBe(false);
    expect(validProjectName('x'.repeat(60)).ok).toBe(true);
  });

  it('rejects the reserved "Unsorted" literal (case-insensitive)', () => {
    expect(validProjectName('Unsorted').ok).toBe(false);
    expect(validProjectName('unsorted').ok).toBe(false);
    expect(validProjectName('UNSORTED').ok).toBe(false);
  });

  it('rejects non-string payloads off the wire', () => {
    expect(validProjectName(42).ok).toBe(false);
    expect(validProjectName(undefined).ok).toBe(false);
    expect(validProjectName(null).ok).toBe(false);
  });
});

describe('loadProjects / saveProjects', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = freshDataDir();
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('returns the empty default when projects.json does not exist (create-on-first-write)', () => {
    expect(existsSync(join(dataDir, 'projects.json'))).toBe(false);
    expect(loadProjects(dataDir)).toEqual({ projects: [], assignments: {} });
  });

  it('round-trips a full state through save then load', () => {
    const state: ProjectsState = {
      projects: [{ id: 'p1', name: 'Acme Corp' }, { id: 'p2', name: 'Skunkworks' }],
      assignments: { 'room-a': 'p1', 'room-b': 'p2' },
    };
    saveProjects(dataDir, state);
    expect(existsSync(join(dataDir, 'projects.json'))).toBe(true);
    expect(loadProjects(dataDir)).toEqual(state);
  });

  it('falls back to the empty default on a corrupt file rather than throwing', () => {
    writeFileSync(join(dataDir, 'projects.json'), '{not valid json', 'utf8');
    expect(loadProjects(dataDir)).toEqual({ projects: [], assignments: {} });
  });

  it('drops malformed project records and dangling assignments defensively', () => {
    writeFileSync(
      join(dataDir, 'projects.json'),
      JSON.stringify({
        projects: [{ id: 'p1', name: 'Valid' }, { id: 42 }, { name: 'no id' }],
        assignments: { 'room-a': 'p1', 'room-b': 'p-does-not-exist', 'room-c': 42 },
      }),
      'utf8'
    );
    expect(loadProjects(dataDir)).toEqual({
      projects: [{ id: 'p1', name: 'Valid' }],
      assignments: { 'room-a': 'p1' },
    });
  });
});

describe('createProject', () => {
  const empty: ProjectsState = { projects: [], assignments: {} };

  it('creates a project with a generated id and appends it', () => {
    const result = createProject(empty, 'Acme Corp');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.project.name).toBe('Acme Corp');
    expect(typeof result.project.id).toBe('string');
    expect(result.project.id.length).toBeGreaterThan(0);
    expect(result.state.projects).toEqual([result.project]);
    expect(result.state.assignments).toEqual({});
  });

  it('rejects an invalid name without mutating state', () => {
    const result = createProject(empty, '');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/1–60/);
  });

  it('two creates with the same name produce two distinct ids (no uniqueness constraint on name)', () => {
    const first = createProject(empty, 'Same Name');
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = createProject(first.state, 'Same Name');
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.state.projects).toHaveLength(2);
    expect(second.state.projects[0].id).not.toBe(second.state.projects[1].id);
  });
});

describe('renameProject', () => {
  it('renames an existing project in place', () => {
    const created = createProject({ projects: [], assignments: {} }, 'Old Name');
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const renamed = renameProject(created.state, created.project.id, 'New Name');
    expect(renamed.ok).toBe(true);
    if (!renamed.ok) return;
    expect(renamed.state.projects).toEqual([{ id: created.project.id, name: 'New Name' }]);
  });

  it('errors on an unknown project id', () => {
    const result = renameProject({ projects: [], assignments: {} }, 'nonexistent', 'New Name');
    expect(result.ok).toBe(false);
  });

  it('rejects an invalid new name', () => {
    const created = createProject({ projects: [], assignments: {} }, 'Old Name');
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const renamed = renameProject(created.state, created.project.id, 'Unsorted');
    expect(renamed.ok).toBe(false);
  });
});

describe('deleteProject', () => {
  it('removes the project and unassigns (not reassigns) its rooms — absence of the key IS Unsorted', () => {
    const created = createProject({ projects: [], assignments: {} }, 'Doomed Project');
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const withAssignment = setRoomProject(created.state, 'room-a', created.project.id);
    expect(withAssignment.ok).toBe(true);
    if (!withAssignment.ok) return;
    const withOtherRoom = setRoomProject(withAssignment.state, 'room-b', null); // already unsorted, no-op-ish
    expect(withOtherRoom.ok).toBe(true);
    if (!withOtherRoom.ok) return;

    const deleted = deleteProject(withOtherRoom.state, created.project.id);
    expect(deleted.ok).toBe(true);
    if (!deleted.ok) return;
    expect(deleted.state.projects).toEqual([]);
    expect(Object.prototype.hasOwnProperty.call(deleted.state.assignments, 'room-a')).toBe(false);
    expect(deleted.state.assignments).toEqual({});
  });

  it('errors on an unknown project id', () => {
    const result = deleteProject({ projects: [], assignments: {} }, 'nonexistent');
    expect(result.ok).toBe(false);
  });

  it('leaves rooms assigned to OTHER projects untouched', () => {
    const p1 = createProject({ projects: [], assignments: {} }, 'Project One');
    expect(p1.ok).toBe(true);
    if (!p1.ok) return;
    const p2 = createProject(p1.state, 'Project Two');
    expect(p2.ok).toBe(true);
    if (!p2.ok) return;
    const assigned1 = setRoomProject(p2.state, 'room-1', p1.project.id);
    expect(assigned1.ok).toBe(true);
    if (!assigned1.ok) return;
    const assigned2 = setRoomProject(assigned1.state, 'room-2', p2.project.id);
    expect(assigned2.ok).toBe(true);
    if (!assigned2.ok) return;

    const deleted = deleteProject(assigned2.state, p1.project.id);
    expect(deleted.ok).toBe(true);
    if (!deleted.ok) return;
    expect(deleted.state.projects).toEqual([p2.project]);
    expect(deleted.state.assignments).toEqual({ 'room-2': p2.project.id });
  });
});

describe('setRoomProject', () => {
  it('assigns a room to an existing project', () => {
    const created = createProject({ projects: [], assignments: {} }, 'Target Project');
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const result = setRoomProject(created.state, 'room-x', created.project.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.assignments).toEqual({ 'room-x': created.project.id });
  });

  it('errors when the projectId does not reference an existing project (guards a forged/stale id)', () => {
    const result = setRoomProject({ projects: [], assignments: {} }, 'room-x', 'ghost-project');
    expect(result.ok).toBe(false);
  });

  it('projectId: null clears the assignment — the room becomes Unsorted', () => {
    const created = createProject({ projects: [], assignments: {} }, 'Target Project');
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const assigned = setRoomProject(created.state, 'room-x', created.project.id);
    expect(assigned.ok).toBe(true);
    if (!assigned.ok) return;

    const cleared = setRoomProject(assigned.state, 'room-x', null);
    expect(cleared.ok).toBe(true);
    if (!cleared.ok) return;
    expect(Object.prototype.hasOwnProperty.call(cleared.state.assignments, 'room-x')).toBe(false);
  });

  it('re-assigning an already-unsorted room to null is a harmless no-op', () => {
    const result = setRoomProject({ projects: [], assignments: {} }, 'room-x', null);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.assignments).toEqual({});
  });
});
