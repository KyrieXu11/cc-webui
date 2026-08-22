// Narrowing lists to what the caller may see.
//
// The route policy table declares these endpoints `handlerScoped`, which only
// records the intent — this is where it is actually done. Without it the list
// endpoints return everyone's data, because the underlying registries and files
// were built when there was exactly one user.

import { canAccessResource, ownerOf, resourceIdsOwnedBy } from "./ownership.ts";
import type { User } from "./users.ts";

// One query up front rather than one per row.
export function visibilityFor(
  user: User,
): (resourceId: string | null | undefined) => boolean {
  if (user.role === "admin") {
    // Admins see everything, including unowned resources (decisions 10 & 11).
    return () => true;
  }
  const owned = resourceIdsOwnedBy(user.id);
  return (id) => !!id && owned.has(id);
}

// A bash task's session id is either a plain session UUID (web chat) or the
// group scope "gid:agentId" — so ownership hangs off the part before the colon.
export function taskSessionOwner(sessionId: string | undefined): string | null {
  if (!sessionId) return null;
  const colon = sessionId.indexOf(":");
  return ownerOf(colon === -1 ? sessionId : sessionId.slice(0, colon));
}

export function canSeeTaskSession(
  user: User,
  sessionId: string | undefined,
): boolean {
  if (user.role === "admin") return true;
  // A task with no session cannot be attributed, so only admins see it.
  if (!sessionId) return false;
  const colon = sessionId.indexOf(":");
  return canAccessResource(user, colon === -1 ? sessionId : sessionId.slice(0, colon));
}
