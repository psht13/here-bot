import type { KnownMember } from "./models.js";

const MAX_MESSAGE_LENGTH = 3900;

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

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function buildMention(member: KnownMember): string {
  return `<a href="tg://user?id=${member.id}">${escapeHtml(member.displayName)}</a>`;
}

export function buildMentionChunks(label: string, members: KnownMember[]): string[] {
  if (members.length === 0) {
    return [];
  }

  const heading = `@${label}`;
  const chunks: string[] = [];
  let current = heading;

  for (const member of members) {
    const fragment = ` ${buildMention(member)}`;

    if (current.length + fragment.length > MAX_MESSAGE_LENGTH) {
      chunks.push(current);
      current = `${heading}${fragment}`;
      continue;
    }

    current += fragment;
  }

  chunks.push(current);

  return chunks;
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
