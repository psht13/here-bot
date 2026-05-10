import type { KnownMember } from "./models.js";

export type PingRequest = { kind: "all" } | { kind: "group"; groupKey: string };

export interface MentionChunkPlan<TMember> {
  label: string;
  members: TMember[];
}

export interface MentionChunkPlanningOptions<TMember> {
  maxLength: number;
  getMemberReferenceLength: (member: TMember) => number;
}

export function normalizeKey(raw: string): string | null {
  const value = raw.trim().toLowerCase();

  if (!/^[a-z0-9][a-z0-9_-]{1,31}$/.test(value)) {
    return null;
  }

  return value;
}

export function generateWorkspaceKey(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 18);

  const base = slug || "group";
  const suffix = Math.random().toString(36).slice(2, 6);

  return `${base}-${suffix}`;
}

export function userDisplayName(user: {
  first_name: string;
  last_name?: string | undefined;
  username?: string | undefined;
}): string {
  const fullName = [user.first_name, user.last_name].filter(Boolean).join(" ").trim();

  if (fullName) {
    return fullName;
  }

  if (user.username) {
    return user.username;
  }

  return "Unknown User";
}

export function planMentionChunks<TMember>(
  label: string,
  members: readonly TMember[],
  options: MentionChunkPlanningOptions<TMember>,
): MentionChunkPlan<TMember>[] {
  if (members.length === 0) {
    return [];
  }

  const heading = `@${label}`;
  const chunks: MentionChunkPlan<TMember>[] = [];
  let currentMembers: TMember[] = [];
  let currentLength = heading.length;

  for (const member of members) {
    const fragmentLength = 1 + options.getMemberReferenceLength(member);

    if (currentLength + fragmentLength > options.maxLength) {
      chunks.push({ label, members: currentMembers });
      currentMembers = [member];
      currentLength = heading.length + fragmentLength;
      continue;
    }

    currentMembers.push(member);
    currentLength += fragmentLength;
  }

  chunks.push({ label, members: currentMembers });

  return chunks;
}

export function parsePingRequest(raw: string): PingRequest | null {
  const tokens = raw.trim().split(/\s+/).filter(Boolean);

  if (tokens.length !== 1) {
    return null;
  }

  const token = tokens[0];

  if (!token) {
    return null;
  }

  const normalizedToken = token.toLowerCase();

  if (normalizedToken === "all") {
    return { kind: "all" };
  }

  const normalizedGroup = normalizeKey(token.startsWith("@") ? token.slice(1) : token);

  if (!normalizedGroup) {
    return null;
  }

  return { kind: "group", groupKey: normalizedGroup };
}

export function parseMentionPingRequest(raw: string, botUsername: string): PingRequest | null {
  const tokens = raw.trim().split(/\s+/).filter(Boolean);

  if (tokens.length < 2) {
    return null;
  }

  if (tokens[0]?.toLowerCase() !== `@${botUsername.toLowerCase()}`) {
    return null;
  }

  return parsePingRequest(tokens.slice(1).join(" "));
}

export function resolveMemberRefs(
  members: KnownMember[],
  refs: string[],
  extraIds: number[] = [],
): { ids: number[]; unresolved: string[] } {
  const byUsername = new Map<string, number>();
  const byId = new Map<number, number>();

  for (const member of members) {
    byId.set(member.id, member.id);

    if (member.username) {
      byUsername.set(member.username.toLowerCase(), member.id);
    }
  }

  const ids = new Set<number>(extraIds);
  const unresolved: string[] = [];

  for (const ref of refs) {
    const cleaned = ref.trim();

    if (!cleaned) {
      continue;
    }

    if (cleaned.startsWith("@")) {
      const resolved = byUsername.get(cleaned.slice(1).toLowerCase());

      if (resolved) {
        ids.add(resolved);
      } else {
        unresolved.push(cleaned);
      }

      continue;
    }

    if (/^\d+$/.test(cleaned)) {
      const numericId = Number(cleaned);

      if (byId.has(numericId)) {
        ids.add(numericId);
      } else {
        unresolved.push(cleaned);
      }

      continue;
    }

    unresolved.push(cleaned);
  }

  return {
    ids: [...ids],
    unresolved,
  };
}
