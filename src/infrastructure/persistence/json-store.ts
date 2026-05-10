import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import type {
  ChatRepository,
  GroupChatInput,
  UserInput,
} from "../../application/ports/chat-repository.js";
import { generateWorkspaceKey, normalizeKey, userDisplayName } from "../../domain/index.js";
import type { KnownChat, KnownMember, MentionGroup, PersistedData } from "../../domain/models.js";
import { parsePersistedData } from "./persisted-schema.js";

export class JsonStore implements ChatRepository {
  private data: PersistedData = { chats: {} };
  private readonly chatIdsByWorkspaceKey = new Map<string, string>();
  private readonly chatIdsByMemberId = new Map<string, Set<string>>();
  private writeChain: Promise<void> = Promise.resolve();
  private writeCounter = 0;

  constructor(private readonly filePath: string) {}

  async init(): Promise<void> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      this.data = parsePersistedData(JSON.parse(raw));
      this.rebuildIndexes();
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
    const before = existing ? `${existing.title}|${existing.type}|${existing.workspaceKey}` : null;
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
    this.addMemberChatIndex(key, String(chat.id));

    if (current && current.displayName === next.displayName && current.username === next.username) {
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
    this.removeMemberChatIndex(String(userId), String(chatId));

    const nowIso = new Date().toISOString();

    for (const group of Object.values(chat.groups)) {
      group.memberIds = group.memberIds.filter((memberId) => memberId !== userId);
      group.updatedAt = nowIso;
    }

    chat.updatedAt = nowIso;
    await this.commit();

    return true;
  }

  getChat(chatId: number): KnownChat | null {
    return this.data.chats[String(chatId)] ?? null;
  }

  getChatByWorkspaceKey(workspaceKey: string): KnownChat | null {
    const normalized = workspaceKey.trim().toLowerCase();
    const chatId = this.chatIdsByWorkspaceKey.get(normalized);

    return chatId ? (this.data.chats[chatId] ?? null) : null;
  }

  listChats(): KnownChat[] {
    return Object.values(this.data.chats).sort((left, right) =>
      left.title.localeCompare(right.title),
    );
  }

  listChatsForMember(userId: number): KnownChat[] {
    const key = String(userId);
    const chatIds = this.chatIdsByMemberId.get(key);

    if (!chatIds) {
      return [];
    }

    return [...chatIds]
      .map((chatId) => this.data.chats[chatId])
      .filter((chat): chat is KnownChat => Boolean(chat))
      .sort((left, right) => left.title.localeCompare(right.title));
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

    const removedIds = new Set(memberIds);
    const next = current.memberIds.filter((memberId) => !removedIds.has(memberId));
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

      if (!current.workspaceKey) {
        current.workspaceKey = this.generateUniqueWorkspaceKey(chatInput.title ?? current.title);
        this.indexWorkspaceKey(key, current.workspaceKey);
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
    this.indexWorkspaceKey(key, next.workspaceKey);

    return next;
  }

  private rebuildIndexes(): void {
    this.chatIdsByWorkspaceKey.clear();
    this.chatIdsByMemberId.clear();

    for (const [chatId, chat] of Object.entries(this.data.chats)) {
      this.indexWorkspaceKey(chatId, chat.workspaceKey);

      for (const memberId of Object.keys(chat.members)) {
        this.addMemberChatIndex(memberId, chatId);
      }
    }
  }

  private indexWorkspaceKey(chatId: string, workspaceKey: string | undefined): void {
    if (!workspaceKey) {
      return;
    }

    if (!this.chatIdsByWorkspaceKey.has(workspaceKey)) {
      this.chatIdsByWorkspaceKey.set(workspaceKey, chatId);
    }
  }

  private addMemberChatIndex(memberId: string, chatId: string): void {
    const chatIds = this.chatIdsByMemberId.get(memberId);

    if (chatIds) {
      chatIds.add(chatId);
      return;
    }

    this.chatIdsByMemberId.set(memberId, new Set([chatId]));
  }

  private removeMemberChatIndex(memberId: string, chatId: string): void {
    const chatIds = this.chatIdsByMemberId.get(memberId);

    if (!chatIds) {
      return;
    }

    chatIds.delete(chatId);

    if (chatIds.size === 0) {
      this.chatIdsByMemberId.delete(memberId);
    }
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
    const write = this.writeChain.then(() => this.writeAtomically(json));

    this.writeChain = write.catch(() => undefined);
    await write;
  }

  private async writeAtomically(json: string): Promise<void> {
    const targetDirectory = path.dirname(this.filePath);
    const tempFile = this.nextTempFile(targetDirectory);

    try {
      await mkdir(targetDirectory, { recursive: true });
      await writeFile(tempFile, json, { encoding: "utf8", flag: "wx", flush: true });
      await rename(tempFile, this.filePath);
    } catch (error) {
      await unlink(tempFile).catch(() => undefined);
      throw error;
    }
  }

  private nextTempFile(targetDirectory: string): string {
    this.writeCounter += 1;
    return path.join(
      targetDirectory,
      `.${path.basename(this.filePath)}.${process.pid}.${this.writeCounter}.tmp`,
    );
  }
}
