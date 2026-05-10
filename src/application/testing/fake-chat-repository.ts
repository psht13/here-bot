import type { ChatRepository, GroupChatInput, UserInput } from "../ports/chat-repository.js";
import { generateWorkspaceKey, normalizeKey, userDisplayName } from "../../domain/index.js";
import type { KnownChat, KnownMember, MentionGroup, PersistedData } from "../../domain/models.js";

export class FakeChatRepository implements ChatRepository {
  private data: PersistedData = { chats: {} };

  init(): Promise<void> {
    return Promise.resolve();
  }

  ensureChat(chatInput: GroupChatInput): Promise<KnownChat> {
    return Promise.resolve().then(() => this.getOrCreateChat(chatInput));
  }

  upsertMember(chatInput: GroupChatInput, user: UserInput): Promise<void> {
    if (user.is_bot) {
      return Promise.resolve();
    }

    return Promise.resolve().then(() => {
      const chat = this.getOrCreateChat(chatInput);
      const key = String(user.id);
      const next: KnownMember = {
        id: user.id,
        displayName: userDisplayName(user),
        username: user.username,
        isBot: false,
        lastSeenAt: new Date().toISOString(),
      };

      chat.members[key] = next;
      chat.updatedAt = next.lastSeenAt;
    });
  }

  removeMember(chatId: number, userId: number): Promise<boolean> {
    const chat = this.data.chats[String(chatId)];

    if (!chat) {
      return Promise.resolve(false);
    }

    const existed = Boolean(chat.members[String(userId)]);

    if (!existed) {
      return Promise.resolve(false);
    }

    delete chat.members[String(userId)];
    const nowIso = new Date().toISOString();

    for (const group of Object.values(chat.groups)) {
      group.memberIds = group.memberIds.filter((memberId) => memberId !== userId);
      group.updatedAt = nowIso;
    }

    chat.updatedAt = nowIso;

    return Promise.resolve(true);
  }

  getChat(chatId: number): KnownChat | null {
    return this.data.chats[String(chatId)] ?? null;
  }

  getChatByWorkspaceKey(workspaceKey: string): KnownChat | null {
    const normalized = workspaceKey.trim().toLowerCase();

    for (const chat of Object.values(this.data.chats)) {
      if (chat.workspaceKey === normalized) {
        return chat;
      }
    }

    return null;
  }

  listChats(): KnownChat[] {
    return Object.values(this.data.chats).sort((left, right) =>
      left.title.localeCompare(right.title),
    );
  }

  listChatsForMember(userId: number): KnownChat[] {
    const key = String(userId);

    return this.listChats().filter((chat) => Boolean(chat.members[key]));
  }

  listChatsForMemberByRecency(userId: number): KnownChat[] {
    const key = String(userId);

    return this.listChatsForMember(userId).sort((left, right) => {
      const leftSeenAt = left.members[key]?.lastSeenAt ?? "";
      const rightSeenAt = right.members[key]?.lastSeenAt ?? "";

      return rightSeenAt.localeCompare(leftSeenAt);
    });
  }

  getMembers(chatId: number): KnownMember[] {
    const chat = this.getChat(chatId);

    if (!chat) {
      return [];
    }

    return Object.values(chat.members).sort((left, right) =>
      left.displayName.localeCompare(right.displayName),
    );
  }

  getGroup(chatId: number, groupKey: string): MentionGroup | null {
    const normalized = normalizeKey(groupKey);
    const chat = this.getChat(chatId);

    if (!normalized || !chat) {
      return null;
    }

    return chat.groups[normalized] ?? null;
  }

  getGroupMembers(chatId: number, groupKey: string): KnownMember[] {
    const group = this.getGroup(chatId, groupKey);
    const chat = this.getChat(chatId);

    if (!group || !chat) {
      return [];
    }

    return group.memberIds
      .map((memberId) => chat.members[String(memberId)])
      .filter((member): member is KnownMember => Boolean(member))
      .sort((left, right) => left.displayName.localeCompare(right.displayName));
  }

  upsertGroup(chatId: number, groupKey: string, memberIds: number[]): Promise<string | null> {
    const normalized = normalizeKey(groupKey);
    const chat = this.getChat(chatId);

    if (!normalized || !chat) {
      return Promise.resolve(null);
    }

    const deduped = [...new Set(memberIds)].filter((memberId) =>
      Boolean(chat.members[String(memberId)]),
    );

    const existing = chat.groups[normalized];
    const now = new Date().toISOString();

    chat.groups[normalized] = {
      key: normalized,
      label: normalized,
      memberIds: deduped,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    chat.updatedAt = now;

    return Promise.resolve(normalized);
  }

  addToGroup(chatId: number, groupKey: string, memberIds: number[]): Promise<string | null> {
    const current = this.getGroup(chatId, groupKey);
    const merged = [...(current?.memberIds ?? []), ...memberIds];
    return this.upsertGroup(chatId, groupKey, merged);
  }

  removeFromGroup(chatId: number, groupKey: string, memberIds: number[]): Promise<string | null> {
    const current = this.getGroup(chatId, groupKey);

    if (!current) {
      return Promise.resolve(null);
    }

    const removedIds = new Set(memberIds);
    const next = current.memberIds.filter((memberId) => !removedIds.has(memberId));
    return this.upsertGroup(chatId, groupKey, next);
  }

  deleteGroup(chatId: number, groupKey: string): Promise<boolean> {
    const normalized = normalizeKey(groupKey);
    const chat = this.getChat(chatId);

    if (!normalized || !chat || !chat.groups[normalized]) {
      return Promise.resolve(false);
    }

    delete chat.groups[normalized];
    chat.updatedAt = new Date().toISOString();

    return Promise.resolve(true);
  }

  listGroups(chatId: number): MentionGroup[] {
    const chat = this.getChat(chatId);

    if (!chat) {
      return [];
    }

    return Object.values(chat.groups).sort((left, right) => left.key.localeCompare(right.key));
  }

  private getOrCreateChat(chatInput: GroupChatInput): KnownChat {
    if (chatInput.type !== "group" && chatInput.type !== "supergroup") {
      throw new Error("This bot only supports groups and supergroups.");
    }

    const key = String(chatInput.id);
    const current = this.data.chats[key];
    const now = new Date().toISOString();

    if (current) {
      current.title = chatInput.title?.trim() || current.title;
      current.type = chatInput.type;
      current.updatedAt = now;

      return current;
    }

    const next: KnownChat = {
      id: chatInput.id,
      type: chatInput.type,
      title: chatInput.title?.trim() || `chat-${chatInput.id}`,
      workspaceKey: this.generateUniqueWorkspaceKey(chatInput.title ?? `chat-${chatInput.id}`),
      members: {},
      groups: {},
      updatedAt: now,
    };

    this.data.chats[key] = next;

    return next;
  }

  private generateUniqueWorkspaceKey(title: string): string {
    let candidate = generateWorkspaceKey(title);

    while (this.getChatByWorkspaceKey(candidate)) {
      candidate = generateWorkspaceKey(title);
    }

    return candidate;
  }
}
