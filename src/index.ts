import "dotenv/config";

import { Bot, GrammyError, HttpError, type Context } from "grammy";
import { z } from "zod";

import {
  buildMentionChunks,
  normalizeKey,
  parseMentionPingRequest,
  parsePingRequest,
  resolveMemberRefs,
  type PingRequest,
} from "./domain.js";
import {
  buildDraftScreen,
  buildGroupScreen,
  buildGroupsScreen,
  buildHomeScreen,
  buildMembersScreen,
  DraftRegistry,
  parseManagerAction,
  type ManagerScreen,
} from "./manager.js";
import type { KnownChat, KnownMember } from "./models.js";
import {
  formatPingCooldownMessage,
  PingCooldownRegistry,
} from "./ping-cooldown.js";
import { JsonStore } from "./storage.js";

const envSchema = z.object({
  BOT_TOKEN: z.string().min(1, "BOT_TOKEN is required"),
  BOT_USERNAME: z
    .string()
    .min(5, "BOT_USERNAME is required")
    .regex(/^[a-z][a-z0-9_]{4,}$/i, "BOT_USERNAME must look like a Telegram bot username"),
  DATA_FILE: z.string().min(1).default("./data/bot-data.json"),
});

const env = envSchema.parse(process.env);
const store = new JsonStore(env.DATA_FILE);
const drafts = new DraftRegistry();
const pingCooldowns = new PingCooldownRegistry();
const bot = new Bot(env.BOT_TOKEN);
const INLINE_CONTEXT_TTL_MS = 10 * 60 * 1000;
const recentInlineChats = new Map<number, { chatId: number; updatedAt: number }>();
const HELP_TEXT = [
  "<b>Here Bot</b>",
  "",
  "What works on Telegram:",
  "- Use /here inside a group to mention every tracked member.",
  "- Use /tagset, /tagadd, /tagremove, /tag and /tags for smaller groups.",
  "- Use /manage for buttons to browse members and build subgroups.",
  `- Use @${env.BOT_USERNAME} all to ping everyone in the current group.`,
  `- Use @${env.BOT_USERNAME} &lt;group&gt; to ping one saved subgroup.`,
  `- The inline button flow uses the same query shapes: all or the subgroup name.`,
  "",
  "Important Telegram limits:",
  "- Telegram does not support a literal Slack-style @here keyword for bots.",
  "- Inline queries do not include the exact target chat ID, so the bot prefers the current group context and falls back to your most recent tracked group.",
  "- Bots cannot list every member of a broadcast channel. This bot supports groups/supergroups only.",
].join("\n");

type InlineQueryShape = {
  type: "article";
  id: string;
  title: string;
  description: string;
  input_message_content: {
    message_text: string;
    parse_mode?: "HTML";
  };
};

type SupportedGroupChat = Extract<
  NonNullable<Context["chat"]>,
  { type: "group" | "supergroup" }
>;

function isSupportedGroupChat(chat: Context["chat"]): chat is SupportedGroupChat {
  return Boolean(chat && (chat.type === "group" || chat.type === "supergroup"));
}

function parseArgs(input: string | undefined): string[] {
  return (input ?? "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function getMatchText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function buildMissingMembersHint(): string {
  return [
    "No members are tracked for this group yet.",
    "Make sure the bot is added to the group, inline mode is enabled in BotFather, and members have interacted with the bot or the group after the bot joined.",
    "For better coverage, disable privacy mode in BotFather and make the bot an admin if you want chat_member updates.",
  ].join("\n");
}

function buildMentionUsageText(): string {
  return `Usage: @${env.BOT_USERNAME} all or @${env.BOT_USERNAME} <subgroup-name>`;
}

function rememberInlineChatContext(userId: number, chatId: number): void {
  const now = Date.now();

  for (const [knownUserId, context] of recentInlineChats.entries()) {
    if (now - context.updatedAt > INLINE_CONTEXT_TTL_MS) {
      recentInlineChats.delete(knownUserId);
    }
  }

  recentInlineChats.set(userId, {
    chatId,
    updatedAt: now,
  });
}

function getRecentInlineChat(userId: number): KnownChat | null {
  const context = recentInlineChats.get(userId);

  if (!context) {
    return null;
  }

  if (Date.now() - context.updatedAt > INLINE_CONTEXT_TTL_MS) {
    recentInlineChats.delete(userId);
    return null;
  }

  return store.getChat(context.chatId);
}

function chatMatchesPingRequest(chat: KnownChat, request: PingRequest): boolean {
  if (request.kind === "all") {
    return true;
  }

  return Boolean(store.getGroup(chat.id, request.groupKey));
}

function resolveChatForPingRequest(userId: number, request: PingRequest): KnownChat | null {
  const recentChat = getRecentInlineChat(userId);

  if (recentChat && chatMatchesPingRequest(recentChat, request)) {
    return recentChat;
  }

  return store
    .listChatsForMemberByRecency(userId)
    .find((chat) => chatMatchesPingRequest(chat, request)) ?? null;
}

function getPingLabel(request: PingRequest): string {
  return request.kind === "all" ? "here" : request.groupKey;
}

function getMembersForPingRequest(chatId: number, request: PingRequest): KnownMember[] {
  return request.kind === "all"
    ? store.getMembers(chatId)
    : store.getGroupMembers(chatId, request.groupKey);
}

async function ensureTrackedCurrentUser(ctx: Context): Promise<void> {
  if (!isSupportedGroupChat(ctx.chat) || !ctx.from || ctx.from.is_bot) {
    return;
  }

  const currentChat = store.getChat(ctx.chat.id);

  if (currentChat?.members[String(ctx.from.id)]) {
    return;
  }

  await ctx.reply(
    "I can only add people I have seen. Ask the target members to send one message in this group after I join.",
  );
}

async function requireGroup(ctx: Context) {
  if (!isSupportedGroupChat(ctx.chat)) {
    await ctx.reply("This command only works inside a Telegram group or supergroup.");
    return null;
  }

  return ctx.chat;
}

async function sendMentionSequence(ctx: Context, label: string, members: KnownMember[]) {
  if (members.length === 0) {
    await ctx.reply(buildMissingMembersHint());
    return;
  }

  const chunks = buildMentionChunks(label, members);

  for (const chunk of chunks) {
    await ctx.reply(chunk, {
      parse_mode: "HTML",
    });
  }
}

async function replyManagerScreen(ctx: Context, screen: ManagerScreen): Promise<void> {
  await ctx.reply(screen.text, {
    parse_mode: "HTML",
    reply_markup: screen.keyboard,
  });
}

async function editManagerScreen(ctx: Context, screen: ManagerScreen): Promise<void> {
  try {
    await ctx.editMessageText(screen.text, {
      parse_mode: "HTML",
      reply_markup: screen.keyboard,
    });
  } catch (error) {
    if (error instanceof GrammyError && error.description.includes("message is not modified")) {
      return;
    }

    if (
      error instanceof GrammyError &&
      (
        error.description.includes("message can't be edited") ||
        error.description.includes("message to edit not found")
      )
    ) {
      await replyManagerScreen(ctx, screen);
      return;
    }

    throw error;
  }
}

function getHomeScreen(chatId: number): ManagerScreen | null {
  const registered = store.getChat(chatId);

  if (!registered) {
    return null;
  }

  return buildHomeScreen(
    registered,
    store.getMembers(chatId).length,
    store.listGroups(chatId).length,
  );
}

function getHumanUserId(ctx: Context): number | null {
  if (!ctx.from || ctx.from.is_bot) {
    return null;
  }

  return ctx.from.id;
}

function getDraftOwnerId(ctx: Context): number | null {
  return getHumanUserId(ctx);
}

function claimPingCooldown(ctx: Context, label: string): string | null {
  if (!isSupportedGroupChat(ctx.chat)) {
    return null;
  }

  const userId = getHumanUserId(ctx);

  if (!userId) {
    return null;
  }

  const remainingMs = pingCooldowns.reserve(ctx.chat.id, userId, label);

  if (remainingMs <= 0) {
    return null;
  }

  return formatPingCooldownMessage(remainingMs);
}

async function saveDraftAsGroup(
  ctx: Context,
  chatId: number,
  ownerId: number,
  rawGroupName: string,
): Promise<{ ok: true } | { ok: false }> {
  const normalizedTag = normalizeKey(rawGroupName.startsWith("@") ? rawGroupName.slice(1) : rawGroupName);

  if (!normalizedTag) {
    await ctx.reply(
      "Invalid subgroup name. Use 2-32 characters: letters, numbers, _ or -.",
    );
    return { ok: false };
  }

  const draft = drafts.get(chatId, ownerId);

  if (!draft) {
    await ctx.reply("No active subgroup draft. Start one with /manage.");
    return { ok: false };
  }

  if (draft.memberIds.length === 0) {
    await ctx.reply("Select at least one member before saving.");
    return { ok: false };
  }

  drafts.setGroupKey(chatId, ownerId, normalizedTag);
  const saved = await store.upsertGroup(chatId, normalizedTag, draft.memberIds);

  if (!saved) {
    await ctx.reply("That subgroup name is invalid.");
    return { ok: false };
  }

  drafts.clear(chatId, ownerId);
  const registered = store.getChat(chatId);
  const savedGroup = store.getGroup(chatId, saved);

  if (!registered || !savedGroup) {
    await ctx.reply(`Saved @${saved}.`);
    return { ok: true };
  }

  await replyManagerScreen(
    ctx,
    buildGroupScreen(
      registered,
      savedGroup,
      store.getGroupMembers(chatId, saved),
      0,
    ),
  );

  return { ok: true };
}

function resolveSelectedMembers(ctx: Context, chatId: number, refs: string[]) {
  const knownMembers = store.getMembers(chatId);
  const extraIds: number[] = [];

  if (ctx.from && !ctx.from.is_bot && refs.includes("me")) {
    extraIds.push(ctx.from.id);
  }

  const filteredRefs = refs.filter((ref) => ref !== "me");

  if (
    refs.length === 0 &&
    ctx.msg?.reply_to_message?.from &&
    !ctx.msg.reply_to_message.from.is_bot
  ) {
    extraIds.push(ctx.msg.reply_to_message.from.id);
  }

  return resolveMemberRefs(knownMembers, filteredRefs, extraIds);
}

bot.use(async (ctx, next) => {
  const message = ctx.message;

  if (isSupportedGroupChat(ctx.chat) && message) {
    await store.ensureChat(ctx.chat);

    if (ctx.from && !ctx.from.is_bot) {
      await store.upsertMember(ctx.chat, ctx.from);
      rememberInlineChatContext(ctx.from.id, ctx.chat.id);

      const draft = drafts.get(ctx.chat.id, ctx.from.id);
      const messageText = typeof message.text === "string"
        ? message.text.trim()
        : "";
      const [firstToken = ""] = messageText.split(/\s+/, 1);
      const startsWithBotMention = firstToken.toLowerCase() === `@${env.BOT_USERNAME.toLowerCase()}`;
      const mentionPingRequest = messageText
        ? parseMentionPingRequest(messageText, env.BOT_USERNAME)
        : null;

      if (
        draft?.awaitingName &&
        messageText &&
        !messageText.startsWith("/") &&
        !startsWithBotMention &&
        !mentionPingRequest
      ) {
        await saveDraftAsGroup(ctx, ctx.chat.id, ctx.from.id, messageText);
        return;
      }
    }

    const replyAuthor = message.reply_to_message?.from;

    if (replyAuthor && !replyAuthor.is_bot) {
      await store.upsertMember(ctx.chat, replyAuthor);
    }

    const newMembers = message.new_chat_members ?? [];

    for (const member of newMembers) {
      await store.upsertMember(ctx.chat, member);
    }
  }

  await next();
});

function buildInlineHelpResult(): InlineQueryShape {
  return {
    type: "article",
    id: "help",
    title: "Use all or a subgroup",
    description: buildMentionUsageText(),
    input_message_content: {
      message_text: HELP_TEXT,
      parse_mode: "HTML",
    },
  };
}

function createInlineResultId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function buildInlineResult(
  title: string,
  description: string,
  messageText: string,
): InlineQueryShape {
  return {
    type: "article",
    id: createInlineResultId(),
    title,
    description,
    input_message_content: {
      message_text: messageText,
      parse_mode: "HTML",
    },
  };
}

function buildInlinePingResult(chat: KnownChat, request: PingRequest): InlineQueryShape | null {
  const label = getPingLabel(request);
  const members = getMembersForPingRequest(chat.id, request);

  if (members.length === 0) {
    return null;
  }

  const chunks = buildMentionChunks(label, members);
  const firstChunk = chunks[0];

  if (!firstChunk || chunks.length > 1) {
    return null;
  }

  return buildInlineResult(
    request.kind === "all"
      ? `Ping everyone in ${chat.title}`
      : `Ping @${request.groupKey} in ${chat.title}`,
    `${members.length} tracked members`,
    firstChunk,
  );
}

async function registerCommands(): Promise<void> {
  await bot.api.setMyCommands([
    { command: "start", description: "Show setup help" },
    { command: "bind", description: "Register this group for @here pings" },
    { command: "status", description: "Open the group dashboard" },
    { command: "manage", description: "Open button-based subgroup manager" },
    { command: "here", description: "Mention every tracked member in this group" },
    { command: "tagset", description: "Create or replace a custom group" },
    { command: "tagadd", description: "Add members to a custom group" },
    { command: "tagremove", description: "Remove members from a custom group" },
    { command: "tag", description: "Mention a custom group" },
    { command: "tags", description: "List custom groups" },
    { command: "tagdelete", description: "Delete a custom group" },
    { command: "tagname", description: "Save the current button-built subgroup" },
  ]);
}

bot.command("start", async (ctx) => {
  await ctx.reply(HELP_TEXT, {
    parse_mode: "HTML",
  });
});

bot.command("help", async (ctx) => {
  await ctx.reply(HELP_TEXT, {
    parse_mode: "HTML",
  });
});

bot.command("bind", async (ctx) => {
  const chat = await requireGroup(ctx);

  if (!chat) {
    return;
  }

  const registered = await store.ensureChat(chat);
  const groupCount = store.listGroups(chat.id).length;

  await ctx.reply(
    [
      `Registered <b>${registered.title}</b>.`,
      `Tracked members: <b>${store.getMembers(chat.id).length}</b>`,
      `Custom groups: <b>${groupCount}</b>`,
      "",
      `Mention everyone: <code>@${env.BOT_USERNAME} all</code>`,
      `Mention a subgroup: <code>@${env.BOT_USERNAME} gang</code>`,
      "The inline button flow uses the same shapes: all or the subgroup name.",
    ].join("\n"),
    {
      parse_mode: "HTML",
      reply_markup: buildHomeScreen(
        registered,
        store.getMembers(chat.id).length,
        groupCount,
      ).keyboard,
    },
  );
});

bot.command("status", async (ctx) => {
  const chat = await requireGroup(ctx);

  if (!chat) {
    return;
  }

  const registered = await store.ensureChat(chat);
  await replyManagerScreen(
    ctx,
    buildHomeScreen(
      registered,
      store.getMembers(chat.id).length,
      store.listGroups(chat.id).length,
    ),
  );
});

bot.command("manage", async (ctx) => {
  const chat = await requireGroup(ctx);

  if (!chat) {
    return;
  }

  const registered = await store.ensureChat(chat);
  await replyManagerScreen(
    ctx,
    buildHomeScreen(
      registered,
      store.getMembers(chat.id).length,
      store.listGroups(chat.id).length,
    ),
  );
});

bot.command("here", async (ctx) => {
  const chat = await requireGroup(ctx);

  if (!chat) {
    return;
  }

  await store.ensureChat(chat);
  const members = store.getMembers(chat.id);

  if (members.length > 0) {
    const cooldownMessage = claimPingCooldown(ctx, "here");

    if (cooldownMessage) {
      await ctx.reply(cooldownMessage);
      return;
    }
  }

  await sendMentionSequence(ctx, "here", members);
});

bot.command("tags", async (ctx) => {
  const chat = await requireGroup(ctx);

  if (!chat) {
    return;
  }

  await store.ensureChat(chat);
  const groups = store.listGroups(chat.id);
  const registered = store.getChat(chat.id);

  if (!registered) {
    await ctx.reply("This group is not registered yet. Run /bind first.");
    return;
  }

  await replyManagerScreen(ctx, buildGroupsScreen(registered, groups, 0));
});

bot.command("tag", async (ctx) => {
  const chat = await requireGroup(ctx);

  if (!chat) {
    return;
  }

  const args = parseArgs(getMatchText(ctx.match));
  const tagKey = args[0];
  const normalizedTag = tagKey ? normalizeKey(tagKey) : null;

  if (!normalizedTag) {
    await ctx.reply("Usage: /tag <group-name>");
    return;
  }

  await store.ensureChat(chat);
  const members = store.getGroupMembers(chat.id, normalizedTag);

  if (members.length === 0) {
    await ctx.reply(
      "That group is empty or does not exist. Create it with /tagset first.",
    );
    return;
  }

  const cooldownMessage = claimPingCooldown(ctx, normalizedTag);

  if (cooldownMessage) {
    await ctx.reply(cooldownMessage);
    return;
  }

  await sendMentionSequence(ctx, normalizedTag, members);
});

bot.command("tagset", async (ctx) => {
  const chat = await requireGroup(ctx);

  if (!chat) {
    return;
  }

  const [tagKey, ...memberRefs] = parseArgs(getMatchText(ctx.match));
  const normalizedTag = tagKey ? normalizeKey(tagKey) : null;

  if (!normalizedTag) {
    await ctx.reply(
      "Usage: /tagset <group-name> <@username|user-id|me...>\nYou can also reply to a user with /tagset <group-name>.",
    );
    return;
  }

  await store.ensureChat(chat);
  const selection = resolveSelectedMembers(ctx, chat.id, memberRefs);

  if (selection.unresolved.length > 0) {
    await ctx.reply(
      `I could not resolve: ${selection.unresolved.join(", ")}.\nOnly tracked users in this group can be added.`,
    );
    return;
  }

  if (selection.ids.length === 0) {
    await ensureTrackedCurrentUser(ctx);
    await ctx.reply(
      "No users selected. Pass usernames, numeric IDs, `me`, or reply to a user message.",
    );
    return;
  }

  await store.upsertGroup(chat.id, normalizedTag, selection.ids);
  const members = store.getGroupMembers(chat.id, normalizedTag);

  await ctx.reply(
    `Saved @${normalizedTag} with ${members.length} member${members.length === 1 ? "" : "s"}.`,
  );
});

bot.command("tagadd", async (ctx) => {
  const chat = await requireGroup(ctx);

  if (!chat) {
    return;
  }

  const [tagKey, ...memberRefs] = parseArgs(getMatchText(ctx.match));
  const normalizedTag = tagKey ? normalizeKey(tagKey) : null;

  if (!normalizedTag) {
    await ctx.reply(
      "Usage: /tagadd <group-name> <@username|user-id|me...>\nYou can also reply to a user with /tagadd <group-name>.",
    );
    return;
  }

  await store.ensureChat(chat);
  const selection = resolveSelectedMembers(ctx, chat.id, memberRefs);

  if (selection.unresolved.length > 0) {
    await ctx.reply(
      `I could not resolve: ${selection.unresolved.join(", ")}.`,
    );
    return;
  }

  if (selection.ids.length === 0) {
    await ctx.reply("No users selected.");
    return;
  }

  const saved = await store.addToGroup(chat.id, normalizedTag, selection.ids);

  if (!saved) {
    await ctx.reply("That group name is invalid.");
    return;
  }

  const members = store.getGroupMembers(chat.id, saved);

  await ctx.reply(
    `Updated @${saved}. It now has ${members.length} member${members.length === 1 ? "" : "s"}.`,
  );
});

bot.command("tagremove", async (ctx) => {
  const chat = await requireGroup(ctx);

  if (!chat) {
    return;
  }

  const [tagKey, ...memberRefs] = parseArgs(getMatchText(ctx.match));
  const normalizedTag = tagKey ? normalizeKey(tagKey) : null;

  if (!normalizedTag) {
    await ctx.reply(
      "Usage: /tagremove <group-name> <@username|user-id|me...>\nYou can also reply to a user with /tagremove <group-name>.",
    );
    return;
  }

  await store.ensureChat(chat);
  const selection = resolveSelectedMembers(ctx, chat.id, memberRefs);

  if (selection.unresolved.length > 0) {
    await ctx.reply(
      `I could not resolve: ${selection.unresolved.join(", ")}.`,
    );
    return;
  }

  if (selection.ids.length === 0) {
    await ctx.reply("No users selected.");
    return;
  }

  const saved = await store.removeFromGroup(chat.id, normalizedTag, selection.ids);

  if (!saved) {
    await ctx.reply("That group does not exist.");
    return;
  }

  const members = store.getGroupMembers(chat.id, saved);

  await ctx.reply(
    `Updated @${saved}. It now has ${members.length} member${members.length === 1 ? "" : "s"}.`,
  );
});

bot.command("tagdelete", async (ctx) => {
  const chat = await requireGroup(ctx);

  if (!chat) {
    return;
  }

  const args = parseArgs(getMatchText(ctx.match));
  const tagKey = args[0];
  const normalizedTag = tagKey ? normalizeKey(tagKey) : null;

  if (!normalizedTag) {
    await ctx.reply("Usage: /tagdelete <group-name>");
    return;
  }

  await store.ensureChat(chat);
  const deleted = await store.deleteGroup(chat.id, normalizedTag);

  if (!deleted) {
    await ctx.reply("That group does not exist.");
    return;
  }

  await ctx.reply(`Deleted @${normalizedTag}.`);
});

bot.command("tagname", async (ctx) => {
  const chat = await requireGroup(ctx);

  if (!chat) {
    return;
  }

  const ownerId = getDraftOwnerId(ctx);

  if (!ownerId) {
    await ctx.reply("Only human users can save subgroup drafts.");
    return;
  }

  await store.ensureChat(chat);

  const [groupName] = parseArgs(getMatchText(ctx.match));
  
  if (!groupName) {
    await ctx.reply("Usage: /tagname <group-name>");
    return;
  }

  await saveDraftAsGroup(ctx, chat.id, ownerId, groupName);
});

bot.on("message:text", async (ctx) => {
  if (!isSupportedGroupChat(ctx.chat) || !ctx.from || ctx.from.is_bot) {
    return;
  }

  const messageText = ctx.message.text.trim();
  const [firstToken = ""] = messageText.split(/\s+/, 1);
  const botMention = `@${env.BOT_USERNAME.toLowerCase()}`;

  if (firstToken.toLowerCase() !== botMention) {
    return;
  }

  const request = parseMentionPingRequest(messageText, env.BOT_USERNAME);

  if (!request) {
    await ctx.reply(buildMentionUsageText());
    return;
  }

  const label = getPingLabel(request);
  const members = getMembersForPingRequest(ctx.chat.id, request);

  if (members.length === 0) {
    if (request.kind === "all") {
      await ctx.reply(buildMissingMembersHint());
      return;
    }

    await ctx.reply("That subgroup is empty or does not exist. Create it with /tagset first.");
    return;
  }

  const cooldownMessage = claimPingCooldown(ctx, label);

  if (cooldownMessage) {
    await ctx.reply(cooldownMessage);
    return;
  }

  await sendMentionSequence(ctx, label, members);
});

bot.on("chat_member", async (ctx) => {
  const chat = ctx.chatMember?.chat;

  if (!isSupportedGroupChat(chat)) {
    return;
  }

  await store.ensureChat(chat);

  const status = ctx.chatMember.new_chat_member.status;
  const user = ctx.chatMember.new_chat_member.user;

  if (status === "left" || status === "kicked") {
    await store.removeMember(chat.id, user.id);
    return;
  }

  await store.upsertMember(chat, user);
});

bot.on("my_chat_member", async (ctx) => {
  if (!isSupportedGroupChat(ctx.chat)) {
    return;
  }

  await store.ensureChat(ctx.chat);
});

bot.on("inline_query", async (ctx) => {
  const query = ctx.inlineQuery.query.trim();
  const userId = ctx.from.id;
  const memberChats = store.listChatsForMemberByRecency(userId);

  async function answer(results: InlineQueryShape[]): Promise<void> {
    await ctx.answerInlineQuery(results, {
      cache_time: 0,
      is_personal: true,
    });
  }

  function noTrackedGroupsResult(): InlineQueryShape {
    return buildInlineResult(
      "No tracked groups yet",
      "I do not know any groups for you yet",
      "I can only target groups where I have already seen you. Send one message in the target group after the bot joins, then try again.",
    );
  }

  function wrongChatTypeResult(): InlineQueryShape {
    return buildInlineResult(
      "Use this in a group",
      "This bot only pings group and supergroup members",
      "Open the target Telegram group and use all or a subgroup name there.",
    );
  }

  if (ctx.inlineQuery.chat_type && !["group", "supergroup"].includes(ctx.inlineQuery.chat_type)) {
    await answer([wrongChatTypeResult()]);
    return;
  }

  if (!query) {
    await answer([buildInlineHelpResult()]);
    return;
  }

  const request = parsePingRequest(query);

  if (!request) {
    await answer([buildInlineHelpResult()]);
    return;
  }

  const chat = resolveChatForPingRequest(userId, request);

  if (!chat) {
    if (memberChats.length === 0) {
      await answer([noTrackedGroupsResult()]);
      return;
    }

    await answer([
      buildInlineResult(
        request.kind === "all" ? "No recent group context" : "Unknown subgroup",
        request.kind === "all"
          ? "Open the target group first"
          : `I could not find @${request.groupKey}`,
        request.kind === "all"
          ? "Open the target group and send one normal message there first, or use the manager buttons in that group to seed the current chat context."
          : `I could not find a subgroup named @${request.groupKey} in your tracked groups.`,
      ),
    ]);
    return;
  }

  const result = buildInlinePingResult(chat, request);

  if (result) {
    await answer([result]);
    return;
  }

  const members = getMembersForPingRequest(chat.id, request);
  const label = getPingLabel(request);

  await answer([
    buildInlineResult(
      members.length === 0
        ? request.kind === "all"
          ? "No tracked members"
          : "Unknown or empty subgroup"
        : "Too many members for inline mode",
      members.length === 0
        ? request.kind === "all"
          ? "The target group has no tracked users yet"
          : `No members stored for @${label}`
        : "Send the same query as a normal group message",
      members.length === 0
        ? request.kind === "all"
          ? buildMissingMembersHint()
          : `I could not find a non-empty subgroup named @${label} in ${chat.title}.`
        : `This mention set is too large for one inline result. Send @${env.BOT_USERNAME} ${request.kind === "all" ? "all" : label} as a normal message in ${chat.title} instead.`,
    ),
  ]);
});

bot.on("callback_query:data", async (ctx) => {
  const action = parseManagerAction(ctx.callbackQuery.data);

  if (!action) {
    return;
  }

  if (!isSupportedGroupChat(ctx.chat) || ctx.chat.id !== action.chatId) {
    await ctx.answerCallbackQuery({
      text: "Open the manager from inside the target group.",
      show_alert: true,
    });
    return;
  }

  if (ctx.from && !ctx.from.is_bot) {
    rememberInlineChatContext(ctx.from.id, ctx.chat.id);
  }

  const registered = store.getChat(action.chatId);

  if (!registered) {
    await ctx.answerCallbackQuery({
      text: "This group is not registered yet. Run /bind first.",
      show_alert: true,
    });
    return;
  }

  if (action.kind === "home") {
    await ctx.answerCallbackQuery();

    const screen = getHomeScreen(action.chatId);

    if (!screen) {
      return;
    }

    await editManagerScreen(ctx, screen);
    return;
  }

  if (action.kind === "pingAll") {
    const members = store.getMembers(action.chatId);

    if (members.length > 0) {
      const cooldownMessage = claimPingCooldown(ctx, "here");

      if (cooldownMessage) {
        await ctx.answerCallbackQuery({
          text: cooldownMessage,
          show_alert: true,
        });
        return;
      }
    }

    await ctx.answerCallbackQuery();
    await sendMentionSequence(ctx, "here", members);
    return;
  }

  if (action.kind === "members") {
    await ctx.answerCallbackQuery();
    await editManagerScreen(
      ctx,
      buildMembersScreen(registered, store.getMembers(action.chatId), action.page),
    );
    return;
  }

  if (action.kind === "groups") {
    await ctx.answerCallbackQuery();
    await editManagerScreen(
      ctx,
      buildGroupsScreen(registered, store.listGroups(action.chatId), action.page),
    );
    return;
  }

  if (action.kind === "groupView") {
    const group = store.getGroup(action.chatId, action.groupKey);

    if (!group) {
      await ctx.answerCallbackQuery({
        text: "That subgroup no longer exists.",
        show_alert: true,
      });
      await editManagerScreen(
        ctx,
        buildGroupsScreen(registered, store.listGroups(action.chatId), action.page),
      );
      return;
    }

    await ctx.answerCallbackQuery();
    await editManagerScreen(
      ctx,
      buildGroupScreen(
        registered,
        group,
        store.getGroupMembers(action.chatId, action.groupKey),
        action.page,
      ),
    );
    return;
  }

  if (action.kind === "groupPing") {
    const members = store.getGroupMembers(action.chatId, action.groupKey);

    if (members.length === 0) {
      await ctx.answerCallbackQuery({
        text: "That subgroup is empty.",
        show_alert: true,
      });
      return;
    }

    const cooldownMessage = claimPingCooldown(ctx, action.groupKey);

    if (cooldownMessage) {
      await ctx.answerCallbackQuery({
        text: cooldownMessage,
        show_alert: true,
      });
      return;
    }

    await ctx.answerCallbackQuery();
    await sendMentionSequence(ctx, action.groupKey, members);
    return;
  }

  if (action.kind === "groupDelete") {
    const deleted = await store.deleteGroup(action.chatId, action.groupKey);

    await ctx.answerCallbackQuery({
      text: deleted ? `Deleted @${action.groupKey}` : "That subgroup was already removed.",
    });
    await editManagerScreen(
      ctx,
      buildGroupsScreen(registered, store.listGroups(action.chatId), action.page),
    );
    return;
  }

  const ownerId = getDraftOwnerId(ctx);

  if (!ownerId) {
    await ctx.answerCallbackQuery({
      text: "Only human users can manage subgroup drafts.",
      show_alert: true,
    });
    return;
  }

  if (action.kind === "draftNew") {
    const members = store.getMembers(action.chatId);
    const draft = drafts.create(action.chatId, ownerId);

    await ctx.answerCallbackQuery();
    await editManagerScreen(ctx, buildDraftScreen(registered, draft, members));
    return;
  }

  if (action.kind === "draftEdit") {
    const group = store.getGroup(action.chatId, action.groupKey);

    if (!group) {
      await ctx.answerCallbackQuery({
        text: "That subgroup no longer exists.",
        show_alert: true,
      });
      await editManagerScreen(
        ctx,
        buildGroupsScreen(registered, store.listGroups(action.chatId), action.page),
      );
      return;
    }

    const draft = drafts.create(action.chatId, ownerId, group.memberIds, group.key);

    await ctx.answerCallbackQuery();
    await editManagerScreen(
      ctx,
      buildDraftScreen(registered, draft, store.getMembers(action.chatId)),
    );
    return;
  }

  if (action.kind === "draftView") {
    const draft = drafts.setPage(action.chatId, ownerId, action.page);

    if (!draft) {
      await ctx.answerCallbackQuery({
        text: "That draft expired. Start again from New Subgroup.",
        show_alert: true,
      });
      await editManagerScreen(
        ctx,
        buildHomeScreen(
          registered,
          store.getMembers(action.chatId).length,
          store.listGroups(action.chatId).length,
        ),
      );
      return;
    }

    await ctx.answerCallbackQuery();
    await editManagerScreen(
      ctx,
      buildDraftScreen(registered, draft, store.getMembers(action.chatId)),
    );
    return;
  }

  if (action.kind === "draftToggle") {
    drafts.setPage(action.chatId, ownerId, action.page);
    const members = store.getMembers(action.chatId);
    const availableIds = new Set(members.map((member) => member.id));
    const draft = drafts.toggle(action.chatId, ownerId, action.memberId, availableIds);

    if (!draft) {
      await ctx.answerCallbackQuery({
        text: "That draft expired. Start again from New Subgroup.",
        show_alert: true,
      });
      return;
    }

    await ctx.answerCallbackQuery();
    await editManagerScreen(ctx, buildDraftScreen(registered, draft, members));
    return;
  }

  if (action.kind === "draftSave") {
    const draft = drafts.get(action.chatId, ownerId);

    if (!draft) {
      await ctx.answerCallbackQuery({
        text: "That draft expired. Start again from New Subgroup.",
        show_alert: true,
      });
      return;
    }

    if (draft.memberIds.length === 0) {
      await ctx.answerCallbackQuery({
        text: "Select at least one member before saving.",
        show_alert: true,
      });
      return;
    }

    if (!draft.groupKey) {
      const promptedDraft = drafts.promptForName(action.chatId, ownerId);

      if (!promptedDraft) {
        await ctx.answerCallbackQuery({
          text: "That draft expired. Start again from New Subgroup.",
          show_alert: true,
        });
        return;
      }

      await ctx.answerCallbackQuery({
        text: "Send the subgroup name as your next message in this group.",
        show_alert: true,
      });
      await editManagerScreen(
        ctx,
        buildDraftScreen(registered, promptedDraft, store.getMembers(action.chatId)),
      );
      return;
    }

    const saved = await store.upsertGroup(action.chatId, draft.groupKey, draft.memberIds);

    if (!saved) {
      await ctx.answerCallbackQuery({
        text: "That subgroup name is invalid.",
        show_alert: true,
      });
      return;
    }

    drafts.clear(action.chatId, ownerId);
    const savedGroup = store.getGroup(action.chatId, saved);

    await ctx.answerCallbackQuery({
      text: `Saved @${saved}`,
    });

    if (!savedGroup) {
      await editManagerScreen(
        ctx,
        buildHomeScreen(
          registered,
          store.getMembers(action.chatId).length,
          store.listGroups(action.chatId).length,
        ),
      );
      return;
    }

    await editManagerScreen(
      ctx,
      buildGroupScreen(
        registered,
        savedGroup,
        store.getGroupMembers(action.chatId, saved),
        0,
      ),
    );
    return;
  }

  if (action.kind === "draftCancel") {
    drafts.clear(action.chatId, ownerId);
    await ctx.answerCallbackQuery({
      text: "Draft cleared.",
    });
    await editManagerScreen(
      ctx,
      buildHomeScreen(
        registered,
        store.getMembers(action.chatId).length,
        store.listGroups(action.chatId).length,
      ),
    );
  }
});

bot.catch((error) => {
  const { ctx } = error;
  console.error("Bot update failed:", ctx.update.update_id);

  if (error.error instanceof GrammyError) {
    console.error("Telegram API error:", error.error.description);
    return;
  }

  if (error.error instanceof HttpError) {
    console.error("Telegram HTTP error:", error.error);
    return;
  }

  console.error("Unknown bot error:", error.error);
});

async function start(): Promise<void> {
  await store.init();
  await registerCommands();

  await bot.start({
    allowed_updates: [
      "message",
      "chat_member",
      "my_chat_member",
      "inline_query",
      "callback_query",
    ],
    onStart: (botInfo) => {
      console.log(`Running @${botInfo.username} with data file ${env.DATA_FILE}`);
    },
  });
}

void start();
