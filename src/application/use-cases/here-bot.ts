import {
  normalizeKey,
  parseMentionPingRequest,
  parsePingRequest,
  resolveMemberRefs,
  type PingRequest,
} from "../../domain/index.js";
import type { KnownChat, KnownMember, MentionGroup } from "../../domain/models.js";
import type { ManagerAction } from "../callbacks/manager-callbacks.js";
import { handleManagerCallbackAction } from "../callbacks/manager-callback-router.js";
import type { DraftState } from "../services/draft-registry.js";
import type { KeyboardModel, ManagerScreen } from "../presenters/manager-screens.js";
import type { ChatRepository, GroupChatInput, UserInput } from "../ports/chat-repository.js";
import type { Clock, IdGenerator } from "../ports/system.js";
import type { DraftRegistry } from "../services/draft-registry.js";
import { formatPingCooldownMessage, type PingCooldownRegistry } from "../services/ping-cooldown.js";
import type { InlineContextService } from "../services/inline-context.js";

export type ParseMode = "HTML";

const SUPPORTED_GROUP_CHAT_TYPES = new Set(["group", "supergroup"]);

export interface OutgoingMessage {
  text: string;
  parseMode?: ParseMode;
  keyboard?: KeyboardModel;
}

export interface CommandResult {
  messages: OutgoingMessage[];
  stopPropagation?: boolean;
}

export interface CallbackAnswerModel {
  text?: string;
  showAlert?: boolean;
}

export interface ManagerActionResult {
  answer?: CallbackAnswerModel;
  editMessage?: OutgoingMessage;
  messages: OutgoingMessage[];
}

export interface InlineMessageContentModel {
  messageText: string;
  parseMode?: ParseMode;
}

export interface InlineArticleResultModel {
  type: "article";
  id: string;
  title: string;
  description: string;
  inputMessageContent: InlineMessageContentModel;
}

export interface InlinePingResult {
  results: InlineArticleResultModel[];
  cacheTime: 0;
  isPersonal: true;
}

export interface HereBotPresentation {
  buildHomeScreen(chat: KnownChat, memberCount: number, groupCount: number): ManagerScreen;
  buildMembersScreen(chat: KnownChat, members: KnownMember[], page: number): ManagerScreen;
  buildGroupsScreen(chat: KnownChat, groups: MentionGroup[], page: number): ManagerScreen;
  buildGroupScreen(
    chat: KnownChat,
    group: MentionGroup,
    members: KnownMember[],
    originPage: number,
  ): ManagerScreen;
  buildDraftScreen(chat: KnownChat, draft: DraftState, allMembers: KnownMember[]): ManagerScreen;
  buildMentionChunks(label: string, members: KnownMember[]): string[];
}

export interface HereBotUseCaseDeps {
  store: ChatRepository;
  drafts: DraftRegistry;
  pingCooldowns: PingCooldownRegistry;
  inlineContexts: InlineContextService;
  clock: Clock;
  idGenerator: IdGenerator;
  botUsername: string;
  presentation: HereBotPresentation;
}

export interface TrackMessageMembersInput {
  chat: GroupChatInput;
  sender?: UserInput | undefined;
  replyToUser?: UserInput | undefined;
  newMembers: UserInput[];
  messageText?: string | undefined;
}

export interface PingInput {
  chat?: GroupChatInput | undefined;
  chatId: number;
  requesterId?: number | undefined;
}

export interface TagCommandInput {
  chat: GroupChatInput;
  matchText: string;
  requesterId?: number | undefined;
  replyToUserId?: number | undefined;
}

export interface SaveDraftAsGroupInput {
  chat?: GroupChatInput | undefined;
  chatId: number;
  ownerId: number;
  rawGroupName?: string | undefined;
}

export interface ResolveInlinePingInput {
  query: string;
  userId: number;
  chatType?: string | undefined;
}

export interface ManageDraftActionInput {
  action: ManagerAction;
  currentChat?: GroupChatInput | undefined;
  actorId?: number | undefined;
}

function message(text: string, parseMode?: ParseMode, keyboard?: KeyboardModel): OutgoingMessage {
  const result: OutgoingMessage = { text };

  if (parseMode) {
    result.parseMode = parseMode;
  }

  if (keyboard) {
    result.keyboard = keyboard;
  }

  return result;
}

function screenMessage(screen: { text: string; keyboard: KeyboardModel }): OutgoingMessage {
  return message(screen.text, "HTML", screen.keyboard);
}

function commandResult(messages: OutgoingMessage[], stopPropagation = false): CommandResult {
  const result: CommandResult = { messages };

  if (stopPropagation) {
    result.stopPropagation = true;
  }

  return result;
}

function inlineContent(messageText: string, parseMode?: ParseMode): InlineMessageContentModel {
  const content: InlineMessageContentModel = { messageText };

  if (parseMode) {
    content.parseMode = parseMode;
  }

  return content;
}

function parseArgs(input: string | undefined): string[] {
  return (input ?? "").trim().split(/\s+/).filter(Boolean);
}

function isHumanUser(user: UserInput | undefined): user is UserInput {
  return Boolean(user && !user.is_bot);
}

export function buildHelpText(username: string): string {
  return [
    "<b>Here Bot</b>",
    "",
    "What works on Telegram:",
    "- Use /here inside a group to mention every tracked member.",
    "- Use /tagset, /tagadd, /tagremove, /tag and /tags for smaller groups.",
    "- Use /manage for buttons to browse members and build subgroups.",
    `- Use @${username} all to ping everyone in the current group.`,
    `- Use @${username} &lt;group&gt; to ping one saved subgroup.`,
    "- The inline button flow uses the same query shapes: all or the subgroup name.",
    "",
    "Important Telegram limits:",
    "- Telegram does not support a literal Slack-style @here keyword for bots.",
    "- Inline queries do not include the exact target chat ID, so the bot prefers the current group context and falls back to your most recent tracked group.",
    "- Bots cannot list every member of a broadcast channel. This bot supports groups/supergroups only.",
  ].join("\n");
}

export function buildMissingMembersHint(): string {
  return [
    "No members are tracked for this group yet.",
    "Make sure the bot is added to the group, inline mode is enabled in BotFather, and members have interacted with the bot or the group after the bot joined.",
    "For better coverage, disable privacy mode in BotFather and make the bot an admin if you want chat_member updates.",
  ].join("\n");
}

export class HereBotUseCases {
  private readonly helpText: string;

  constructor(private readonly deps: HereBotUseCaseDeps) {
    this.helpText = buildHelpText(deps.botUsername);
  }

  getHelpMessage(): OutgoingMessage {
    return message(this.helpText, "HTML");
  }

  buildMentionUsageText(): string {
    return `Usage: @${this.deps.botUsername} all or @${this.deps.botUsername} <subgroup-name>`;
  }

  async trackMessageMembers(input: TrackMessageMembersInput): Promise<CommandResult> {
    await this.deps.store.ensureChat(input.chat);

    if (isHumanUser(input.sender)) {
      await this.deps.store.upsertMember(input.chat, input.sender);
      this.deps.inlineContexts.remember(input.sender.id, input.chat.id);

      const draft = this.deps.drafts.get(input.chat.id, input.sender.id);
      const messageText = typeof input.messageText === "string" ? input.messageText.trim() : "";
      const [firstToken = ""] = messageText.split(/\s+/, 1);
      const startsWithBotMention =
        firstToken.toLowerCase() === `@${this.deps.botUsername.toLowerCase()}`;
      const mentionPingRequest = messageText
        ? parseMentionPingRequest(messageText, this.deps.botUsername)
        : null;

      if (
        draft?.awaitingName &&
        messageText &&
        !messageText.startsWith("/") &&
        !startsWithBotMention &&
        !mentionPingRequest
      ) {
        const result = await this.saveDraftAsGroup({
          chatId: input.chat.id,
          ownerId: input.sender.id,
          rawGroupName: messageText,
        });

        return commandResult(result.messages, true);
      }
    }

    if (isHumanUser(input.replyToUser)) {
      await this.deps.store.upsertMember(input.chat, input.replyToUser);
    }

    for (const member of input.newMembers) {
      await this.deps.store.upsertMember(input.chat, member);
    }

    return commandResult([]);
  }

  async bindChat(chat: GroupChatInput): Promise<CommandResult> {
    const registered = await this.deps.store.ensureChat(chat);
    const memberCount = Object.keys(registered.members).length;
    const groupCount = Object.keys(registered.groups).length;
    const homeScreen = this.deps.presentation.buildHomeScreen(registered, memberCount, groupCount);

    return commandResult([
      message(
        [
          `Registered <b>${registered.title}</b>.`,
          `Tracked members: <b>${memberCount}</b>`,
          `Custom groups: <b>${groupCount}</b>`,
          "",
          `Mention everyone: <code>@${this.deps.botUsername} all</code>`,
          `Mention a subgroup: <code>@${this.deps.botUsername} gang</code>`,
          "The inline button flow uses the same shapes: all or the subgroup name.",
        ].join("\n"),
        "HTML",
        homeScreen.keyboard,
      ),
    ]);
  }

  async getHomeDashboard(chat: GroupChatInput): Promise<CommandResult> {
    const registered = await this.deps.store.ensureChat(chat);
    return commandResult([screenMessage(this.buildHomeScreenForChat(registered))]);
  }

  async pingAll(input: PingInput): Promise<CommandResult> {
    if (input.chat) {
      await this.deps.store.ensureChat(input.chat);
    }

    return this.pingMembers({
      chatId: input.chatId,
      label: "here",
      members: this.deps.store.getMembers(input.chatId),
      requesterId: input.requesterId,
      emptyMessage: buildMissingMembersHint(),
    });
  }

  async pingTag(input: TagCommandInput): Promise<CommandResult> {
    const [tagKey] = parseArgs(input.matchText);
    const normalizedTag = tagKey ? normalizeKey(tagKey) : null;

    if (!normalizedTag) {
      return commandResult([message("Usage: /tag <group-name>")]);
    }

    await this.deps.store.ensureChat(input.chat);

    return this.pingMembers({
      chatId: input.chat.id,
      label: normalizedTag,
      members: this.deps.store.getGroupMembers(input.chat.id, normalizedTag),
      requesterId: input.requesterId,
      emptyMessage: "That group is empty or does not exist. Create it with /tagset first.",
    });
  }

  pingMentionText(input: {
    chatId: number;
    messageText: string;
    requesterId?: number | undefined;
  }): CommandResult {
    const request = parseMentionPingRequest(input.messageText, this.deps.botUsername);

    if (!request) {
      return commandResult([message(this.buildMentionUsageText())]);
    }

    const label = this.getPingLabel(request);
    const members = this.getMembersForPingRequest(input.chatId, request);

    return this.pingMembers({
      chatId: input.chatId,
      label,
      members,
      requesterId: input.requesterId,
      emptyMessage:
        request.kind === "all"
          ? buildMissingMembersHint()
          : "That subgroup is empty or does not exist. Create it with /tagset first.",
    });
  }

  async tagSet(input: TagCommandInput): Promise<CommandResult> {
    const [tagKey, ...memberRefs] = parseArgs(input.matchText);
    const normalizedTag = tagKey ? normalizeKey(tagKey) : null;

    if (!normalizedTag) {
      return commandResult([
        message(
          "Usage: /tagset <group-name> <@username|user-id|me...>\nYou can also reply to a user with /tagset <group-name>.",
        ),
      ]);
    }

    await this.deps.store.ensureChat(input.chat);
    const selection = this.resolveSelectedMembers(input.chat.id, memberRefs, {
      currentUserId: input.requesterId,
      replyToUserId: input.replyToUserId,
    });

    if (selection.unresolved.length > 0) {
      return commandResult([
        message(
          `I could not resolve: ${selection.unresolved.join(", ")}.\nOnly tracked users in this group can be added.`,
        ),
      ]);
    }

    if (selection.ids.length === 0) {
      const replies = this.getUntrackedCurrentUserMessages(input.chat.id, input.requesterId);
      replies.push(
        message(
          "No users selected. Pass usernames, numeric IDs, `me`, or reply to a user message.",
        ),
      );
      return commandResult(replies);
    }

    await this.deps.store.upsertGroup(input.chat.id, normalizedTag, selection.ids);
    const members = this.deps.store.getGroupMembers(input.chat.id, normalizedTag);

    return commandResult([
      message(
        `Saved @${normalizedTag} with ${members.length} member${members.length === 1 ? "" : "s"}.`,
      ),
    ]);
  }

  async tagAdd(input: TagCommandInput): Promise<CommandResult> {
    const [tagKey, ...memberRefs] = parseArgs(input.matchText);
    const normalizedTag = tagKey ? normalizeKey(tagKey) : null;

    if (!normalizedTag) {
      return commandResult([
        message(
          "Usage: /tagadd <group-name> <@username|user-id|me...>\nYou can also reply to a user with /tagadd <group-name>.",
        ),
      ]);
    }

    await this.deps.store.ensureChat(input.chat);
    const selection = this.resolveSelectedMembers(input.chat.id, memberRefs, {
      currentUserId: input.requesterId,
      replyToUserId: input.replyToUserId,
    });

    if (selection.unresolved.length > 0) {
      return commandResult([message(`I could not resolve: ${selection.unresolved.join(", ")}.`)]);
    }

    if (selection.ids.length === 0) {
      return commandResult([message("No users selected.")]);
    }

    const saved = await this.deps.store.addToGroup(input.chat.id, normalizedTag, selection.ids);

    if (!saved) {
      return commandResult([message("That group name is invalid.")]);
    }

    const members = this.deps.store.getGroupMembers(input.chat.id, saved);

    return commandResult([
      message(
        `Updated @${saved}. It now has ${members.length} member${members.length === 1 ? "" : "s"}.`,
      ),
    ]);
  }

  async tagRemove(input: TagCommandInput): Promise<CommandResult> {
    const [tagKey, ...memberRefs] = parseArgs(input.matchText);
    const normalizedTag = tagKey ? normalizeKey(tagKey) : null;

    if (!normalizedTag) {
      return commandResult([
        message(
          "Usage: /tagremove <group-name> <@username|user-id|me...>\nYou can also reply to a user with /tagremove <group-name>.",
        ),
      ]);
    }

    await this.deps.store.ensureChat(input.chat);
    const selection = this.resolveSelectedMembers(input.chat.id, memberRefs, {
      currentUserId: input.requesterId,
      replyToUserId: input.replyToUserId,
    });

    if (selection.unresolved.length > 0) {
      return commandResult([message(`I could not resolve: ${selection.unresolved.join(", ")}.`)]);
    }

    if (selection.ids.length === 0) {
      return commandResult([message("No users selected.")]);
    }

    const saved = await this.deps.store.removeFromGroup(
      input.chat.id,
      normalizedTag,
      selection.ids,
    );

    if (!saved) {
      return commandResult([message("That group does not exist.")]);
    }

    const members = this.deps.store.getGroupMembers(input.chat.id, saved);

    return commandResult([
      message(
        `Updated @${saved}. It now has ${members.length} member${members.length === 1 ? "" : "s"}.`,
      ),
    ]);
  }

  async tagDelete(input: TagCommandInput): Promise<CommandResult> {
    const args = parseArgs(input.matchText);
    const tagKey = args[0];
    const normalizedTag = tagKey ? normalizeKey(tagKey) : null;

    if (!normalizedTag) {
      return commandResult([message("Usage: /tagdelete <group-name>")]);
    }

    await this.deps.store.ensureChat(input.chat);
    const deleted = await this.deps.store.deleteGroup(input.chat.id, normalizedTag);

    if (!deleted) {
      return commandResult([message("That group does not exist.")]);
    }

    return commandResult([message(`Deleted @${normalizedTag}.`)]);
  }

  async listTags(chat: GroupChatInput): Promise<CommandResult> {
    const registered = await this.deps.store.ensureChat(chat);

    return commandResult([
      screenMessage(
        this.deps.presentation.buildGroupsScreen(
          registered,
          this.deps.store.listGroups(chat.id),
          0,
        ),
      ),
    ]);
  }

  async saveDraftAsGroup(input: SaveDraftAsGroupInput): Promise<CommandResult> {
    if (input.chat) {
      await this.deps.store.ensureChat(input.chat);
    }

    const rawGroupName = input.rawGroupName ?? "";
    const normalizedTag = normalizeKey(
      rawGroupName.startsWith("@") ? rawGroupName.slice(1) : rawGroupName,
    );

    if (!normalizedTag) {
      return commandResult([
        message("Invalid subgroup name. Use 2-32 characters: letters, numbers, _ or -."),
      ]);
    }

    const draft = this.deps.drafts.get(input.chatId, input.ownerId);

    if (!draft) {
      return commandResult([message("No active subgroup draft. Start one with /manage.")]);
    }

    if (draft.memberIds.length === 0) {
      return commandResult([message("Select at least one member before saving.")]);
    }

    this.deps.drafts.setGroupKey(input.chatId, input.ownerId, normalizedTag);
    const saved = await this.deps.store.upsertGroup(input.chatId, normalizedTag, draft.memberIds);

    if (!saved) {
      return commandResult([message("That subgroup name is invalid.")]);
    }

    this.deps.drafts.clear(input.chatId, input.ownerId);
    const registered = this.deps.store.getChat(input.chatId);
    const savedGroup = this.deps.store.getGroup(input.chatId, saved);

    if (!registered || !savedGroup) {
      return commandResult([message(`Saved @${saved}.`)]);
    }

    return commandResult([
      screenMessage(
        this.deps.presentation.buildGroupScreen(
          registered,
          savedGroup,
          this.deps.store.getGroupMembers(input.chatId, saved),
          0,
        ),
      ),
    ]);
  }

  async saveDraftAsGroupCommand(input: {
    chat: GroupChatInput;
    ownerId: number;
    matchText: string;
  }): Promise<CommandResult> {
    await this.deps.store.ensureChat(input.chat);

    const [groupName] = parseArgs(input.matchText);

    if (!groupName) {
      return commandResult([message("Usage: /tagname <group-name>")]);
    }

    return this.saveDraftAsGroup({
      chatId: input.chat.id,
      ownerId: input.ownerId,
      rawGroupName: groupName,
    });
  }

  resolveInlinePing(input: ResolveInlinePingInput): InlinePingResult {
    const query = input.query.trim();

    if (input.chatType && !SUPPORTED_GROUP_CHAT_TYPES.has(input.chatType)) {
      return this.inlineAnswer([this.wrongChatTypeResult()]);
    }

    if (!query) {
      return this.inlineAnswer([this.buildInlineHelpResult()]);
    }

    const request = parsePingRequest(query);

    if (!request) {
      return this.inlineAnswer([this.buildInlineHelpResult()]);
    }

    const memberChats = this.deps.store.listChatsForMemberByRecency(input.userId);
    const chat = this.resolveChatForPingRequest(input.userId, request, memberChats);

    if (!chat) {
      if (memberChats.length === 0) {
        return this.inlineAnswer([this.noTrackedGroupsResult()]);
      }

      return this.inlineAnswer([
        this.buildInlineResult(
          request.kind === "all" ? "No recent group context" : "Unknown subgroup",
          request.kind === "all"
            ? "Open the target group first"
            : `I could not find @${request.groupKey}`,
          request.kind === "all"
            ? "Open the target group and send one normal message there first, or use the manager buttons in that group to seed the current chat context."
            : `I could not find a subgroup named @${request.groupKey} in your tracked groups.`,
        ),
      ]);
    }

    const label = this.getPingLabel(request);
    const members = this.getMembersForPingRequest(chat.id, request);
    const result = this.buildInlinePingResult(chat, request, label, members);

    if (result) {
      return this.inlineAnswer([result]);
    }

    return this.inlineAnswer([
      this.buildInlineResult(
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
          : `This mention set is too large for one inline result. Send @${this.deps.botUsername} ${request.kind === "all" ? "all" : label} as a normal message in ${chat.title} instead.`,
      ),
    ]);
  }

  async manageDraftAction(input: ManageDraftActionInput): Promise<ManagerActionResult> {
    return handleManagerCallbackAction(input, this.deps);
  }

  private buildHomeScreenForChat(chat: KnownChat): { text: string; keyboard: KeyboardModel } {
    return this.deps.presentation.buildHomeScreen(
      chat,
      Object.keys(chat.members).length,
      Object.keys(chat.groups).length,
    );
  }

  private pingMembers(input: {
    chatId: number;
    label: string;
    members: KnownMember[];
    requesterId?: number | undefined;
    emptyMessage: string;
  }): CommandResult {
    if (input.members.length > 0) {
      const cooldownMessage = this.claimPingCooldown(input.chatId, input.requesterId, input.label);

      if (cooldownMessage) {
        return commandResult([message(cooldownMessage)]);
      }
    }

    return commandResult(this.mentionMessages(input.label, input.members, input.emptyMessage));
  }

  private mentionMessages(
    label: string,
    members: KnownMember[],
    emptyMessage: string,
  ): OutgoingMessage[] {
    if (members.length === 0) {
      return [message(emptyMessage)];
    }

    return this.deps.presentation
      .buildMentionChunks(label, members)
      .map((chunk) => message(chunk, "HTML"));
  }

  private claimPingCooldown(
    chatId: number,
    userId: number | undefined,
    label: string,
  ): string | null {
    if (typeof userId !== "number") {
      return null;
    }

    const remainingMs = this.deps.pingCooldowns.reserve(
      chatId,
      userId,
      label,
      this.deps.clock.now(),
    );

    if (remainingMs <= 0) {
      return null;
    }

    return formatPingCooldownMessage(remainingMs);
  }

  private resolveSelectedMembers(
    chatId: number,
    refs: string[],
    options: {
      currentUserId?: number | undefined;
      replyToUserId?: number | undefined;
    },
  ): { ids: number[]; unresolved: string[] } {
    const knownMembers = this.deps.store.getMembers(chatId);
    const extraIds: number[] = [];
    const filteredRefs: string[] = [];
    let hasCurrentUserRef = false;

    for (const ref of refs) {
      if (ref === "me") {
        hasCurrentUserRef = true;
      } else {
        filteredRefs.push(ref);
      }
    }

    if (typeof options.currentUserId === "number" && hasCurrentUserRef) {
      extraIds.push(options.currentUserId);
    }

    if (refs.length === 0 && typeof options.replyToUserId === "number") {
      extraIds.push(options.replyToUserId);
    }

    return resolveMemberRefs(knownMembers, filteredRefs, extraIds);
  }

  private getUntrackedCurrentUserMessages(
    chatId: number,
    currentUserId: number | undefined,
  ): OutgoingMessage[] {
    if (typeof currentUserId !== "number") {
      return [];
    }

    const currentChat = this.deps.store.getChat(chatId);

    if (currentChat?.members[String(currentUserId)]) {
      return [];
    }

    return [
      message(
        "I can only add people I have seen. Ask the target members to send one message in this group after I join.",
      ),
    ];
  }

  private getPingLabel(request: PingRequest): string {
    return request.kind === "all" ? "here" : request.groupKey;
  }

  private getMembersForPingRequest(chatId: number, request: PingRequest): KnownMember[] {
    return request.kind === "all"
      ? this.deps.store.getMembers(chatId)
      : this.deps.store.getGroupMembers(chatId, request.groupKey);
  }

  private chatMatchesPingRequest(chat: KnownChat, request: PingRequest): boolean {
    if (request.kind === "all") {
      return true;
    }

    return Boolean(this.deps.store.getGroup(chat.id, request.groupKey));
  }

  private resolveChatForPingRequest(
    userId: number,
    request: PingRequest,
    memberChats: KnownChat[],
  ): KnownChat | null {
    const recentChatId = this.deps.inlineContexts.getChatId(userId);
    const recentChat =
      typeof recentChatId === "number" ? this.deps.store.getChat(recentChatId) : null;

    if (recentChat && this.chatMatchesPingRequest(recentChat, request)) {
      return recentChat;
    }

    return memberChats.find((chat) => this.chatMatchesPingRequest(chat, request)) ?? null;
  }

  private buildInlineHelpResult(): InlineArticleResultModel {
    return {
      type: "article",
      id: "help",
      title: "Use all or a subgroup",
      description: this.buildMentionUsageText(),
      inputMessageContent: inlineContent(this.helpText, "HTML"),
    };
  }

  private buildInlineResult(
    title: string,
    description: string,
    messageText: string,
  ): InlineArticleResultModel {
    return {
      type: "article",
      id: `${this.deps.clock.now()}-${this.deps.idGenerator.nextId()}`,
      title,
      description,
      inputMessageContent: inlineContent(messageText, "HTML"),
    };
  }

  private buildInlinePingResult(
    chat: KnownChat,
    request: PingRequest,
    label: string,
    members: KnownMember[],
  ): InlineArticleResultModel | null {
    if (members.length === 0) {
      return null;
    }

    const chunks = this.deps.presentation.buildMentionChunks(label, members);
    const firstChunk = chunks[0];

    if (!firstChunk || chunks.length > 1) {
      return null;
    }

    return this.buildInlineResult(
      request.kind === "all"
        ? `Ping everyone in ${chat.title}`
        : `Ping @${request.groupKey} in ${chat.title}`,
      `${members.length} tracked members`,
      firstChunk,
    );
  }

  private noTrackedGroupsResult(): InlineArticleResultModel {
    return this.buildInlineResult(
      "No tracked groups yet",
      "I do not know any groups for you yet",
      "I can only target groups where I have already seen you. Send one message in the target group after the bot joins, then try again.",
    );
  }

  private wrongChatTypeResult(): InlineArticleResultModel {
    return this.buildInlineResult(
      "Use this in a group",
      "This bot only pings group and supergroup members",
      "Open the target Telegram group and use all or a subgroup name there.",
    );
  }

  private inlineAnswer(results: InlineArticleResultModel[]): InlinePingResult {
    return {
      results,
      cacheTime: 0,
      isPersonal: true,
    };
  }
}
