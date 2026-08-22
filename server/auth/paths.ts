// The folder whitelist.
//
// ⚠️ This is a GUARDRAIL, not isolation. The agent runs as this process's OS
// user and has an unrestricted shell (server/bash-mcp.ts spawns `bash -lc` with
// cwd as a starting directory, not a jail), so any user permitted to open any
// folder can read anything that OS user can. See docs/user-permissions.md.
// What this controls is which directory the UI starts in.

import { promises as fsp } from "node:fs";
import path from "node:path";
import os from "node:os";

export function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  return p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p;
}

// realpath the deepest part of the path that exists, then re-attach the rest.
//
// Plain realpath throws ENOENT for a directory the user is about to create, and
// resolving nothing at all would let a symlinked parent escape the whitelist.
// Walking up gives both: symlinks in existing ancestors are resolved, and a
// not-yet-created leaf still normalises.
export async function normalizePath(raw: string): Promise<string> {
  const abs = path.resolve(expandHome(raw));
  const tail: string[] = [];
  let probe = abs;
  for (;;) {
    try {
      const real = await fsp.realpath(probe);
      return tail.length ? path.join(real, ...tail.reverse()) : real;
    } catch {
      const parent = path.dirname(probe);
      if (parent === probe) return abs; // hit the root; nothing resolved
      tail.push(path.basename(probe));
      probe = parent;
    }
  }
}

const GLOB_CHARS = /[*?[\]{}]/;

// Patterns are absolute or `~`-relative. A pattern that is neither is rooted at
// "/" — which is what makes a bare "**" mean "anything".
//
// NOT path.resolve(): that resolves against process.cwd(), so "**" silently
// became "<cwd>/**" and the admin's default whitelist of ["**"] matched
// nothing at all.
export function normalizePattern(raw: string): string {
  const expanded = expandHome(raw.trim());
  const rooted = path.isAbsolute(expanded)
    ? expanded
    : path.join("/", expanded);
  return path.normalize(rooted);
}

// Resolve symlinks in the LITERAL prefix of a pattern, leaving the glob part
// alone.
//
// Necessary because the path being checked has been realpath'd, and on macOS
// /tmp and /var are symlinks into /private. Without this, an admin who writes
// "/tmp/**" gets a pattern that can never match, because every real path under
// it normalises to "/private/tmp/...".
export async function canonicalizePattern(raw: string): Promise<string> {
  const pattern = normalizePattern(raw);
  const segments = pattern.split(path.sep);
  const globAt = segments.findIndex((seg) => GLOB_CHARS.test(seg));
  const literal = globAt === -1 ? pattern : segments.slice(0, globAt).join(path.sep) || path.sep;
  const rest = globAt === -1 ? [] : segments.slice(globAt);
  try {
    const real = await fsp.realpath(literal);
    return rest.length ? path.join(real, ...rest) : real;
  } catch {
    // A pattern may legitimately point at something not created yet.
    return pattern;
  }
}

// `*` matches one segment, `**` matches any depth (Node's own glob semantics).
// Pure, and expects patterns that are ALREADY canonical — call it via
// assertCanOpen unless you know your patterns contain no symlinks.
export function matchesAnyPattern(
  normalizedPath: string,
  patterns: readonly string[],
): boolean {
  for (const raw of patterns) {
    const pattern = normalizePattern(raw);
    if (normalizedPath === pattern) return true;
    if (path.matchesGlob(normalizedPath, pattern)) return true;
    // A LITERAL directory implies its subtree: "/a/b" also allows "/a/b/c/d",
    // so an admin need not write every entry twice.
    //
    // Only for literal paths, though. Expanding a pattern that already has a
    // glob would silently make it recursive — "/code/*" means "the direct
    // children of /code", and turning it into "/code/*/**" would quietly
    // authorise everything underneath them too.
    if (!GLOB_CHARS.test(pattern)) {
      if (path.matchesGlob(normalizedPath, path.join(pattern, "**"))) return true;
    }
  }
  return false;
}

export class PathNotAllowedError extends Error {
  constructor(readonly requested: string) {
    super(`path not allowed: ${requested}`);
    this.name = "PathNotAllowedError";
  }
}

// Normalises, then checks. Returns the NORMALISED path so callers use the same
// value that was authorised rather than re-deriving it.
export async function assertCanOpen(
  raw: string,
  patterns: readonly string[],
): Promise<string> {
  const normalized = await normalizePath(raw);
  // Both sides get symlinks resolved, or /tmp/** vs /private/tmp/... never
  // lines up on macOS.
  const canonical = await Promise.all(patterns.map(canonicalizePattern));
  if (!matchesAnyPattern(normalized, canonical)) {
    throw new PathNotAllowedError(raw);
  }
  return normalized;
}
