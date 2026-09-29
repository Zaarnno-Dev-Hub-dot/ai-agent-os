/**
 * Vault memory layer v1 — READ-ONLY over the
 * Obsidian vault at VAULT_ROOT. The gateway never writes to the vault: every
 * function here only ever calls readFileSync/statSync/readdirSync against it.
 *
 * Scale note from the original design: 55 files / ~163KB — a simple in-process
 * index rebuilt on a timer is plenty; no search infra, no deps.
 */

import { readdirSync, readFileSync, statSync } from 'fs';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import type { Dirent } from 'fs';
import { join, normalize, posix, relative, resolve, sep } from 'path';

// The vault is an optional feature, so its absence is worth one line per run, not one per index refresh.
let vaultMissingLogged = false;

/** Default vault location. Overridable for tests. */
export const DEFAULT_VAULT_ROOT = './data/vault';

/**
 * Directories/files indexed, relative to the vault root — EXACTLY the set
 * named in the original design. Anything else in the vault (Hermes/, User/,
 * Memory/skills/, Memory/YouTube-Transcriptions/, etc.) is simply never
 * scanned, on top of the explicit exclusions below — an allowlist, not a
 * denylist, so a new top-level folder someone adds to the vault tomorrow
 * does NOT silently become indexable without a code change here.
 */
const INDEXED_DIRS = [
  'Memory/Incidents',
  'Memory/Projects',
  'Memory/Daily',
  'Memory/Public',
  'Memory/Agents',
  'Playbooks',
] as const;

const INDEXED_ROOT_FILES = ['README.md', 'memory.md', 'INDEX.md'] as const;

/**
 * Never indexed/surfaced even though they'd otherwise fall under an
 * INDEXED_DIRS prefix:
 * - Memory/Review: 7-day veto window for pending facts — surfacing them as
 *   context to an agent would violate the vault's own governance.
 * - Memory/Inbox: uncurated.
 * - .obsidian: app metadata, not memory content.
 * Matched against the path relative to the vault root, case-insensitive,
 * matching on a path-segment boundary so e.g. "Memory/Reviewed-Notes" is NOT
 * excluded by the "Review" rule.
 */
const EXCLUDED_PATH_PREFIXES = ['memory/review', 'memory/inbox', '.obsidian'];

/** PII homes — excluded from pin/render AND from search results entirely. */
const PII_PATHS = new Set(['user/profile.md', 'memory/user-profile.md']);

/**
 * Privacy denylist (Team\specs\SPEC-privacy-exclusion.md, shared with
 * a companion tool's build-memory-graph.mjs / check-privacy.mjs — same JSON file,
 * one source of truth). Loaded fresh on every reindex() so an updated
 * denylist takes effect on the next timer tick without a gateway restart.
 * Fail-closed for privacy purposes but fail-SOFT for process stability,
 * matching this module's existing "never throws" posture: an unreadable or
 * unparseable denylist file yields an EMPTY term/prefix set here, which
 * combined with the returned `failed` flag causes reindex() to publish an
 * empty index rather than an unfiltered one (see reindex()) — never
 * "run without a denylist" silently.
 */
const PRIVACY_DENYLIST_PATH = './config/privacy-denylist.json';

interface PrivacyDenylist {
  terms: string[];
  /** wordBoundaryTerms from the JSON: short aliases matched on word
   * boundaries only (the field's contract; wired in 2026-07-21, spec §2c). */
  boundaryTerms: string[];
  pathPrefixes: string[];
}

const EMPTY_DENYLIST: PrivacyDenylist = { terms: [], boundaryTerms: [], pathPrefixes: [] };

function loadPrivacyDenylist(): { denylist: PrivacyDenylist; failed: boolean } {
  try {
    const raw = readFileSync(PRIVACY_DENYLIST_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as { terms?: unknown; wordBoundaryTerms?: unknown; pathPrefixes?: unknown };
    const terms = Array.isArray(parsed.terms) ? parsed.terms.map((t) => String(t)) : [];
    const boundaryTerms = Array.isArray(parsed.wordBoundaryTerms) ? parsed.wordBoundaryTerms.map((t) => String(t)) : [];
    const pathPrefixes = Array.isArray(parsed.pathPrefixes) ? parsed.pathPrefixes.map((p) => String(p)) : [];
    if (terms.length === 0) {
      console.error(`[memory] privacy denylist at ${PRIVACY_DENYLIST_PATH} has no usable "terms" — indexing nothing this cycle (fail-closed)`);
      return { denylist: EMPTY_DENYLIST, failed: true };
    }
    return { denylist: { terms, boundaryTerms, pathPrefixes }, failed: false };
  } catch (e) {
    console.error(`[memory] privacy denylist unreadable/unparseable at ${PRIVACY_DENYLIST_PATH} — indexing nothing this cycle (fail-closed)`, e);
    return { denylist: EMPTY_DENYLIST, failed: true };
  }
}

/**
 * True if relPosixPath should be excluded per the privacy denylist: a
 * pathPrefixes match, a terms match against the full lowercased path, or the
 * "private/" folder convention (any path segment literally named "private",
 * case-insensitive) — same three-way rule as a companion tool's build-memory-graph.mjs
 * so the vault-walk behavior is identical across both consumers of this file.
 */
function isPrivacyDenylistedPath(relPosixPath: string, denylist: PrivacyDenylist): boolean {
  const lower = relPosixPath.toLowerCase();
  if (lower.split('/').includes('private')) return true;
  for (const prefix of denylist.pathPrefixes) {
    const p = prefix.toLowerCase().replace(/\\/g, '/');
    if (lower === p || lower.startsWith(p.endsWith('/') ? p : `${p}/`)) return true;
  }
  // PATH surface (spec §2c v3.1): `terms` stays pure SUBSTRING on purpose —
  // camelCase/glued private filenames (LuminaPhase1.md) must stay excluded.
  for (const term of denylist.terms) {
    if (lower.includes(term.toLowerCase())) return true;
  }
  // wordBoundaryTerms: boundary semantics per the field's contract
  // ("lumi-notes.md" hits, "illuminated-manuscripts.md" does not).
  for (const term of denylist.boundaryTerms) {
    const t = term.toLowerCase();
    if (!t) continue;
    const esc = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`(^|[^a-z])${esc}s?(?=$|[^a-z])`).test(lower)) return true;
  }
  return false;
}

/**
 * PROSE-surface content scan (spec §2c v3.1) for note BODIES. The Q6 ruling
 * established that path screening alone is never
 * sufficient for body-inlining surfaces — build-memory-graph.mjs has enforced
 * that since; this gateway (which feeds note bodies into agent context via
 * search/get/pinned blocks) did NOT until 2026-07-21 (R2 panel finding).
 * Bare terms: letter-boundary + optional plural "s" ("illuminated" and
 * "luminance" never hit). Separator terms: substring. boundaryTerms: boundary.
 */
function proseTermHits(text: string, denylist: PrivacyDenylist): boolean {
  if (!text) return false;
  const lower = text.toLowerCase();
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const term of denylist.terms) {
    const t = term.toLowerCase();
    if (!t) continue;
    if (/^[a-z0-9]+$/.test(t)) {
      if (new RegExp(`(^|[^a-z])${esc(t)}s?(?=$|[^a-z])`).test(lower)) return true;
    } else if (lower.includes(t)) {
      return true;
    }
  }
  for (const term of denylist.boundaryTerms) {
    const t = term.toLowerCase();
    if (!t) continue;
    if (new RegExp(`(^|[^a-z])${esc(t)}s?(?=$|[^a-z])`).test(lower)) return true;
  }
  return false;
}

/** Heading text that marks a section to redact (case-insensitive, heading-line match only). */
const REDACTED_HEADINGS = ['secrets', 'api access', 'credentials'];

export interface MemoryNoteMeta {
  /** Path relative to the vault root, forward-slash separated (wire-stable, OS-independent). */
  path: string;
  title: string;
  summary?: string;
  mtime: number;
  /** scope/author/last_updated from frontmatter, when present — not currently surfaced on the wire but kept for future use / debugging. */
  scope?: string;
  author?: string;
}

interface IndexedNote extends MemoryNoteMeta {
  /** Raw file body (frontmatter block stripped), used for search + redaction + rendering. */
  body: string;
  /** File size in bytes (statSync) — Memory Galaxy graph node field only. */
  size: number;
  /** Raw `[[wikilink]]` targets extracted from the body at index time, UNRESOLVED. Resolution against the current governance-filtered note set happens lazily (rebuildLinkIndexes/resolveWikilinkTarget) since a target's note may be indexed later in the same walk. */
  rawLinks: string[];
}

/**
 * Obsidian wikilink target extraction:
 * `[[Target]]`, `[[Target|Alias]]`, `[[Target#Heading]]`,
 * `[[Target#Heading|Alias]]` — captures Target only, trimmed. An embed
 * (`![[Target]]`) is matched too (the `!` sits outside the `[[...]]`
 * capture) — deliberately treated as a link for graph purposes, matching
 * a memory-galaxy reference which makes no embed/link distinction.
 */
const WIKILINK_RE = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g;

export function extractWikilinkTargets(body: string): string[] {
  const out: string[] = [];
  WIKILINK_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = WIKILINK_RE.exec(body))) {
    const target = m[1].trim();
    if (target) out.push(target);
  }
  return out;
}

/** Memory Galaxy graph shapes. */
export interface MemoryGraphNode {
  id: string;
  title: string;
  path: string;
  mtime: number;
  size: number;
}

export interface MemoryGraphLink {
  source: string;
  target: string;
}

export interface MemoryGraph {
  nodes: MemoryGraphNode[];
  links: MemoryGraphLink[];
  /** Total governance-filtered notes currently indexed, BEFORE the node cap — lets the UI show "showing N of M" per the original design's performance guard. */
  totalNotes: number;
}

/** Performance guard from the original design: render at most this many newest nodes. */
export const MEMORY_GRAPH_NODE_CAP = 500;

/** Normalize a relative vault path to forward slashes for stable comparisons and wire output. */
function toPosixRelative(p: string): string {
  return p.split(sep).join('/');
}

function isExcludedRelPath(relPosixPath: string): boolean {
  const lower = relPosixPath.toLowerCase();
  return EXCLUDED_PATH_PREFIXES.some((prefix) => lower === prefix || lower.startsWith(`${prefix}/`));
}

function isPiiPath(relPosixPath: string): boolean {
  return PII_PATHS.has(relPosixPath.toLowerCase());
}

/**
 * Minimal frontmatter parser: `---\n...\n---\n` at the very top of the file.
 * Handles the flat `key: value` shape used across the vault plus YAML block
 * scalars (`summary: |` followed by indented lines) — good enough for this
 * vault's own frontmatter, not a general YAML parser. Anything it can't parse
 * is simply left absent; callers always have the filename/mtime/body fallback.
 */
function parseFrontmatter(raw: string): { attrs: Record<string, string>; body: string } {
  if (!raw.startsWith('---')) return { attrs: {}, body: raw };
  const end = raw.indexOf('\n---', 3);
  if (end === -1) return { attrs: {}, body: raw };
  const block = raw.slice(3, end).replace(/^\n/, '');
  // Body starts after the closing '---' line and its newline.
  const afterMarker = raw.indexOf('\n', end + 1);
  const body = afterMarker === -1 ? '' : raw.slice(afterMarker + 1);

  const attrs: Record<string, string> = {};
  const lines = block.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = /^([a-zA-Z_][a-zA-Z0-9_-]*):\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1];
    const rest = m[2].trim();
    if (rest === '|' || rest === '>') {
      // Block scalar: consume subsequent more-indented lines as the value.
      const collected: string[] = [];
      let j = i + 1;
      while (j < lines.length && (lines[j].startsWith('  ') || lines[j].trim() === '')) {
        collected.push(lines[j].replace(/^ {2}/, ''));
        j++;
      }
      attrs[key] = collected.join('\n').trim();
      i = j - 1;
    } else {
      attrs[key] = rest;
    }
  }
  return { attrs, body };
}

/** First non-empty, non-heading paragraph of the body — used as a summary fallback when frontmatter has none. */
function firstParagraph(body: string): string | undefined {
  const lines = body.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('#')) continue;
    if (trimmed.startsWith('>')) continue; // skip callout/quote lines (common vault idiom)
    return trimmed.length > 300 ? `${trimmed.slice(0, 300)}…` : trimmed;
  }
  return undefined;
}

/** Title fallback: filename without extension, hyphens/underscores turned into spaces. */
function titleFromFilename(relPosixPath: string): string {
  const base = relPosixPath.split('/').pop() ?? relPosixPath;
  const noExt = base.replace(/\.md$/i, '');
  return noExt.replace(/[-_]+/g, ' ').trim() || noExt;
}

/**
 * Redact sections headed by one of REDACTED_HEADINGS (any # level, case-
 * insensitive heading-line match) from markdown body. A "section" runs from
 * its heading line up to (but not including) the next heading of equal-or-
 * shallower level, or end of file. Pattern-based, not a one-time scan result
 * — the original design is explicit that this must hold even though today's vault
 * has no live Secrets section.
 */
export function redactSections(body: string): string {
  const lines = body.split('\n');
  const out: string[] = [];
  let skipUntilLevel: number | null = null; // set while inside a redacted section; value = heading level to stop at

  // Trailing punctuation on a heading ("## Secrets:") must not defeat the
  // match — normalize before comparing (adversarial-review finding, 7/7).
  const normalize = (raw: string) => raw.trim().toLowerCase().replace(/[\s:;.,\-–—]+$/, '');
  const isRedactedHeading = (text: string) =>
    REDACTED_HEADINGS.some((h) => text === h || text.startsWith(`${h} `));

  for (const line of lines) {
    const headingMatch = /^(#{1,6})\s+(.*)$/.exec(line);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const text = normalize(headingMatch[2]);

      if (skipUntilLevel !== null) {
        if (level <= skipUntilLevel) {
          skipUntilLevel = null; // this heading ends the redacted section
        } else {
          continue; // still inside the redacted section — drop this sub-heading too
        }
      }

      if (skipUntilLevel === null && isRedactedHeading(text)) {
        skipUntilLevel = level;
        continue; // drop the heading line itself
      }

      out.push(line);
      continue;
    }

    // No-space headings ("##Secrets") are valid in some renderers. They may
    // START a redaction but never END one — treating arbitrary #hashtag
    // prose as a section terminator would leak the rest of a redacted
    // section (deliberate asymmetry; adversarial-review finding, 7/7).
    const looseMatch: RegExpExecArray | null =
      skipUntilLevel === null ? /^(#{1,6})(\S.*)$/.exec(line) : null;
    if (looseMatch && isRedactedHeading(normalize(looseMatch[2]))) {
      skipUntilLevel = looseMatch[1].length;
      continue;
    }

    if (skipUntilLevel !== null) continue; // inside a redacted section — drop body line
    out.push(line);
  }

  return out.join('\n');
}

/**
 * Path-traversal guard: resolves `candidateRelPath` against `vaultRoot` and
 * rejects anything that doesn't stay inside it (../ escapes, absolute paths
 * that repoint elsewhere, drive-letter tricks). Returns the resolved absolute
 * path on success, or null — callers must fail closed on null, never fall
 * back to treating the raw input as safe.
 */
export function resolveVaultPath(vaultRoot: string, candidateRelPath: string): string | null {
  if (typeof candidateRelPath !== 'string' || candidateRelPath.length === 0) return null;
  // Reject null bytes and backslash/forward-slash absolute-path starts outright —
  // resolve() would otherwise happily anchor an absolute path outside the vault.
  if (candidateRelPath.includes('\0')) return null;

  // Judge Windows-style input the same way on every platform. On POSIX a backslash is an ordinary filename
  // character, so `..\..\.env` or `C:\Windows\x` would otherwise resolve to a strange in-vault name instead of
  // being refused, and the guard would behave differently depending on where the gateway runs.
  const unified = candidateRelPath.replace(/\\/g, '/');
  if (/^[A-Za-z]:/.test(unified)) return null;
  const flat = posix.normalize(unified);
  if (flat === '..' || flat.startsWith('../') || flat.startsWith('/')) return null;

  const root = resolve(vaultRoot);
  const candidate = resolve(root, candidateRelPath);
  const rel = relative(root, candidate);

  // relative() returns a path starting with '..' (or an absolute path, on a
  // different drive on Windows) when `candidate` escapes `root`.
  if (rel === '..' || rel.startsWith(`..${sep}`) || rel.startsWith('../') || resolve(root, rel) !== candidate) {
    return null;
  }
  // Belt-and-braces: candidate must literally start with root + separator (or equal root).
  const normalizedRoot = normalize(root);
  const normalizedCandidate = normalize(candidate);
  if (normalizedCandidate !== normalizedRoot && !normalizedCandidate.startsWith(normalizedRoot + sep)) {
    return null;
  }
  return candidate;
}

export class MemoryIndex {
  private notes: IndexedNote[] = [];
  private readonly vaultRoot: string;
  private reindexTimer: ReturnType<typeof setInterval> | null = null;
  // Reloaded every reindex() by loadPrivacyDenylist() — see isPrivacyDenylistedPath().
  private privacyDenylist: PrivacyDenylist = EMPTY_DENYLIST;

  // Wikilink resolution maps,
  // rebuilt every reindex() from the CURRENT (governance-filtered) note set
  // — see rebuildLinkIndexes(). Lowercase key -> vault-relative path.
  private linkIndexByPath = new Map<string, string>();
  private linkIndexByTitle = new Map<string, string>();
  private linkIndexByBasename = new Map<string, string>();

  constructor(vaultRoot: string = DEFAULT_VAULT_ROOT) {
    this.vaultRoot = resolve(vaultRoot);
  }

  /** Build (or rebuild) the in-memory index by walking the allowlisted dirs/files. Never throws — a missing vault yields an empty index. */
  reindex(): void {
    const { denylist, failed } = loadPrivacyDenylist();
    this.privacyDenylist = denylist;
    if (failed) {
      // Fail-closed for privacy: cannot verify what's safe to surface this
      // cycle, so surface nothing rather than risk an unfiltered index.
      // Matches the existing "missing vault -> empty index" posture below.
      this.notes = [];
      this.rebuildLinkIndexes();
      return;
    }

    const found: IndexedNote[] = [];
    if (!existsSync(this.vaultRoot)) {
      if (!vaultMissingLogged) {
        vaultMissingLogged = true;
        console.warn(`[memory] no memory vault at ${this.vaultRoot} (it is optional) — index empty`);
      }
      this.notes = [];
      this.rebuildLinkIndexes();
      return;
    }

    for (const dir of INDEXED_DIRS) {
      this.walkDir(join(this.vaultRoot, ...dir.split('/')), found);
    }
    for (const file of INDEXED_ROOT_FILES) {
      this.tryIndexFile(join(this.vaultRoot, file), found);
    }

    this.notes = found;
    this.rebuildLinkIndexes();
  }

  /**
   * Rebuild the wikilink resolution maps from `this.notes` — always the
   * CURRENT governance-filtered set, so a target that resolves only to an
   * excluded/never-indexed note simply has no entry here (this is what makes
   * "governance exclusions apply to link endpoints" hold without any extra
   * checking at resolve time).
   */
  private rebuildLinkIndexes(): void {
    this.linkIndexByPath = new Map();
    this.linkIndexByTitle = new Map();
    this.linkIndexByBasename = new Map();
    for (const note of this.notes) {
      const pathNoExt = note.path.replace(/\.md$/i, '').toLowerCase();
      if (!this.linkIndexByPath.has(pathNoExt)) this.linkIndexByPath.set(pathNoExt, note.path);
      const titleKey = note.title.toLowerCase();
      if (!this.linkIndexByTitle.has(titleKey)) this.linkIndexByTitle.set(titleKey, note.path);
      const basename = pathNoExt.split('/').pop() ?? pathNoExt;
      if (!this.linkIndexByBasename.has(basename)) this.linkIndexByBasename.set(basename, note.path);
    }
  }

  /**
   * Resolve a raw `[[wikilink]]` target string to an indexed note's vault-
   * relative path, trying (most to least specific): full vault-relative path
   * (extension optional), computed title, bare filename stem. First match
   * wins; undefined means the target doesn't resolve to any currently-
   * indexed note (never existed, or excluded by governance) — callers must
   * treat that as "no edge", never fall back to a guessed path.
   */
  private resolveWikilinkTarget(rawTarget: string): string | undefined {
    const cleaned = rawTarget.trim().replace(/\\/g, '/').replace(/^\/+/, '');
    if (!cleaned) return undefined;
    const lower = cleaned.replace(/\.md$/i, '').toLowerCase();
    return (
      this.linkIndexByPath.get(lower) ??
      this.linkIndexByTitle.get(lower) ??
      this.linkIndexByBasename.get(lower.split('/').pop() ?? lower)
    );
  }

  /**
   * Memory Galaxy graph. Nodes = indexed
   * notes (governance exclusions already applied — an excluded note is never
   * in `this.notes`), newest `limit` by mtime. Links = resolved wikilink
   * edges whose BOTH endpoints fall inside the capped node set — a link to a
   * note trimmed by the cap, or one that never resolved (excluded/missing),
   * is dropped rather than left dangling.
   */
  getGraph(limit: number = MEMORY_GRAPH_NODE_CAP): MemoryGraph {
    const totalNotes = this.notes.length;
    const sorted = this.notes.slice().sort((a, b) => b.mtime - a.mtime);
    const capped = sorted.slice(0, Math.max(0, limit));
    const includedPaths = new Set(capped.map((n) => n.path));

    const nodes: MemoryGraphNode[] = capped.map((n) => ({
      id: n.path,
      title: n.title,
      path: n.path,
      mtime: n.mtime,
      size: n.size,
    }));

    const seen = new Set<string>();
    const links: MemoryGraphLink[] = [];
    for (const note of capped) {
      for (const rawTarget of note.rawLinks) {
        const target = this.resolveWikilinkTarget(rawTarget);
        if (!target || target === note.path || !includedPaths.has(target)) continue;
        const key = `${note.path}=>${target}`;
        if (seen.has(key)) continue;
        seen.add(key);
        links.push({ source: note.path, target });
      }
    }

    return { nodes, links, totalNotes };
  }

  /** Start boot index + periodic re-index. Call once at gateway startup. */
  start(intervalMs = 60_000): void {
    this.reindex();
    if (this.reindexTimer) clearInterval(this.reindexTimer);
    this.reindexTimer = setInterval(() => this.reindex(), intervalMs);
    // Never keep the process alive solely for this timer (matches the
    // gateway's other setInterval at index.ts's persistDatabase tick).
    this.reindexTimer.unref?.();
  }

  stop(): void {
    if (this.reindexTimer) clearInterval(this.reindexTimer);
    this.reindexTimer = null;
  }

  private walkDir(absDir: string, out: IndexedNote[]): void {
    if (!existsSync(absDir)) return;
    let entries: Dirent[];
    try {
      entries = readdirSync(absDir, { withFileTypes: true });
    } catch (e) {
      console.error(`[memory] failed to read dir ${absDir}`, e);
      return;
    }
    for (const entry of entries) {
      const abs = join(absDir, entry.name);
      const relPosix = toPosixRelative(relative(this.vaultRoot, abs));
      if (entry.isDirectory()) {
        if (isPrivacyDenylistedPath(relPosix, this.privacyDenylist)) continue; // never descend into a denylisted dir
        this.walkDir(abs, out);
      } else if (entry.isFile() && /\.md$/i.test(entry.name)) {
        this.tryIndexFile(abs, out);
      }
    }
  }

  private tryIndexFile(absPath: string, out: IndexedNote[]): void {
    if (!existsSync(absPath)) return;
    const relPosix = toPosixRelative(relative(this.vaultRoot, absPath));
    if (isExcludedRelPath(relPosix) || isPiiPath(relPosix)) return;
    if (isPrivacyDenylistedPath(relPosix, this.privacyDenylist)) return;

    let raw: string;
    let mtimeMs: number;
    let sizeBytes: number;
    try {
      raw = readFileSync(absPath, 'utf-8');
      const stat = statSync(absPath);
      mtimeMs = stat.mtimeMs;
      sizeBytes = stat.size;
    } catch (e) {
      // A single unreadable file must not take down the whole index (design
      // doc: fallback parsing "must not error").
      console.error(`[memory] failed to read/stat ${absPath}`, e);
      return;
    }

    const { attrs, body } = parseFrontmatter(raw);
    const title = titleFromFilename(relPosix);

    // Content-scoped exclusion (Q6 pattern, wired 2026-07-21): a note at a
    // clean path whose CONTENT mentions a denylisted term is indexed
    // title-only — body, summary, and wikilink targets withheld so nothing
    // from it can reach search results, note fetches, or pinned agent
    // context. Scans raw (frontmatter included), fail-safe direction.
    if (proseTermHits(raw, this.privacyDenylist)) {
      out.push({
        path: relPosix,
        title,
        summary: '[body withheld — privacy denylist]',
        mtime: Math.round(mtimeMs),
        scope: attrs.scope || undefined,
        author: attrs.author || undefined,
        body: '',
        size: sizeBytes,
        rawLinks: [],
      });
      return;
    }

    const summary = attrs.summary || firstParagraph(body);

    out.push({
      path: relPosix,
      title,
      summary,
      mtime: Math.round(mtimeMs),
      scope: attrs.scope || undefined,
      author: attrs.author || undefined,
      body,
      size: sizeBytes,
      rawLinks: extractWikilinkTargets(body),
    });
  }

  /**
   * Ranked substring/token search over title+body. Ranking tiers (design
   * doc): title hit > body hits > recency. Within a tier, more/earlier hits
   * count more; ties break by mtime descending. Empty/whitespace query
   * returns everything, most-recent first (lets the UI show "browse all"
   * with an empty search box).
   */
  search(query: string): MemoryNoteMeta[] {
    const q = query.trim().toLowerCase();
    if (!q) {
      return this.notes
        .slice()
        .sort((a, b) => b.mtime - a.mtime)
        .map(toMeta);
    }

    const tokens = q.split(/\s+/).filter(Boolean);

    type Scored = { note: IndexedNote; titleHits: number; bodyHits: number };
    const scored: Scored[] = [];

    for (const note of this.notes) {
      const titleLower = note.title.toLowerCase();
      const bodyLower = note.body.toLowerCase();
      let titleHits = 0;
      let bodyHits = 0;
      for (const t of tokens) {
        if (titleLower.includes(t)) titleHits += 1;
        if (bodyLower.includes(t)) bodyHits += countOccurrences(bodyLower, t);
      }
      if (titleHits === 0 && bodyHits === 0) continue;
      scored.push({ note, titleHits, bodyHits });
    }

    scored.sort((a, b) => {
      // Tier 1: any title hit ranks above any no-title-hit result.
      const aHasTitle = a.titleHits > 0 ? 1 : 0;
      const bHasTitle = b.titleHits > 0 ? 1 : 0;
      if (aHasTitle !== bHasTitle) return bHasTitle - aHasTitle;
      // Within the same tier: more title hits first, then more body hits.
      if (a.titleHits !== b.titleHits) return b.titleHits - a.titleHits;
      if (a.bodyHits !== b.bodyHits) return b.bodyHits - a.bodyHits;
      // Final tiebreaker: recency.
      return b.note.mtime - a.note.mtime;
    });

    return scored.map((s) => toMeta(s.note));
  }

  /** Look up a single note by its vault-relative path (as returned in search results), applying redaction. Returns undefined if not indexed (excluded/PII/missing/never indexed). */
  get(relPosixPath: string): (MemoryNoteMeta & { markdown: string }) | undefined {
    const note = this.notes.find((n) => n.path === relPosixPath);
    if (!note) return undefined;
    return { ...toMeta(note), markdown: redactSections(note.body) };
  }

  /** Absolute vault root this index is bound to — used by callers validating memory.get paths. */
  getVaultRoot(): string {
    return this.vaultRoot;
  }

  /** Test/debug helper: number of indexed notes. */
  size(): number {
    return this.notes.length;
  }
}

function toMeta(note: IndexedNote): MemoryNoteMeta {
  return {
    path: note.path,
    title: note.title,
    summary: note.summary,
    mtime: note.mtime,
    scope: note.scope,
    author: note.author,
  };
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let idx = 0;
  while ((idx = haystack.indexOf(needle, idx)) !== -1) {
    count += 1;
    idx += needle.length;
  }
  return count;
}

// ============================================================================
// Pins (per-room), gateway-local JSON persistence — data/memory-pins.json
// ============================================================================

export type MemoryPins = Record<string, string[]>; // roomId -> vault-relative paths

function pinsFilePath(dataDir: string): string {
  return join(dataDir, 'memory-pins.json');
}

/** Load pins from disk. Missing/corrupt file yields an empty pin set — never throws (mirrors files.ts's fail-soft posture). */
export function loadPins(dataDir: string): MemoryPins {
  const path = pinsFilePath(dataDir);
  if (!existsSync(path)) return {};
  try {
    const raw = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const out: MemoryPins = {};
      for (const [roomId, paths] of Object.entries(parsed as Record<string, unknown>)) {
        if (Array.isArray(paths)) {
          out[roomId] = paths.filter((p): p is string => typeof p === 'string');
        }
      }
      return out;
    }
    return {};
  } catch (e) {
    console.error(`[memory] failed to parse ${path} — starting with empty pins`, e);
    return {};
  }
}

export function savePins(dataDir: string, pins: MemoryPins): void {
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
  writeFileSync(pinsFilePath(dataDir), JSON.stringify(pins, null, 2));
}

export function pinNote(pins: MemoryPins, roomId: string, path: string): MemoryPins {
  const existing = pins[roomId] ?? [];
  if (existing.includes(path)) return pins;
  return { ...pins, [roomId]: [...existing, path] };
}

export function unpinNote(pins: MemoryPins, roomId: string, path: string): MemoryPins {
  const existing = pins[roomId];
  if (!existing || !existing.includes(path)) return pins;
  return { ...pins, [roomId]: existing.filter((p) => p !== path) };
}

/** Every roomId a given path is currently pinned in — for memory.note's pinnedInRooms field. */
export function roomsPinning(pins: MemoryPins, path: string): string[] {
  const out: string[] = [];
  for (const [roomId, paths] of Object.entries(pins)) {
    if (paths.includes(path)) out.push(roomId);
  }
  return out;
}

// ============================================================================
// Outbound compose-layer helper — pinned-context prepend
// ============================================================================

/** Hard caps from the original design: at most 3 pinned notes, 4k chars each, applied POST-redaction. */
export const MAX_PINNED_NOTES = 3;
export const MAX_PINNED_NOTE_CHARS = 4000;

/**
 * Build the `[Pinned context: <title>]` block(s) to prepend to an outbound
 * message for `roomId`, given the current pin set and a note lookup. Returns
 * '' when the room has no pins or none of its pinned paths still resolve
 * (e.g. re-indexed away) — callers should treat '' as "nothing to prepend"
 * and leave the outbound content untouched.
 *
 * Caps applied here: first MAX_PINNED_NOTES
 * pinned paths for the room (in pin order), each truncated to
 * MAX_PINNED_NOTE_CHARS characters of its POST-REDACTION markdown.
 */
export function buildPinnedContextBlock(
  pins: MemoryPins,
  roomId: string,
  getNote: (path: string) => { title: string; markdown: string } | undefined
): string {
  const paths = (pins[roomId] ?? []).slice(0, MAX_PINNED_NOTES);
  if (paths.length === 0) return '';

  const blocks: string[] = [];
  for (const path of paths) {
    const note = getNote(path);
    if (!note) continue; // pinned path no longer resolves (excluded/removed/never valid) — skip silently
    const truncated =
      note.markdown.length > MAX_PINNED_NOTE_CHARS
        ? `${note.markdown.slice(0, MAX_PINNED_NOTE_CHARS)}…`
        : note.markdown;
    blocks.push(`[Pinned context: ${note.title}]\n${truncated}`);
  }
  return blocks.join('\n\n');
}

/**
 * Apply the pinned-context block to an outbound content string (prepended,
 * blank-line separated from the original content). Pure string transform —
 * used at the compose choke point in relay.ts's relayMessageToAgents (see
 * that file's inline comment for exactly where/why), never inside the
 * worker/session machinery. No-op when there's nothing pinned.
 */
export function withPinnedContext(content: string, pinnedBlock: string): string {
  if (!pinnedBlock) return content;
  return `${pinnedBlock}\n\n${content}`;
}
