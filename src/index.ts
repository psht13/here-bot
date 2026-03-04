import "dotenv/config";

import { Bot, GrammyError, HttpError, type Context } from "grammy";
import { z } from "zod";

import {
  buildMentionChunks,
  normalizeKey,
  resolveMemberRefs,
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
const bot = new Bot(env.BOT_TOKEN);
const INLINE_RESULT_LIMIT = 20;
const HELP_TEXT = [
  "<b>Here Bot</b>",
  "",
  "What works on Telegram:",
  "- Use /here inside a group to mention every tracked member.",
  "- Use /tagset, /tagadd, /tagremove, /tag and /tags for smaller groups.",
  "- Use /manage for buttons to browse members and build subgroups.",
  `- Use inline mode as @${env.BOT_USERNAME}, @${env.BOT_USERNAME} all, or @${env.BOT_USERNAME} &lt;group&gt;.`,
  "- If you are tracked in one group, the bot uses it automatically.",
  "- If you are tracked in multiple groups, Telegram shows one result per group so you can tap the right one.",
  `- The old explicit syntax still works: @${env.BOT_USERNAME} all &lt;workspace-key&gt; or @${env.BOT_USERNAME} tag &lt;workspace-key&gt; &lt;group&gt;.`,
  "",
  "Important Telegram limits:",
  "- Telegram does not support a literal Slack-style @here trigger for bots.",
  "- Inline queries do not include the target chat ID, so the bot auto-matches your tracked groups and only needs a workspace key for explicit targeting.",
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

function getDraftOwnerId(ctx: Context): number | null {
  if (!ctx.from || ctx.from.is_bot) {
    return null;
  }

  return ctx.from.id;
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
  if (isSupportedGroupChat(ctx.chat) && ctx.msg) {
    await store.ensureChat(ctx.chat);

    if (ctx.from && !ctx.from.is_bot) {
      await store.upsertMember(ctx.chat, ctx.from);

      const draft = drafts.get(ctx.chat.id, ctx.from.id);
      const messageText = "text" in ctx.msg && typeof ctx.msg.text === "string"
        ? ctx.msg.text.trim()
        : "";

      if (draft?.awaitingName && messageText && !messageText.startsWith("/")) {
        await saveDraftAsGroup(ctx, ctx.chat.id, ctx.from.id, messageText);
        return;
      }
    }

    const replyAuthor = ctx.msg.reply_to_message?.from;

    if (replyAuthor && !replyAuthor.is_bot) {
      await store.upsertMember(ctx.chat, replyAuthor);
    }

    const newMembers = ctx.msg.new_chat_members ?? [];

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
    title: "How to use Here Bot",
    description: "Commands and inline syntax",
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

function buildInlineEveryoneResult(chat: KnownChat): InlineQueryShape | null {
  const members = store.getMembers(chat.id);

  if (members.length === 0) {
    return null;
  }

  const chunks = buildMentionChunks("here", members);
  const firstChunk = chunks[0];

  if (!firstChunk || chunks.length > 1) {
    return null;
  }

  return buildInlineResult(
    `Ping everyone in ${chat.title}`,
    `${members.length} tracked members`,
    firstChunk,
  );
}

function buildInlineTagResult(chat: KnownChat, groupKey: string): InlineQueryShape | null {
  const members = store.getGroupMembers(chat.id, groupKey);

  if (members.length === 0) {
    return null;
  }

  const chunks = buildMentionChunks(groupKey, members);
  const firstChunk = chunks[0];

  if (!firstChunk || chunks.length > 1) {
    return null;
  }

  return buildInlineResult(
    `Ping @${groupKey} in ${chat.title}`,
    `${members.length} tracked members`,
    firstChunk,
  );
}

function buildMembershipScopedAllResults(userId: number): InlineQueryShape[] {
  return store
    .listChatsForMember(userId)
    .map((chat) => buildInlineEveryoneResult(chat))
    .filter((result): result is InlineQueryShape => Boolean(result))
    .slice(0, INLINE_RESULT_LIMIT);
}

function buildMembershipScopedTagResults(
  userId: number,
  groupKey: string,
): InlineQueryShape[] {
  return store
    .listChatsForMember(userId)
    .filter((chat) => Boolean(store.getGroup(chat.id, groupKey)))
    .map((chat) => buildInlineTagResult(chat, groupKey))
    .filter((result): result is InlineQueryShape => Boolean(result))
    .slice(0, INLINE_RESULT_LIMIT);
}

async function registerCommands(): Promise<void> {
  await bot.api.setMyCommands([
    { command: "start", description: "Show setup help" },
    { command: "bind", description: "Register this group and show its workspace key" },
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
      `Workspace key: <code>${registered.workspaceKey}</code>`,
      `Tracked members: <b>${store.getMembers(chat.id).length}</b>`,
      `Custom groups: <b>${groupCount}</b>`,
      "",
      `Inline usage: <code>@${env.BOT_USERNAME}</code> or <code>@${env.BOT_USERNAME} all</code>`,
      `Inline subgroup: <code>@${env.BOT_USERNAME} gang</code>`,
      `Explicit fallback: <code>@${env.BOT_USERNAME} all ${registered.workspaceKey}</code>`,
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
  await sendMentionSequence(ctx, "here", store.getMembers(chat.id));
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
  const tokens = query ? query.split(/\s+/).filter(Boolean) : [];
  const [rawAction = ""] = tokens;
  const normalizedAction = rawAction.toLowerCase();
  const userId = ctx.from.id;
  const memberChats = store.listChatsForMember(userId);

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
      "I can only auto-select groups where I have already seen you. Send one message in the target group after the bot joins, then try inline mode again.",
    );
  }

  function noInlineReadyGroupsResult(): InlineQueryShape {
    return buildInlineResult(
      "No inline-ready groups",
      "Use /here or /tag inside the group",
      "I found your tracked groups, but they are either empty or too large for a single inline message. Use /here or /tag inside the target group instead.",
    );
  }

  if (tokens.length === 0 || normalizedAction === "all" || normalizedAction === "here") {
    if (tokens.length >= 2) {
      const workspaceKey = tokens[1] ?? "";
      const chat = store.getChatByWorkspaceKey(workspaceKey);

      if (!chat) {
        await answer([
          buildInlineResult(
            "Unknown workspace",
            `No group registered as ${workspaceKey}`,
            `I could not find the workspace key "${workspaceKey}". Run /bind in the target group first.`,
          ),
        ]);
        return;
      }

      const result = buildInlineEveryoneResult(chat);

      if (result) {
        await answer([result]);
        return;
      }

      const members = store.getMembers(chat.id);

      await answer([
        buildInlineResult(
          members.length === 0 ? "No tracked members" : "Too many members for inline mode",
          members.length === 0
            ? "The target group has no tracked users yet"
            : "Use /here in the group for large teams",
          members.length === 0
            ? buildMissingMembersHint()
            : "This mention set is too large for a single inline message. Use /here inside the target group instead.",
        ),
      ]);
      return;
    }

    const results = buildMembershipScopedAllResults(userId);

    if (results.length > 0) {
      await answer(results);
      return;
    }

    await answer([
      memberChats.length === 0 ? noTrackedGroupsResult() : noInlineReadyGroupsResult(),
    ]);
    return;
  }

  if (normalizedAction === "tag" || normalizedAction === "group") {
    if (tokens.length >= 3) {
      const workspaceKey = tokens[1] ?? "";
      const chat = store.getChatByWorkspaceKey(workspaceKey);

      if (!chat) {
        await answer([
          buildInlineResult(
            "Unknown workspace",
            `No group registered as ${workspaceKey}`,
            `I could not find the workspace key "${workspaceKey}". Run /bind in the target group first.`,
          ),
        ]);
        return;
      }

      const normalizedTag = normalizeKey(tokens[2] ?? "");

      if (!normalizedTag) {
        await answer([buildInlineHelpResult()]);
        return;
      }

      const result = buildInlineTagResult(chat, normalizedTag);

      if (result) {
        await answer([result]);
        return;
      }

      const members = store.getGroupMembers(chat.id, normalizedTag);

      await answer([
        buildInlineResult(
          members.length === 0 ? "Unknown or empty group" : "Too many members for inline mode",
          members.length === 0
            ? `No members stored for @${normalizedTag}`
            : "Use /tag inside the group for large custom groups",
          members.length === 0
            ? `I could not find a non-empty custom group named @${normalizedTag} in ${chat.title}.`
            : `@${normalizedTag} is too large for a single inline message. Use /tag ${normalizedTag} inside the group instead.`,
        ),
      ]);
      return;
    }

    const normalizedTag = normalizeKey(tokens[1] ?? "");

    if (!normalizedTag) {
      await answer([buildInlineHelpResult()]);
      return;
    }

    const results = buildMembershipScopedTagResults(userId, normalizedTag);

    if (results.length > 0) {
      await answer(results);
      return;
    }

    if (memberChats.length === 0) {
      await answer([noTrackedGroupsResult()]);
      return;
    }

    const matchingChats = memberChats.filter((chat) =>
      Boolean(store.getGroup(chat.id, normalizedTag)),
    );

    await answer([
      buildInlineResult(
        matchingChats.length === 0 ? "Unknown subgroup" : "Subgroup not inline-ready",
        matchingChats.length === 0
          ? `I could not find @${normalizedTag} in your tracked groups`
          : "Use /tag inside the group instead",
        matchingChats.length === 0
          ? `I could not find a subgroup named @${normalizedTag} in the groups where I know you.`
          : `I found @${normalizedTag}, but it is empty or too large for a single inline message. Use /tag ${normalizedTag} inside the target group instead.`,
      ),
    ]);
    return;
  }

  if (tokens.length === 1) {
    const normalizedTag = normalizeKey(tokens[0] ?? "");

    if (!normalizedTag) {
      await answer([buildInlineHelpResult()]);
      return;
    }

    const results = buildMembershipScopedTagResults(userId, normalizedTag);

    if (results.length > 0) {
      await answer(results);
      return;
    }

    if (memberChats.length === 0) {
      await answer([noTrackedGroupsResult()]);
      return;
    }

    const matchingChats = memberChats.filter((chat) =>
      Boolean(store.getGroup(chat.id, normalizedTag)),
    );

    await answer([
      buildInlineResult(
        matchingChats.length === 0 ? "Unknown subgroup" : "Subgroup not inline-ready",
        matchingChats.length === 0
          ? `I could not find @${normalizedTag} in your tracked groups`
          : "Use /tag inside the group instead",
        matchingChats.length === 0
          ? `I could not find a subgroup named @${normalizedTag} in the groups where I know you.`
          : `I found @${normalizedTag}, but it is empty or too large for a single inline message. Use /tag ${normalizedTag} inside the target group instead.`,
      ),
    ]);
    return;
  }

  await answer([buildInlineHelpResult()]);
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
    await ctx.answerCallbackQuery();
    await sendMentionSequence(ctx, "here", store.getMembers(action.chatId));
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
