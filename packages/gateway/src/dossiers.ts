/**
 * Agent Dossiers — dashboard surface v1.1 (Wave 7 stretch, M4,
 * docs/DESIGN-agent-dossiers-surface.md). Pure/testable half: the seatId ->
 * dossier-file resolution and every security rule around it (roster
 * allowlist BEFORE any path is built, realpath containment, symlink
 * rejection). No Fastify/no reading the file's CONTENT here — the route (fs
 * read of the resolved path + response shaping) lives in dossiersRoutes.ts,
 * same pure/impure split as workshop.ts/workshopRoutes.ts.
 *
 * The convention this reads from (Team/dossiers/README.md): one file per
 * SEAT MANIFEST, `<manifest-id>.md` — not per seat. `grok-build.md` covers
 * both `grok-build` and `grok-build#<instance>` (docs/DESIGN-agent-dossiers-
 * surface.md F11).
 */

import { lstatSync, realpathSync } from 'fs';
import { isAbsolute, join, relative } from 'path';
import { isValidInstanceId } from './agents.js';

/** Env override, same idiom as gatewayLocalConfig.ts's other knobs. Unset (default) = feature hidden entirely (design doc spec). */
export const DOSSIERS_DIR_ENV = 'AGENT_OS_DOSSIERS_DIR';

export function dossiersDir(): string | undefined {
  const raw = process.env[DOSSIERS_DIR_ENV];
  return raw != null && raw.trim() !== '' ? raw.trim() : undefined;
}

export interface ParsedSeatId {
  manifestId: string;
  instanceId?: string;
}

/**
 * Splits a wire seatId into its manifestId/instanceId parts WITHOUT
 * validating either against anything yet — deriveSeatId's inverse. A seatId
 * with more than one '#', or an empty manifestId/instanceId segment, is
 * malformed and rejected here rather than silently taking a first/last
 * segment.
 */
export function splitSeatId(seatId: string): ParsedSeatId | null {
  if (typeof seatId !== 'string' || seatId.length === 0) return null;
  const parts = seatId.split('#');
  if (parts.length === 1) {
    return parts[0].length > 0 ? { manifestId: parts[0] } : null;
  }
  if (parts.length !== 2) return null; // more than one '#' — not a real seat id shape
  const [manifestId, instanceId] = parts;
  if (manifestId.length === 0 || instanceId.length === 0) return null;
  return { manifestId, instanceId };
}

/**
 * True when `seatId` is a legal seat id for a manifest this build KNOWS
 * about (design doc F10: "STATIC ROSTER id set (manifests + known
 * instances) — NOT the connected/VERIFIED set, so a down seat's dossier
 * stays readable"). `knownManifestIds` is the STATIC set (agents.ts's
 * knownManifestIds()) — never the live `agents` Map, which only reflects who
 * is currently connected.
 *
 * "Known instances" is a syntactic check, not an enumerable list: instances
 * are inherently open-ended (docs/DESIGN-multi-instance.md — any seat can be
 * connected under any legal slug at any time), so a seatId with an instance
 * suffix is accepted whenever that suffix is a well-formed instance slug
 * (isValidInstanceId) of a known manifest — the file it resolves to is the
 * manifest-level dossier regardless of which instance asked.
 */
export function isKnownSeatId(seatId: string, knownManifestIds: readonly string[]): boolean {
  const parsed = splitSeatId(seatId);
  if (!parsed) return false;
  if (!knownManifestIds.includes(parsed.manifestId)) return false;
  if (parsed.instanceId === undefined) return true;
  return isValidInstanceId(parsed.instanceId);
}

/** Dossier filenames are keyed by MANIFEST id only (F11) — every instance of a harness shares one file. Caller must have already validated with isKnownSeatId; throws otherwise (programmer error, never reachable from the route — see resolveDossierPath). */
export function dossierFilename(seatId: string): string {
  const parsed = splitSeatId(seatId);
  if (!parsed) throw new Error(`dossierFilename called with an invalid seatId: ${seatId}`);
  return `${parsed.manifestId}.md`;
}

export type DossierPathResult =
  | { ok: true; path: string }
  | {
      ok: false;
      reason: 'unknown-seat' | 'not-configured' | 'not-found' | 'symlink' | 'not-a-file' | 'escapes-root';
    };

/**
 * Resolves seatId to an absolute, containment-checked dossier file path, or
 * a typed failure — every failure branch maps to a plain 404 at the route
 * (never a distinguishing status/message; "path traversal attempt" and
 * "unknown seat" and "no dossier written yet" must all look identical from
 * the outside).
 *
 * Order matters (F10 spec, "before any path is built"): roster validation
 * happens BEFORE any join()/fs call. The filename is derived entirely from
 * the VALIDATED manifestId, never from the raw seatId, so a `../`-laden
 * seatId cannot reach path math even in principle — it fails roster
 * validation and returns here, before `join()` is ever called.
 *
 * realpath + lstat containment (F10, second half): `dossiersDirRaw` itself
 * is realpath'd once (a symlinked dossiers DIR is fine — the threat this
 * guards against is an agent-writable file INSIDE it being a symlink, e.g. a
 * planted `grok-build.md` pointing at `/etc/passwd` or a credentials file).
 * The candidate file is lstat'd (NOT stat'd), so a symlink is detected
 * without ever being followed/read.
 */
export function resolveDossierPath(
  dossiersDirRaw: string | undefined,
  seatId: string,
  knownManifestIds: readonly string[]
): DossierPathResult {
  if (!dossiersDirRaw) return { ok: false, reason: 'not-configured' };
  if (!isKnownSeatId(seatId, knownManifestIds)) return { ok: false, reason: 'unknown-seat' };

  let realDir: string;
  try {
    realDir = realpathSync(dossiersDirRaw);
  } catch {
    return { ok: false, reason: 'not-found' };
  }

  const filename = dossierFilename(seatId);
  const candidate = join(realDir, filename);

  let lst;
  try {
    lst = lstatSync(candidate);
  } catch {
    // No dossier written for this seat yet — a legitimate, honest empty
    // state for a roster-valid seatId, not a security rejection.
    return { ok: false, reason: 'not-found' };
  }
  if (lst.isSymbolicLink()) {
    return { ok: false, reason: 'symlink' };
  }
  if (!lst.isFile()) {
    return { ok: false, reason: 'not-a-file' };
  }

  // Belt-and-braces containment: the filename came from a validated
  // manifestId (the closed adapter registry's keys — no path separators can
  // ever appear in one), so `candidate` structurally cannot escape `realDir`
  // — this re-derives and re-checks anyway rather than trusting that
  // invariant silently forever.
  const realFile = realpathSync(candidate);
  const rel = relative(realDir, realFile);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    return { ok: false, reason: 'escapes-root' };
  }

  return { ok: true, path: realFile };
}
