import { z } from "zod";

import type { KnownChat, PersistedData } from "../../domain/models.js";

const persistedMemberSchema = z.looseObject({
  id: z.number(),
  displayName: z.string(),
  username: z.string().optional(),
  isBot: z.boolean(),
  lastSeenAt: z.string(),
});

const persistedGroupSchema = z.looseObject({
  key: z.string(),
  label: z.string(),
  memberIds: z.array(z.number()),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const persistedMembersSchema = z
  .record(z.string(), persistedMemberSchema)
  .nullish()
  .transform((members) => members ?? {});

const persistedGroupsSchema = z
  .record(z.string(), persistedGroupSchema)
  .nullish()
  .transform((groups) => groups ?? {});

const persistedChatSchema = z.looseObject({
  id: z.number(),
  type: z.enum(["group", "supergroup"]),
  title: z.string(),
  workspaceKey: z.string(),
  members: persistedMembersSchema,
  groups: persistedGroupsSchema,
  updatedAt: z.string(),
});

const persistedDataSchema = z.looseObject({
  chats: z
    .record(z.string(), persistedChatSchema)
    .nullish()
    .transform((chats) => chats ?? {}),
});

export function parsePersistedData(raw: unknown): PersistedData {
  const parsed = persistedDataSchema.parse(raw);
  const chats: Record<string, KnownChat> = {};

  for (const [chatId, chat] of Object.entries(parsed.chats)) {
    chats[chatId] = {
      ...chat,
      members: chat.members,
      groups: chat.groups,
    };
  }

  return { chats };
}
