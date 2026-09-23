// Narrowing lists to what the caller may see.
//
// The route policy table declares these endpoints `handlerScoped`, which only
// records the intent — this is where it is actually done. Without it the list
// endpoints return everyone's data, because the underlying registries and files
// were built when there was exactly one user.

import { canAccessResource, ownerOf, resourceIdsOwnedBy } from "./ownership.ts";
import { resourceIdsSharedWith } from "./sharing.ts";
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
  // 共享进来的也算「看得见」。注意这是**只读**的可见性：能出现在列表里、能打开
  // 读，不代表能删 —— 删走的是 policy 里那条没标 access 的 owns 检查。
  const shared = resourceIdsSharedWith(user.id);
  return (id) => !!id && (owned.has(id) || shared.has(id));
}

// A bash task's session id is either a plain session UUID (web chat) or the
// group scope "gid:agentId" — so ownership hangs off the part before the colon.
export function taskSessionOwner(sessionId: string | undefined): string | null {
  if (!sessionId) return null;
  const colon = sessionId.indexOf(":");
  return ownerOf(colon === -1 ? sessionId : sessionId.slice(0, colon));
}

// `reader`：被共享者能在这条会话里续聊，那些 turn 起的后台 bash 任务挂的正是这条
// 会话的 id —— 按 owner 判定的话，她会看不到自己刚刚跑起来的任务。
export function canSeeTaskSession(
  user: User,
  sessionId: string | undefined,
): boolean {
  if (user.role === "admin") return true;
  // A task with no session cannot be attributed, so only admins see it.
  if (!sessionId) return false;
  const colon = sessionId.indexOf(":");
  return canAccessResource(
    user,
    colon === -1 ? sessionId : sessionId.slice(0, colon),
    "reader",
  );
}
