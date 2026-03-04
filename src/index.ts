import "dotenv/config";

import { Bot, GrammyError, HttpError, type Context } from "grammy";
import { z } from "zod";

import {
  buildMentionChunks,
  normalizeKey,
  resolveMemberRefs,
} from "./domain.js";
import type { KnownMember } from "./models.js";
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
const bot = new Bot(env.BOT_TOKEN);
const HELP_TEXT = [
  "<b>Here Bot</b>",
  "",
  "What works on Telegram:",
  "- Use /here inside a group to mention every tracked member.",
  "- Use /tagset, /tagadd, /tagremove, /tag and /tags for smaller groups.",
  `- Use inline mode as @${env.BOT_USERNAME} all &lt;workspace-key&gt; or @${env.BOT_USERNAME} tag &lt;workspace-key&gt; &lt;group&gt;.`,
  "",
  "Important Telegram limits:",
  "- Telegram does not support a literal Slack-style @here trigger for bots.",
  "- Inline queries do not include the target chat ID, so inline mode needs a workspace key.",
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

async function registerCommands(): Promise<void> {
  await bot.api.setMyCommands([
    { command: "start", description: "Show setup help" },
    { command: "bind", description: "Register this group and show its workspace key" },
    { command: "status", description: "Show tracked members and groups" },
    { command: "here", description: "Mention every tracked member in this group" },
    { command: "tagset", description: "Create or replace a custom group" },
    { command: "tagadd", description: "Add members to a custom group" },
    { command: "tagremove", description: "Remove members from a custom group" },
    { command: "tag", description: "Mention a custom group" },
    { command: "tags", description: "List custom groups" },
    { command: "tagdelete", description: "Delete a custom group" },
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
      `Inline usage: <code>@${env.BOT_USERNAME} all ${registered.workspaceKey}</code>`,
      `Inline custom group: <code>@${env.BOT_USERNAME} tag ${registered.workspaceKey} gang</code>`,
    ].join("\n"),
    { parse_mode: "HTML" },
  );
});

bot.command("status", async (ctx) => {
  const chat = await requireGroup(ctx);

  if (!chat) {
    return;
  }

  const registered = await store.ensureChat(chat);
  const groups = store.listGroups(chat.id);

  const lines = [
    `<b>${registered.title}</b>`,
    `Workspace key: <code>${registered.workspaceKey}</code>`,
    `Tracked members: <b>${store.getMembers(chat.id).length}</b>`,
    `Custom groups: <b>${groups.length}</b>`,
  ];

  if (groups.length > 0) {
    lines.push("");
    lines.push(
      ...groups.map((group) => `- @${group.key} (${group.memberIds.length} members)`),
    );
  }

  await ctx.reply(lines.join("\n"), {
    parse_mode: "HTML",
  });
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

  if (groups.length === 0) {
    await ctx.reply(
      "No custom groups yet. Example: /tagset gang me @alice @bob",
    );
    return;
  }

  await ctx.reply(
    groups
      .map((group) => `@${group.key} -> ${group.memberIds.length} members`)
      .join("\n"),
  );
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

bot.on("message", async (ctx) => {
  if (!isSupportedGroupChat(ctx.chat)) {
    return;
  }

  await store.ensureChat(ctx.chat);

  if (ctx.from && !ctx.from.is_bot) {
    await store.upsertMember(ctx.chat, ctx.from);
  }

  const replyAuthor = ctx.msg?.reply_to_message?.from;

  if (replyAuthor && !replyAuthor.is_bot) {
    await store.upsertMember(ctx.chat, replyAuthor);
  }

  const newMembers = ctx.msg?.new_chat_members ?? [];

  for (const member of newMembers) {
    await store.upsertMember(ctx.chat, member);
  }
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

  if (!query) {
    await ctx.answerInlineQuery([buildInlineHelpResult()], {
      cache_time: 0,
      is_personal: true,
    });
    return;
  }

  const [rawAction = "", workspaceKey, tagKey] = query.split(/\s+/);
  const normalizedAction = rawAction.toLowerCase();

  if (!workspaceKey) {
    await ctx.answerInlineQuery([buildInlineHelpResult()], {
      cache_time: 0,
      is_personal: true,
    });
    return;
  }

  const chat = store.getChatByWorkspaceKey(workspaceKey);

  if (!chat) {
    await ctx.answerInlineQuery(
      [
        buildInlineResult(
          "Unknown workspace",
          `No group registered as ${workspaceKey}`,
          `I could not find the workspace key "${workspaceKey}". Run /bind in the target group first.`,
        ),
      ],
      { cache_time: 0, is_personal: true },
    );
    return;
  }

  if (normalizedAction === "all" || normalizedAction === "here") {
    const members = store.getMembers(chat.id);

    if (members.length === 0) {
      await ctx.answerInlineQuery(
        [
          buildInlineResult(
            "No tracked members",
            "The target group has no tracked users yet",
            buildMissingMembersHint(),
          ),
        ],
        { cache_time: 0, is_personal: true },
      );
      return;
    }

    const chunks = buildMentionChunks("here", members);
    const firstChunk = chunks[0];

    if (!firstChunk) {
      await ctx.answerInlineQuery([buildInlineHelpResult()], {
        cache_time: 0,
        is_personal: true,
      });
      return;
    }

    if (chunks.length > 1) {
      await ctx.answerInlineQuery(
        [
          buildInlineResult(
            "Too many members for inline mode",
            "Use /here in the group for large teams",
            "This mention set is too large for a single inline message. Use /here inside the target group instead.",
          ),
        ],
        { cache_time: 0, is_personal: true },
      );
      return;
    }

    await ctx.answerInlineQuery(
      [
        buildInlineResult(
          `Ping everyone in ${chat.title}`,
          `${members.length} tracked members`,
          firstChunk,
        ),
      ],
      { cache_time: 0, is_personal: true },
    );
    return;
  }

  if (normalizedAction === "tag" || normalizedAction === "group") {
    const normalizedTag = tagKey ? normalizeKey(tagKey) : null;

    if (!normalizedTag) {
      await ctx.answerInlineQuery([buildInlineHelpResult()], {
        cache_time: 0,
        is_personal: true,
      });
      return;
    }

    const members = store.getGroupMembers(chat.id, normalizedTag);

    if (members.length === 0) {
      await ctx.answerInlineQuery(
        [
          buildInlineResult(
            "Unknown or empty group",
            `No members stored for @${normalizedTag}`,
            `I could not find a non-empty custom group named @${normalizedTag} in ${chat.title}.`,
          ),
        ],
        { cache_time: 0, is_personal: true },
      );
      return;
    }

    const chunks = buildMentionChunks(normalizedTag, members);
    const firstChunk = chunks[0];

    if (!firstChunk) {
      await ctx.answerInlineQuery([buildInlineHelpResult()], {
        cache_time: 0,
        is_personal: true,
      });
      return;
    }

    if (chunks.length > 1) {
      await ctx.answerInlineQuery(
        [
          buildInlineResult(
            "Too many members for inline mode",
            "Use /tag inside the group for large custom groups",
            `@${normalizedTag} is too large for a single inline message. Use /tag ${normalizedTag} inside the group instead.`,
          ),
        ],
        { cache_time: 0, is_personal: true },
      );
      return;
    }

    await ctx.answerInlineQuery(
      [
        buildInlineResult(
          `Ping @${normalizedTag} in ${chat.title}`,
          `${members.length} tracked members`,
          firstChunk,
        ),
      ],
      { cache_time: 0, is_personal: true },
    );
    return;
  }

  await ctx.answerInlineQuery([buildInlineHelpResult()], {
    cache_time: 0,
    is_personal: true,
  });
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
    ],
    onStart: (botInfo) => {
      console.log(`Running @${botInfo.username} with data file ${env.DATA_FILE}`);
    },
  });
}

void start();
