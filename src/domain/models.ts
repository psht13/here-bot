export interface KnownMember {
  id: number;
  displayName: string;
  username?: string | undefined;
  isBot: boolean;
  lastSeenAt: string;
}

export interface MentionGroup {
  key: string;
  label: string;
  memberIds: number[];
  createdAt: string;
  updatedAt: string;
}

export interface KnownChat {
  id: number;
  type: "group" | "supergroup";
  title: string;
  workspaceKey: string;
  members: Record<string, KnownMember>;
  groups: Record<string, MentionGroup>;
  updatedAt: string;
}

export interface PersistedData {
  chats: Record<string, KnownChat>;
}
