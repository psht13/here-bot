import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { generateWorkspaceKey, normalizeKey, userDisplayName } from "./domain.js";
import type { KnownChat, KnownMember, PersistedData } from "./models.js";

interface GroupChatInput {
  id: number;
  type: string;
  title?: string | undefined;
}

interface UserInput {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string | undefined;
  username?: string | undefined;
}

export class JsonStore {
  private data: PersistedData = { chats: {} };
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async init(): Promise<void> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<PersistedData>;

      this.data = {
        chats: Object.fromEntries(
          Object.entries(parsed.chats ?? {}).map(([chatId, chat]) => [
            chatId,
            {
              ...chat,
              members: chat.members ?? {},
              groups: chat.groups ?? {},
            },
          ]),
        ) as PersistedData["chats"],
      };
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;

      if (nodeError.code !== "ENOENT") {
        throw error;
      }

      await this.commit();
    }
  }

  async ensureChat(chatInput: GroupChatInput): Promise<KnownChat> {
    const existing = this.data.chats[String(chatInput.id)];
    const before = existing
      ? `${existing.title}|${existing.type}|${existing.workspaceKey}`
      : null;
    const chat = this.getOrCreateChat(chatInput);
    const after = `${chat.title}|${chat.type}|${chat.workspaceKey}`;

    if (!existing || before !== after) {
      await this.commit();
    }

    return chat;
  }

  async upsertMember(chatInput: GroupChatInput, user: UserInput): Promise<void> {
    if (user.is_bot) {
      return;
    }

    const chat = this.getOrCreateChat(chatInput);
    const key = String(user.id);
    const current = chat.members[key];
    const next: KnownMember = {
      id: user.id,
      displayName: userDisplayName(user),
      username: user.username,
      isBot: false,
      lastSeenAt: new Date().toISOString(),
    };

    chat.members[key] = next;
    chat.updatedAt = next.lastSeenAt;

    if (
      current &&
      current.displayName === next.displayName &&
      current.username === next.username
    ) {
      return;
    }

    await this.commit();
  }

  async removeMember(chatId: number, userId: number): Promise<boolean> {
    const chat = this.data.chats[String(chatId)];

    if (!chat) {
      return false;
    }

    const existed = Boolean(chat.members[String(userId)]);

    if (!existed) {
      return false;
    }

    delete chat.members[String(userId)];

    for (const group of Object.values(chat.groups)) {
      group.memberIds = group.memberIds.filter((memberId) => memberId !== userId);
      group.updatedAt = new Date().toISOString();
    }

    chat.updatedAt = new Date().toISOString();
    await this.commit();

    return true;
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

  getMembers(chatId: number): KnownMember[] {
    const chat = this.getChat(chatId);

    if (!chat) {
      return [];
    }

    return Object.values(chat.members).sort((left, right) =>
      left.displayName.localeCompare(right.displayName),
    );
  }

  getGroup(chatId: number, groupKey: string) {
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

  async upsertGroup(chatId: number, groupKey: string, memberIds: number[]): Promise<string | null> {
    const normalized = normalizeKey(groupKey);
    const chat = this.getChat(chatId);

    if (!normalized || !chat) {
      return null;
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

    await this.commit();

    return normalized;
  }

  async addToGroup(chatId: number, groupKey: string, memberIds: number[]): Promise<string | null> {
    const current = this.getGroup(chatId, groupKey);
    const merged = [...(current?.memberIds ?? []), ...memberIds];
    return this.upsertGroup(chatId, groupKey, merged);
  }

  async removeFromGroup(
    chatId: number,
    groupKey: string,
    memberIds: number[],
  ): Promise<string | null> {
    const current = this.getGroup(chatId, groupKey);

    if (!current) {
      return null;
    }

    const next = current.memberIds.filter((memberId) => !memberIds.includes(memberId));
    return this.upsertGroup(chatId, groupKey, next);
  }

  async deleteGroup(chatId: number, groupKey: string): Promise<boolean> {
    const normalized = normalizeKey(groupKey);
    const chat = this.getChat(chatId);

    if (!normalized || !chat || !chat.groups[normalized]) {
      return false;
    }

    delete chat.groups[normalized];
    chat.updatedAt = new Date().toISOString();
    await this.commit();

    return true;
  }

  listGroups(chatId: number) {
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

      if (!current.workspaceKey) {
        current.workspaceKey = this.generateUniqueWorkspaceKey(chatInput.title ?? current.title);
      }

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

  private async commit(): Promise<void> {
    const json = JSON.stringify(this.data, null, 2);
    const targetDirectory = path.dirname(this.filePath);
    const tempFile = `${this.filePath}.tmp`;

    this.writeChain = this.writeChain.then(async () => {
      await mkdir(targetDirectory, { recursive: true });
      await writeFile(tempFile, json, "utf8");
      await rename(tempFile, this.filePath);
    });

    await this.writeChain;
  }
}
