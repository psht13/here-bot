import { GrammyError, HttpError, type Bot, type Context } from "grammy";

import type { ChatRepository } from "../../application/ports/chat-repository.js";
import type { Clock, IdGenerator } from "../../application/ports/system.js";
import type { DraftRegistry } from "../../application/services/draft-registry.js";
import type { InlineContextService } from "../../application/services/inline-context.js";
import type { PingCooldownRegistry } from "../../application/services/ping-cooldown.js";
import {
  HereBotUseCases,
  type CallbackAnswerModel,
  type CommandResult,
  type InlineArticleResultModel,
  type OutgoingMessage,
} from "../../application/use-cases/here-bot.js";
import { routeManagerCallback } from "./callbacks/manager-callback-router.js";
import { telegramPresentation } from "./presenters/here-bot.js";
import { toTelegramInlineKeyboard } from "./presenters/manager-screens.js";

export interface TelegramHandlerDeps {
  store: ChatRepository;
  drafts: DraftRegistry;
  pingCooldowns: PingCooldownRegistry;
  inlineContexts: InlineContextService;
  clock: Clock;
  idGenerator: IdGenerator;
  botUsername: string;
}

export const TELEGRAM_ALLOWED_UPDATES = [
  "message",
  "chat_member",
  "my_chat_member",
  "inline_query",
  "callback_query",
] as const;

type SupportedGroupChat = Extract<NonNullable<Context["chat"]>, { type: "group" | "supergroup" }>;

function isSupportedGroupChat(chat: Context["chat"]): chat is SupportedGroupChat {
  return Boolean(chat && (chat.type === "group" || chat.type === "supergroup"));
}

function getMatchText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function getHumanUserId(ctx: Context): number | undefined {
  if (!ctx.from || ctx.from.is_bot) {
    return undefined;
  }

  return ctx.from.id;
}

async function requireGroup(ctx: Context): Promise<SupportedGroupChat | null> {
  if (!isSupportedGroupChat(ctx.chat)) {
    await ctx.reply("This command only works inside a Telegram group or supergroup.");
    return null;
  }

  return ctx.chat;
}

async function replyOutgoingMessage(ctx: Context, output: OutgoingMessage): Promise<void> {
  if (output.keyboard && output.parseMode) {
    await ctx.reply(output.text, {
      parse_mode: output.parseMode,
      reply_markup: toTelegramInlineKeyboard(output.keyboard),
    });
    return;
  }

  if (output.keyboard) {
    await ctx.reply(output.text, {
      reply_markup: toTelegramInlineKeyboard(output.keyboard),
    });
    return;
  }

  if (output.parseMode) {
    await ctx.reply(output.text, {
      parse_mode: output.parseMode,
    });
    return;
  }

  await ctx.reply(output.text);
}

async function replyCommandResult(ctx: Context, result: CommandResult): Promise<void> {
  for (const output of result.messages) {
    await replyOutgoingMessage(ctx, output);
  }
}

async function editOutgoingMessage(ctx: Context, output: OutgoingMessage): Promise<void> {
  async function edit(): Promise<void> {
    if (output.keyboard && output.parseMode) {
      await ctx.editMessageText(output.text, {
        parse_mode: output.parseMode,
        reply_markup: toTelegramInlineKeyboard(output.keyboard),
      });
      return;
    }

    if (output.keyboard) {
      await ctx.editMessageText(output.text, {
        reply_markup: toTelegramInlineKeyboard(output.keyboard),
      });
      return;
    }

    if (output.parseMode) {
      await ctx.editMessageText(output.text, {
        parse_mode: output.parseMode,
      });
      return;
    }

    await ctx.editMessageText(output.text);
  }

  try {
    await edit();
  } catch (error) {
    if (error instanceof GrammyError && error.description.includes("message is not modified")) {
      return;
    }

    if (
      error instanceof GrammyError &&
      (error.description.includes("message can't be edited") ||
        error.description.includes("message to edit not found"))
    ) {
      await replyOutgoingMessage(ctx, output);
      return;
    }

    throw error;
  }
}

async function answerCallback(ctx: Context, answer: CallbackAnswerModel): Promise<void> {
  if (answer.text !== undefined && answer.showAlert !== undefined) {
    await ctx.answerCallbackQuery({
      text: answer.text,
      show_alert: answer.showAlert,
    });
    return;
  }

  if (answer.text !== undefined) {
    await ctx.answerCallbackQuery({
      text: answer.text,
    });
    return;
  }

  if (answer.showAlert !== undefined) {
    await ctx.answerCallbackQuery({
      show_alert: answer.showAlert,
    });
    return;
  }

  await ctx.answerCallbackQuery();
}

function toTelegramInlineResult(result: InlineArticleResultModel) {
  if (result.inputMessageContent.parseMode) {
    return {
      type: result.type,
      id: result.id,
      title: result.title,
      description: result.description,
      input_message_content: {
        message_text: result.inputMessageContent.messageText,
        parse_mode: result.inputMessageContent.parseMode,
      },
    };
  }

  return {
    type: result.type,
    id: result.id,
    title: result.title,
    description: result.description,
    input_message_content: {
      message_text: result.inputMessageContent.messageText,
    },
  };
}

export async function registerTelegramCommands(bot: Bot): Promise<void> {
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

export function registerTelegramHandlers(bot: Bot, deps: TelegramHandlerDeps): void {
  const useCases = new HereBotUseCases({
    ...deps,
    presentation: telegramPresentation,
  });

  bot.use(async (ctx, next) => {
    const message = ctx.message;

    if (isSupportedGroupChat(ctx.chat) && message) {
      const result = await useCases.trackMessageMembers({
        chat: ctx.chat,
        sender: ctx.from,
        replyToUser: message.reply_to_message?.from,
        newMembers: message.new_chat_members ?? [],
        messageText: typeof message.text === "string" ? message.text : undefined,
      });

      await replyCommandResult(ctx, result);

      if (result.stopPropagation) {
        return;
      }
    }

    await next();
  });

  bot.command("start", async (ctx) => {
    await replyOutgoingMessage(ctx, useCases.getHelpMessage());
  });

  bot.command("help", async (ctx) => {
    await replyOutgoingMessage(ctx, useCases.getHelpMessage());
  });

  bot.command("bind", async (ctx) => {
    const chat = await requireGroup(ctx);

    if (!chat) {
      return;
    }

    await replyCommandResult(ctx, await useCases.bindChat(chat));
  });

  bot.command("status", async (ctx) => {
    const chat = await requireGroup(ctx);

    if (!chat) {
      return;
    }

    await replyCommandResult(ctx, await useCases.getHomeDashboard(chat));
  });

  bot.command("manage", async (ctx) => {
    const chat = await requireGroup(ctx);

    if (!chat) {
      return;
    }

    await replyCommandResult(ctx, await useCases.getHomeDashboard(chat));
  });

  bot.command("here", async (ctx) => {
    const chat = await requireGroup(ctx);

    if (!chat) {
      return;
    }

    await replyCommandResult(
      ctx,
      await useCases.pingAll({
        chat,
        chatId: chat.id,
        requesterId: getHumanUserId(ctx),
      }),
    );
  });

  bot.command("tags", async (ctx) => {
    const chat = await requireGroup(ctx);

    if (!chat) {
      return;
    }

    await replyCommandResult(ctx, await useCases.listTags(chat));
  });

  bot.command("tag", async (ctx) => {
    const chat = await requireGroup(ctx);

    if (!chat) {
      return;
    }

    await replyCommandResult(
      ctx,
      await useCases.pingTag({
        chat,
        matchText: getMatchText(ctx.match),
        requesterId: getHumanUserId(ctx),
      }),
    );
  });

  bot.command("tagset", async (ctx) => {
    const chat = await requireGroup(ctx);

    if (!chat) {
      return;
    }

    await replyCommandResult(
      ctx,
      await useCases.tagSet({
        chat,
        matchText: getMatchText(ctx.match),
        requesterId: getHumanUserId(ctx),
        replyToUserId: ctx.message?.reply_to_message?.from?.id,
      }),
    );
  });

  bot.command("tagadd", async (ctx) => {
    const chat = await requireGroup(ctx);

    if (!chat) {
      return;
    }

    await replyCommandResult(
      ctx,
      await useCases.tagAdd({
        chat,
        matchText: getMatchText(ctx.match),
        requesterId: getHumanUserId(ctx),
        replyToUserId: ctx.message?.reply_to_message?.from?.id,
      }),
    );
  });

  bot.command("tagremove", async (ctx) => {
    const chat = await requireGroup(ctx);

    if (!chat) {
      return;
    }

    await replyCommandResult(
      ctx,
      await useCases.tagRemove({
        chat,
        matchText: getMatchText(ctx.match),
        requesterId: getHumanUserId(ctx),
        replyToUserId: ctx.message?.reply_to_message?.from?.id,
      }),
    );
  });

  bot.command("tagdelete", async (ctx) => {
    const chat = await requireGroup(ctx);

    if (!chat) {
      return;
    }

    await replyCommandResult(
      ctx,
      await useCases.tagDelete({
        chat,
        matchText: getMatchText(ctx.match),
        requesterId: getHumanUserId(ctx),
      }),
    );
  });

  bot.command("tagname", async (ctx) => {
    const chat = await requireGroup(ctx);

    if (!chat) {
      return;
    }

    const ownerId = getHumanUserId(ctx);

    if (ownerId === undefined) {
      await ctx.reply("Only human users can save subgroup drafts.");
      return;
    }

    await replyCommandResult(
      ctx,
      await useCases.saveDraftAsGroupCommand({
        chat,
        ownerId,
        matchText: getMatchText(ctx.match),
      }),
    );
  });

  bot.on("message:text", async (ctx) => {
    if (!isSupportedGroupChat(ctx.chat) || !ctx.from || ctx.from.is_bot) {
      return;
    }

    const messageText = ctx.message.text.trim();
    const [firstToken = ""] = messageText.split(/\s+/, 1);
    const botMention = `@${deps.botUsername.toLowerCase()}`;

    if (firstToken.toLowerCase() !== botMention) {
      return;
    }

    await replyCommandResult(
      ctx,
      useCases.pingMentionText({
        chatId: ctx.chat.id,
        messageText,
        requesterId: getHumanUserId(ctx),
      }),
    );
  });

  bot.on("chat_member", async (ctx) => {
    const chat = ctx.chatMember?.chat;

    if (!isSupportedGroupChat(chat)) {
      return;
    }

    await deps.store.ensureChat(chat);

    const status = ctx.chatMember.new_chat_member.status;
    const user = ctx.chatMember.new_chat_member.user;

    if (status === "left" || status === "kicked") {
      await deps.store.removeMember(chat.id, user.id);
      return;
    }

    await deps.store.upsertMember(chat, user);
  });

  bot.on("my_chat_member", async (ctx) => {
    if (!isSupportedGroupChat(ctx.chat)) {
      return;
    }

    await deps.store.ensureChat(ctx.chat);
  });

  bot.on("inline_query", async (ctx) => {
    const result = useCases.resolveInlinePing({
      query: ctx.inlineQuery.query,
      userId: ctx.from.id,
      chatType: ctx.inlineQuery.chat_type,
    });

    await ctx.answerInlineQuery(result.results.map(toTelegramInlineResult), {
      cache_time: result.cacheTime,
      is_personal: result.isPersonal,
    });
  });

  bot.on("callback_query:data", async (ctx) => {
    await routeManagerCallback(
      {
        data: ctx.callbackQuery.data,
        currentChat: isSupportedGroupChat(ctx.chat) ? ctx.chat : undefined,
        actorId: getHumanUserId(ctx),
      },
      useCases,
      {
        answerCallback: (answer) => answerCallback(ctx, answer),
        editMessage: (output) => editOutgoingMessage(ctx, output),
        sendMessages: (messages) => replyCommandResult(ctx, { messages }),
      },
    );
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
}
