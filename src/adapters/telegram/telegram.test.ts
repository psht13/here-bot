import test from "node:test";
import assert from "node:assert/strict";
import type { Bot } from "grammy";

import type { GroupChatInput, UserInput } from "../../application/ports/chat-repository.js";
import type { Clock, IdGenerator } from "../../application/ports/system.js";
import { DraftRegistry } from "../../application/services/draft-registry.js";
import { InlineContextService } from "../../application/services/inline-context.js";
import { PingCooldownRegistry } from "../../application/services/ping-cooldown.js";
import { FakeChatRepository } from "../../application/testing/fake-chat-repository.js";
import {
  registerTelegramCommands,
  registerTelegramHandlers,
  TELEGRAM_ALLOWED_UPDATES,
} from "./telegram.js";

const groupChat: GroupChatInput = {
  id: -1001,
  type: "group",
  title: "Alpha Team",
};

const privateChat = {
  id: 501,
  type: "private" as const,
  first_name: "Alice",
};

const alice: UserInput = {
  id: 101,
  is_bot: false,
  first_name: "Alice",
  username: "alice",
};

const bob: UserInput = {
  id: 202,
  is_bot: false,
  first_name: "Bob",
  username: "bob",
};

const botUser: UserInput = {
  id: 303,
  is_bot: true,
  first_name: "Here Bot",
  username: "herebot",
};

const helpText = [
  "<b>Here Bot</b>",
  "",
  "What works on Telegram:",
  "- Use /here inside a group to mention every tracked member.",
  "- Use /tagset, /tagadd, /tagremove, /tag and /tags for smaller groups.",
  "- Use /manage for buttons to browse members and build subgroups.",
  "- Use @herebot all to ping everyone in the current group.",
  "- Use @herebot &lt;group&gt; to ping one saved subgroup.",
  "- The inline button flow uses the same query shapes: all or the subgroup name.",
  "",
  "Important Telegram limits:",
  "- Telegram does not support a literal Slack-style @here keyword for bots.",
  "- Inline queries do not include the exact target chat ID, so the bot prefers the current group context and falls back to your most recent tracked group.",
  "- Bots cannot list every member of a broadcast channel. This bot supports groups/supergroups only.",
].join("\n");

const groupOnlyText = "This command only works inside a Telegram group or supergroup.";

const missingMembersText = [
  "No members are tracked for this group yet.",
  "Make sure the bot is added to the group, inline mode is enabled in BotFather, and members have interacted with the bot or the group after the bot joined.",
  "For better coverage, disable privacy mode in BotFather and make the bot an admin if you want chat_member updates.",
].join("\n");

const homeText = [
  "<b>Alpha Team</b>",
  "Tracked members: <b>0</b>",
  "Custom groups: <b>0</b>",
  "",
  "Use the buttons below to ping everyone, browse members, and manage subgroups.",
].join("\n");

const bindText = [
  "Registered <b>Alpha Team</b>.",
  "Tracked members: <b>0</b>",
  "Custom groups: <b>0</b>",
  "",
  "Mention everyone: <code>@herebot all</code>",
  "Mention a subgroup: <code>@herebot gang</code>",
  "The inline button flow uses the same shapes: all or the subgroup name.",
].join("\n");

const emptyTagsText = [
  "<b>Alpha Team Subgroups</b>",
  "Custom groups: <b>0</b>",
  "Page 1/1",
  "",
  "No custom groups yet. Create one with the New Subgroup button.",
].join("\n");

const groupScreenText = [
  "<b>@ops</b> in <b>Alpha Team</b>",
  "Members: <b>2</b>",
  "",
  "- Alice (@alice)",
  "- Bob (@bob)",
].join("\n");

interface TelegramReplyOptions {
  parse_mode?: string;
  reply_markup?: unknown;
}

interface ReplyCall {
  text: string;
  options?: TelegramReplyOptions | undefined;
}

interface FakeMessage {
  text?: string | undefined;
  reply_to_message?: { from?: UserInput | undefined } | undefined;
  new_chat_members?: UserInput[] | undefined;
}

interface FakeInlineQuery {
  query: string;
  chat_type?: string | undefined;
}

interface FakeTelegramContext {
  chat?: GroupChatInput | typeof privateChat | undefined;
  from?: UserInput | undefined;
  message?: FakeMessage | undefined;
  match?: unknown;
  inlineQuery?: FakeInlineQuery | undefined;
  replies: ReplyCall[];
  inlineAnswers: InlineAnswerCall[];
  reply(text: string, options?: TelegramReplyOptions): Promise<void>;
  answerInlineQuery(results: TelegramInlineResult[], options: InlineAnswerOptions): Promise<void>;
}

interface InlineAnswerOptions {
  cache_time: number;
  is_personal: boolean;
}

interface TelegramInlineResult {
  type: string;
  id: string;
  title: string;
  description: string;
  input_message_content: {
    message_text: string;
    parse_mode?: string;
  };
}

interface InlineAnswerCall {
  results: TelegramInlineResult[];
  options: InlineAnswerOptions;
}

type CommandHandler = (ctx: FakeTelegramContext) => void | Promise<void>;
type MiddlewareHandler = (
  ctx: FakeTelegramContext,
  next: () => Promise<void>,
) => void | Promise<void>;
type EventHandler = (ctx: FakeTelegramContext) => void | Promise<void>;

interface BotCommandDefinition {
  command: string;
  description: string;
}

class FakeBot {
  readonly commandHandlers = new Map<string, CommandHandler>();
  readonly eventHandlers = new Map<string, EventHandler>();
  readonly middlewares: MiddlewareHandler[] = [];
  registeredCommands: BotCommandDefinition[] = [];
  catchHandler: unknown = null;

  readonly api = {
    setMyCommands: (commands: BotCommandDefinition[]): Promise<void> => {
      this.registeredCommands = commands;
      return Promise.resolve();
    },
  };

  use(handler: unknown): void {
    this.middlewares.push(handler as MiddlewareHandler);
  }

  command(command: string | string[], handler: unknown): void {
    const commands = Array.isArray(command) ? command : [command];

    for (const commandName of commands) {
      this.commandHandlers.set(commandName, handler as CommandHandler);
    }
  }

  on(eventName: string, handler: unknown): void {
    this.eventHandlers.set(eventName, handler as EventHandler);
  }

  catch(handler: unknown): void {
    this.catchHandler = handler;
  }

  async runCommand(commandName: string, ctx: FakeTelegramContext): Promise<void> {
    const handler = this.commandHandlers.get(commandName);
    assert.ok(handler, `Missing /${commandName} handler`);
    await handler(ctx);
  }

  async dispatchCommand(commandName: string, ctx: FakeTelegramContext): Promise<void> {
    await this.runMiddlewares(ctx, 0, async () => {
      await this.runCommand(commandName, ctx);
    });
  }

  async runEvent(eventName: string, ctx: FakeTelegramContext): Promise<void> {
    const handler = this.eventHandlers.get(eventName);
    assert.ok(handler, `Missing ${eventName} handler`);
    await handler(ctx);
  }

  private async runMiddlewares(
    ctx: FakeTelegramContext,
    index: number,
    done: () => Promise<void>,
  ): Promise<void> {
    const middleware = this.middlewares[index];

    if (!middleware) {
      await done();
      return;
    }

    await middleware(ctx, () => this.runMiddlewares(ctx, index + 1, done));
  }
}

function createContext(input: {
  chat?: GroupChatInput | typeof privateChat | undefined;
  from?: UserInput | undefined;
  text?: string | undefined;
  match?: string | undefined;
  replyToUser?: UserInput | undefined;
  newMembers?: UserInput[] | undefined;
  inlineQuery?: FakeInlineQuery | undefined;
}): FakeTelegramContext {
  const replies: ReplyCall[] = [];
  const inlineAnswers: InlineAnswerCall[] = [];
  const ctx: FakeTelegramContext = {
    replies,
    inlineAnswers,
    reply: (text, options) => {
      replies.push({ text, options });
      return Promise.resolve();
    },
    answerInlineQuery: (results, options) => {
      inlineAnswers.push({ results, options });
      return Promise.resolve();
    },
  };

  if (input.chat) {
    ctx.chat = input.chat;
  }

  if (input.from) {
    ctx.from = input.from;
  }

  if (input.match !== undefined) {
    ctx.match = input.match;
  }

  if (input.inlineQuery) {
    ctx.inlineQuery = input.inlineQuery;
  }

  const message: FakeMessage = {};

  if (input.text !== undefined) {
    message.text = input.text;
  }

  if (input.replyToUser) {
    message.reply_to_message = { from: input.replyToUser };
  }

  if (input.newMembers) {
    message.new_chat_members = input.newMembers;
  }

  if (
    message.text !== undefined ||
    message.reply_to_message !== undefined ||
    message.new_chat_members !== undefined
  ) {
    ctx.message = message;
  }

  return ctx;
}

function createHarness() {
  let now = 1_000_000;
  let idCounter = 0;
  const clock: Clock = {
    now: () => now,
  };
  const idGenerator: IdGenerator = {
    nextId: () => `id${++idCounter}`,
  };
  const bot = new FakeBot();
  const store = new FakeChatRepository();
  const drafts = new DraftRegistry();
  const pingCooldowns = new PingCooldownRegistry();
  const inlineContexts = new InlineContextService(clock);

  registerTelegramHandlers(bot as unknown as Bot, {
    store,
    drafts,
    pingCooldowns,
    inlineContexts,
    clock,
    idGenerator,
    botUsername: "herebot",
  });

  return {
    bot,
    store,
    drafts,
    inlineContexts,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

async function seedMembers(harness: ReturnType<typeof createHarness>): Promise<void> {
  await harness.store.ensureChat(groupChat);
  await harness.store.upsertMember(groupChat, alice);
  await harness.store.upsertMember(groupChat, bob);
}

function firstReply(ctx: FakeTelegramContext): ReplyCall {
  const reply = ctx.replies[0];
  assert.ok(reply, "Expected a reply");
  return reply;
}

function assertHtmlReply(reply: ReplyCall, text: string): void {
  assert.equal(reply.text, text);
  assert.equal(reply.options?.parse_mode, "HTML");
  assert.ok(reply.options.reply_markup);
}

test("registerTelegramCommands configures the current bot command menu", async () => {
  const bot = new FakeBot();

  await registerTelegramCommands(bot as unknown as Bot);

  assert.deepEqual(bot.registeredCommands, [
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
  assert.deepEqual(TELEGRAM_ALLOWED_UPDATES, [
    "message",
    "chat_member",
    "my_chat_member",
    "inline_query",
    "callback_query",
  ]);
});

test("/start and /help return the exact setup help in any chat", async () => {
  const harness = createHarness();

  for (const commandName of ["start", "help"]) {
    const ctx = createContext({
      chat: privateChat,
      from: alice,
      text: `/${commandName}`,
    });

    await harness.bot.runCommand(commandName, ctx);

    assert.equal(firstReply(ctx).text, helpText);
    assert.equal(firstReply(ctx).options?.parse_mode, "HTML");
  }
});

test("group-only commands reject private chats with the exact text", async () => {
  const harness = createHarness();
  const commandNames = [
    "bind",
    "status",
    "manage",
    "here",
    "tags",
    "tag",
    "tagset",
    "tagadd",
    "tagremove",
    "tagdelete",
    "tagname",
  ];

  for (const commandName of commandNames) {
    const ctx = createContext({
      chat: privateChat,
      from: alice,
      text: `/${commandName}`,
      match: "",
    });

    await harness.bot.runCommand(commandName, ctx);

    assert.deepEqual(
      ctx.replies.map((reply) => reply.text),
      [groupOnlyText],
      `/${commandName}`,
    );
    assert.equal(firstReply(ctx).options, undefined);
  }
});

test("/bind, /status, and /manage render exact manager text", async () => {
  const harness = createHarness();

  const bind = createContext({
    chat: groupChat,
    from: alice,
    text: "/bind",
  });
  await harness.bot.runCommand("bind", bind);
  assertHtmlReply(firstReply(bind), bindText);

  const status = createContext({
    chat: groupChat,
    from: alice,
    text: "/status",
  });
  await harness.bot.runCommand("status", status);
  assertHtmlReply(firstReply(status), homeText);

  const manage = createContext({
    chat: groupChat,
    from: alice,
    text: "/manage",
  });
  await harness.bot.runCommand("manage", manage);
  assertHtmlReply(firstReply(manage), homeText);
});

test("/here covers empty members, cooldown miss, and cooldown hit", async () => {
  const emptyHarness = createHarness();
  const empty = createContext({
    chat: groupChat,
    from: alice,
    text: "/here",
  });
  await emptyHarness.bot.runCommand("here", empty);
  assert.equal(firstReply(empty).text, missingMembersText);
  assert.equal(firstReply(empty).options, undefined);

  const harness = createHarness();
  await seedMembers(harness);

  const first = createContext({
    chat: groupChat,
    from: alice,
    text: "/here",
  });
  await harness.bot.runCommand("here", first);
  assert.equal(
    firstReply(first).text,
    '@here <a href="tg://user?id=101">Alice</a> <a href="tg://user?id=202">Bob</a>',
  );
  assert.equal(firstReply(first).options?.parse_mode, "HTML");

  const second = createContext({
    chat: groupChat,
    from: alice,
    text: "/here",
  });
  await harness.bot.runCommand("here", second);
  assert.equal(firstReply(second).text, "Wait 1 minute before sending the same ping again.");

  harness.advance(60_001);
  const afterCooldown = createContext({
    chat: groupChat,
    from: alice,
    text: "/here",
  });
  await harness.bot.runCommand("here", afterCooldown);
  assert.equal(
    firstReply(afterCooldown).text,
    '@here <a href="tg://user?id=101">Alice</a> <a href="tg://user?id=202">Bob</a>',
  );
});

test("/tags and /tag cover empty, unknown subgroup, success, and cooldown", async () => {
  const harness = createHarness();

  const emptyTags = createContext({
    chat: groupChat,
    from: alice,
    text: "/tags",
  });
  await harness.bot.runCommand("tags", emptyTags);
  assertHtmlReply(firstReply(emptyTags), emptyTagsText);

  await seedMembers(harness);
  await harness.store.upsertGroup(groupChat.id, "ops", [bob.id]);

  const tags = createContext({
    chat: groupChat,
    from: alice,
    text: "/tags",
  });
  await harness.bot.runCommand("tags", tags);
  assertHtmlReply(
    firstReply(tags),
    [
      "<b>Alpha Team Subgroups</b>",
      "Custom groups: <b>1</b>",
      "Page 1/1",
      "",
      "- @ops (1 members)",
    ].join("\n"),
  );

  const usage = createContext({
    chat: groupChat,
    from: alice,
    text: "/tag",
    match: "",
  });
  await harness.bot.runCommand("tag", usage);
  assert.equal(firstReply(usage).text, "Usage: /tag <group-name>");

  const unknown = createContext({
    chat: groupChat,
    from: alice,
    text: "/tag missing",
    match: "missing",
  });
  await harness.bot.runCommand("tag", unknown);
  assert.equal(
    firstReply(unknown).text,
    "That group is empty or does not exist. Create it with /tagset first.",
  );

  const success = createContext({
    chat: groupChat,
    from: alice,
    text: "/tag ops",
    match: "ops",
  });
  await harness.bot.runCommand("tag", success);
  assert.equal(success.replies[0]?.text, '@ops <a href="tg://user?id=202">Bob</a>');
  assert.equal(success.replies[0]?.options?.parse_mode, "HTML");

  const cooldown = createContext({
    chat: groupChat,
    from: alice,
    text: "/tag ops",
    match: "ops",
  });
  await harness.bot.runCommand("tag", cooldown);
  assert.equal(firstReply(cooldown).text, "Wait 1 minute before sending the same ping again.");
});

test("/tagset selects reply users and me, and reports unresolved members exactly", async () => {
  const harness = createHarness();

  const usage = createContext({
    chat: groupChat,
    from: alice,
    text: "/tagset",
    match: "",
  });
  await harness.bot.runCommand("tagset", usage);
  assert.equal(
    firstReply(usage).text,
    [
      "Usage: /tagset <group-name> <@username|user-id|me...>",
      "You can also reply to a user with /tagset <group-name>.",
    ].join("\n"),
  );

  await seedMembers(harness);

  const unresolved = createContext({
    chat: groupChat,
    from: alice,
    text: "/tagset ops @missing",
    match: "ops @missing",
  });
  await harness.bot.runCommand("tagset", unresolved);
  assert.equal(
    firstReply(unresolved).text,
    "I could not resolve: @missing.\nOnly tracked users in this group can be added.",
  );

  const replySelection = createContext({
    chat: groupChat,
    from: alice,
    text: "/tagset replyteam",
    match: "replyteam",
    replyToUser: bob,
  });
  await harness.bot.runCommand("tagset", replySelection);
  assert.equal(firstReply(replySelection).text, "Saved @replyteam with 1 member.");

  const meSelection = createContext({
    chat: groupChat,
    from: alice,
    text: "/tagset ops me @bob",
    match: "ops me @bob",
  });
  await harness.bot.runCommand("tagset", meSelection);
  assert.equal(firstReply(meSelection).text, "Saved @ops with 2 members.");
});

test("/tagadd, /tagremove, and /tagdelete report exact command outcomes", async () => {
  const harness = createHarness();
  await seedMembers(harness);
  await harness.store.upsertGroup(groupChat.id, "ops", [alice.id]);

  const tagAddUsage = createContext({
    chat: groupChat,
    from: alice,
    text: "/tagadd",
    match: "",
  });
  await harness.bot.runCommand("tagadd", tagAddUsage);
  assert.equal(
    firstReply(tagAddUsage).text,
    [
      "Usage: /tagadd <group-name> <@username|user-id|me...>",
      "You can also reply to a user with /tagadd <group-name>.",
    ].join("\n"),
  );

  const tagAddUnresolved = createContext({
    chat: groupChat,
    from: alice,
    text: "/tagadd ops @missing",
    match: "ops @missing",
  });
  await harness.bot.runCommand("tagadd", tagAddUnresolved);
  assert.equal(firstReply(tagAddUnresolved).text, "I could not resolve: @missing.");

  const tagAddEmpty = createContext({
    chat: groupChat,
    from: alice,
    text: "/tagadd ops",
    match: "ops",
  });
  await harness.bot.runCommand("tagadd", tagAddEmpty);
  assert.equal(firstReply(tagAddEmpty).text, "No users selected.");

  const tagAddReply = createContext({
    chat: groupChat,
    from: alice,
    text: "/tagadd ops",
    match: "ops",
    replyToUser: bob,
  });
  await harness.bot.runCommand("tagadd", tagAddReply);
  assert.equal(firstReply(tagAddReply).text, "Updated @ops. It now has 2 members.");

  const tagRemoveUsage = createContext({
    chat: groupChat,
    from: alice,
    text: "/tagremove",
    match: "",
  });
  await harness.bot.runCommand("tagremove", tagRemoveUsage);
  assert.equal(
    firstReply(tagRemoveUsage).text,
    [
      "Usage: /tagremove <group-name> <@username|user-id|me...>",
      "You can also reply to a user with /tagremove <group-name>.",
    ].join("\n"),
  );

  const tagRemoveMissing = createContext({
    chat: groupChat,
    from: alice,
    text: "/tagremove missing @alice",
    match: "missing @alice",
  });
  await harness.bot.runCommand("tagremove", tagRemoveMissing);
  assert.equal(firstReply(tagRemoveMissing).text, "That group does not exist.");

  const tagRemoveMe = createContext({
    chat: groupChat,
    from: alice,
    text: "/tagremove ops me",
    match: "ops me",
  });
  await harness.bot.runCommand("tagremove", tagRemoveMe);
  assert.equal(firstReply(tagRemoveMe).text, "Updated @ops. It now has 1 member.");

  const tagDeleteUsage = createContext({
    chat: groupChat,
    from: alice,
    text: "/tagdelete",
    match: "",
  });
  await harness.bot.runCommand("tagdelete", tagDeleteUsage);
  assert.equal(firstReply(tagDeleteUsage).text, "Usage: /tagdelete <group-name>");

  const tagDeleteMissing = createContext({
    chat: groupChat,
    from: alice,
    text: "/tagdelete missing",
    match: "missing",
  });
  await harness.bot.runCommand("tagdelete", tagDeleteMissing);
  assert.equal(firstReply(tagDeleteMissing).text, "That group does not exist.");

  const tagDelete = createContext({
    chat: groupChat,
    from: alice,
    text: "/tagdelete ops",
    match: "ops",
  });
  await harness.bot.runCommand("tagdelete", tagDelete);
  assert.equal(firstReply(tagDelete).text, "Deleted @ops.");
});

test("/tagname covers draft save failure, human guard, and success", async () => {
  const harness = createHarness();

  const noHuman = createContext({
    chat: groupChat,
    from: botUser,
    text: "/tagname ops",
    match: "ops",
  });
  await harness.bot.runCommand("tagname", noHuman);
  assert.equal(firstReply(noHuman).text, "Only human users can save subgroup drafts.");

  const noDraft = createContext({
    chat: groupChat,
    from: alice,
    text: "/tagname ops",
    match: "ops",
  });
  await harness.bot.runCommand("tagname", noDraft);
  assert.equal(firstReply(noDraft).text, "No active subgroup draft. Start one with /manage.");

  await seedMembers(harness);
  harness.drafts.create(groupChat.id, alice.id, [alice.id, bob.id]);

  const saved = createContext({
    chat: groupChat,
    from: alice,
    text: "/tagname @Ops",
    match: "@Ops",
  });
  await harness.bot.runCommand("tagname", saved);
  assertHtmlReply(firstReply(saved), groupScreenText);
});

test("message middleware tracks members and stops after draft-name save", async () => {
  const harness = createHarness();
  await seedMembers(harness);
  harness.drafts.create(groupChat.id, alice.id, [alice.id, bob.id]);
  harness.drafts.promptForName(groupChat.id, alice.id);

  const ctx = createContext({
    chat: groupChat,
    from: alice,
    text: "Ops",
  });

  await harness.bot.dispatchCommand("help", ctx);

  assert.equal(ctx.replies.length, 1);
  assertHtmlReply(firstReply(ctx), groupScreenText);
  assert.equal(harness.drafts.get(groupChat.id, alice.id), null);
});

test("inline query answers are mapped without calling Telegram", async () => {
  const harness = createHarness();

  const ctx = createContext({
    from: alice,
    inlineQuery: {
      query: "",
      chat_type: "group",
    },
  });

  await harness.bot.runEvent("inline_query", ctx);

  assert.deepEqual(ctx.inlineAnswers[0]?.options, {
    cache_time: 0,
    is_personal: true,
  });
  assert.equal(ctx.inlineAnswers[0]?.results[0]?.title, "Use all or a subgroup");
  assert.equal(ctx.inlineAnswers[0]?.results[0]?.input_message_content.message_text, helpText);
  assert.equal(ctx.inlineAnswers[0]?.results[0]?.input_message_content.parse_mode, "HTML");
});
