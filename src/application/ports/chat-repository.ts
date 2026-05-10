import type { KnownChat, KnownMember, MentionGroup } from "../../domain/models.js";

export interface GroupChatInput {
  id: number;
  type: string;
  title?: string | undefined;
}

export interface UserInput {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string | undefined;
  username?: string | undefined;
}

export interface ChatRepository {
  init(): Promise<void>;
  ensureChat(chatInput: GroupChatInput): Promise<KnownChat>;
  upsertMember(chatInput: GroupChatInput, user: UserInput): Promise<void>;
  removeMember(chatId: number, userId: number): Promise<boolean>;
  getChat(chatId: number): KnownChat | null;
  getChatByWorkspaceKey(workspaceKey: string): KnownChat | null;
  listChats(): KnownChat[];
  listChatsForMember(userId: number): KnownChat[];
  listChatsForMemberByRecency(userId: number): KnownChat[];
  getMembers(chatId: number): KnownMember[];
  getGroup(chatId: number, groupKey: string): MentionGroup | null;
  getGroupMembers(chatId: number, groupKey: string): KnownMember[];
  upsertGroup(chatId: number, groupKey: string, memberIds: number[]): Promise<string | null>;
  addToGroup(chatId: number, groupKey: string, memberIds: number[]): Promise<string | null>;
  removeFromGroup(chatId: number, groupKey: string, memberIds: number[]): Promise<string | null>;
  deleteGroup(chatId: number, groupKey: string): Promise<boolean>;
  listGroups(chatId: number): MentionGroup[];
}
