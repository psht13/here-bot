import type { KnownChat, KnownMember } from "../../domain/models.js";
import type { ChatRepository } from "../ports/chat-repository.js";
import type { Clock } from "../ports/system.js";
import type { DraftRegistry } from "../services/draft-registry.js";
import { formatPingCooldownMessage, type PingCooldownRegistry } from "../services/ping-cooldown.js";
import type {
  CallbackAnswerModel,
  HereBotPresentation,
  ManagerActionResult,
  OutgoingMessage,
} from "../use-cases/here-bot.js";
import type { ManagerAction } from "./manager-callbacks.js";

type CallbackAction<TKind extends ManagerAction["kind"]> = Extract<ManagerAction, { kind: TKind }>;

export interface ManagerCallbackHandlerDeps {
  store: ChatRepository;
  drafts: DraftRegistry;
  pingCooldowns: PingCooldownRegistry;
  clock: Clock;
  presentation: HereBotPresentation;
}

export interface RegisteredManagerCallbackContext {
  deps: ManagerCallbackHandlerDeps;
  registered: KnownChat;
  actorId?: number | undefined;
}

export interface DraftManagerCallbackContext {
  deps: ManagerCallbackHandlerDeps;
  registered: KnownChat;
  ownerId: number;
}

function message(
  text: string,
  parseMode?: "HTML",
  keyboard?: OutgoingMessage["keyboard"],
): OutgoingMessage {
  const result: OutgoingMessage = { text };

  if (parseMode) {
    result.parseMode = parseMode;
  }

  if (keyboard) {
    result.keyboard = keyboard;
  }

  return result;
}

function screenMessage(screen: {
  text: string;
  keyboard: NonNullable<OutgoingMessage["keyboard"]>;
}): OutgoingMessage {
  return message(screen.text, "HTML", screen.keyboard);
}

function callbackResult(input: {
  answer?: CallbackAnswerModel | undefined;
  editMessage?: OutgoingMessage | undefined;
  messages?: OutgoingMessage[] | undefined;
}): ManagerActionResult {
  const result: ManagerActionResult = {
    messages: input.messages ?? [],
  };

  if (input.answer) {
    result.answer = input.answer;
  }

  if (input.editMessage) {
    result.editMessage = input.editMessage;
  }

  return result;
}

function buildMissingMembersHint(): string {
  return [
    "No members are tracked for this group yet.",
    "Ask members to send one message here after the bot joins, then try again.",
  ].join("\n");
}

function buildHomeScreenForChat(
  deps: ManagerCallbackHandlerDeps,
  chat: KnownChat,
): { text: string; keyboard: NonNullable<OutgoingMessage["keyboard"]> } {
  return deps.presentation.buildHomeScreen(
    chat,
    Object.keys(chat.members).length,
    Object.keys(chat.groups).length,
  );
}

function mentionMessages(
  deps: ManagerCallbackHandlerDeps,
  label: string,
  members: KnownMember[],
  emptyMessage: string,
): OutgoingMessage[] {
  if (members.length === 0) {
    return [message(emptyMessage)];
  }

  return deps.presentation
    .buildMentionChunks(label, members)
    .map((chunk) => message(chunk, "HTML"));
}

function claimPingCooldown(
  deps: ManagerCallbackHandlerDeps,
  chatId: number,
  userId: number | undefined,
  label: string,
): string | null {
  if (typeof userId !== "number") {
    return null;
  }

  const remainingMs = deps.pingCooldowns.reserve(chatId, userId, label, deps.clock.now());

  if (remainingMs <= 0) {
    return null;
  }

  return formatPingCooldownMessage(remainingMs);
}

function expiredDraftResult(context: DraftManagerCallbackContext): ManagerActionResult {
  return callbackResult({
    answer: {
      text: "That draft expired. Start again from New Subgroup.",
      showAlert: true,
    },
    editMessage: screenMessage(buildHomeScreenForChat(context.deps, context.registered)),
  });
}

export function handleHomeCallback(
  _action: CallbackAction<"home">,
  context: RegisteredManagerCallbackContext,
): ManagerActionResult {
  return callbackResult({
    answer: {},
    editMessage: screenMessage(buildHomeScreenForChat(context.deps, context.registered)),
  });
}

export function handlePingAllCallback(
  action: CallbackAction<"pingAll">,
  context: RegisteredManagerCallbackContext,
): ManagerActionResult {
  const members = context.deps.store.getMembers(action.chatId);

  if (members.length > 0) {
    const cooldownMessage = claimPingCooldown(context.deps, action.chatId, context.actorId, "here");

    if (cooldownMessage) {
      return callbackResult({
        answer: {
          text: cooldownMessage,
          showAlert: true,
        },
      });
    }
  }

  return callbackResult({
    answer: {},
    messages: mentionMessages(context.deps, "here", members, buildMissingMembersHint()),
  });
}

export function handleMembersCallback(
  action: CallbackAction<"members">,
  context: RegisteredManagerCallbackContext,
): ManagerActionResult {
  return callbackResult({
    answer: {},
    editMessage: screenMessage(
      context.deps.presentation.buildMembersScreen(
        context.registered,
        context.deps.store.getMembers(action.chatId),
        action.page,
      ),
    ),
  });
}

export function handleGroupsCallback(
  action: CallbackAction<"groups">,
  context: RegisteredManagerCallbackContext,
): ManagerActionResult {
  return callbackResult({
    answer: {},
    editMessage: screenMessage(
      context.deps.presentation.buildGroupsScreen(
        context.registered,
        context.deps.store.listGroups(action.chatId),
        action.page,
      ),
    ),
  });
}

export function handleGroupViewCallback(
  action: CallbackAction<"groupView">,
  context: RegisteredManagerCallbackContext,
): ManagerActionResult {
  const group = context.deps.store.getGroup(action.chatId, action.groupKey);

  if (!group) {
    return callbackResult({
      answer: {
        text: "That subgroup no longer exists.",
        showAlert: true,
      },
      editMessage: screenMessage(
        context.deps.presentation.buildGroupsScreen(
          context.registered,
          context.deps.store.listGroups(action.chatId),
          action.page,
        ),
      ),
    });
  }

  return callbackResult({
    answer: {},
    editMessage: screenMessage(
      context.deps.presentation.buildGroupScreen(
        context.registered,
        group,
        context.deps.store.getGroupMembers(action.chatId, action.groupKey),
        action.page,
      ),
    ),
  });
}

export function handleGroupPingCallback(
  action: CallbackAction<"groupPing">,
  context: RegisteredManagerCallbackContext,
): ManagerActionResult {
  const members = context.deps.store.getGroupMembers(action.chatId, action.groupKey);

  if (members.length === 0) {
    return callbackResult({
      answer: {
        text: "That subgroup is empty.",
        showAlert: true,
      },
    });
  }

  const cooldownMessage = claimPingCooldown(
    context.deps,
    action.chatId,
    context.actorId,
    action.groupKey,
  );

  if (cooldownMessage) {
    return callbackResult({
      answer: {
        text: cooldownMessage,
        showAlert: true,
      },
    });
  }

  return callbackResult({
    answer: {},
    messages: mentionMessages(context.deps, action.groupKey, members, buildMissingMembersHint()),
  });
}

export async function handleGroupDeleteCallback(
  action: CallbackAction<"groupDelete">,
  context: RegisteredManagerCallbackContext,
): Promise<ManagerActionResult> {
  const deleted = await context.deps.store.deleteGroup(action.chatId, action.groupKey);

  return callbackResult({
    answer: {
      text: deleted ? `Deleted @${action.groupKey}` : "That subgroup was already removed.",
    },
    editMessage: screenMessage(
      context.deps.presentation.buildGroupsScreen(
        context.registered,
        context.deps.store.listGroups(action.chatId),
        action.page,
      ),
    ),
  });
}

export function handleDraftNewCallback(
  action: CallbackAction<"draftNew">,
  context: DraftManagerCallbackContext,
): ManagerActionResult {
  const members = context.deps.store.getMembers(action.chatId);
  const draft = context.deps.drafts.create(action.chatId, context.ownerId);

  return callbackResult({
    answer: {},
    editMessage: screenMessage(
      context.deps.presentation.buildDraftScreen(context.registered, draft, members),
    ),
  });
}

export function handleDraftEditCallback(
  action: CallbackAction<"draftEdit">,
  context: DraftManagerCallbackContext,
): ManagerActionResult {
  const group = context.deps.store.getGroup(action.chatId, action.groupKey);

  if (!group) {
    return callbackResult({
      answer: {
        text: "That subgroup no longer exists.",
        showAlert: true,
      },
      editMessage: screenMessage(
        context.deps.presentation.buildGroupsScreen(
          context.registered,
          context.deps.store.listGroups(action.chatId),
          action.page,
        ),
      ),
    });
  }

  const draft = context.deps.drafts.create(
    action.chatId,
    context.ownerId,
    group.memberIds,
    group.key,
  );

  return callbackResult({
    answer: {},
    editMessage: screenMessage(
      context.deps.presentation.buildDraftScreen(
        context.registered,
        draft,
        context.deps.store.getMembers(action.chatId),
      ),
    ),
  });
}

export function handleDraftViewCallback(
  action: CallbackAction<"draftView">,
  context: DraftManagerCallbackContext,
): ManagerActionResult {
  const draft = context.deps.drafts.setPage(action.chatId, context.ownerId, action.page);

  if (!draft) {
    return expiredDraftResult(context);
  }

  return callbackResult({
    answer: {},
    editMessage: screenMessage(
      context.deps.presentation.buildDraftScreen(
        context.registered,
        draft,
        context.deps.store.getMembers(action.chatId),
      ),
    ),
  });
}

export function handleDraftToggleCallback(
  action: CallbackAction<"draftToggle">,
  context: DraftManagerCallbackContext,
): ManagerActionResult {
  context.deps.drafts.setPage(action.chatId, context.ownerId, action.page);
  const members = context.deps.store.getMembers(action.chatId);
  const availableIds = new Set(members.map((member) => member.id));
  const draft = context.deps.drafts.toggle(
    action.chatId,
    context.ownerId,
    action.memberId,
    availableIds,
  );

  if (!draft) {
    return callbackResult({
      answer: {
        text: "That draft expired. Start again from New Subgroup.",
        showAlert: true,
      },
    });
  }

  return callbackResult({
    answer: {},
    editMessage: screenMessage(
      context.deps.presentation.buildDraftScreen(context.registered, draft, members),
    ),
  });
}

export async function handleDraftSaveCallback(
  action: CallbackAction<"draftSave">,
  context: DraftManagerCallbackContext,
): Promise<ManagerActionResult> {
  const draft = context.deps.drafts.get(action.chatId, context.ownerId);

  if (!draft) {
    return callbackResult({
      answer: {
        text: "That draft expired. Start again from New Subgroup.",
        showAlert: true,
      },
    });
  }

  if (draft.memberIds.length === 0) {
    return callbackResult({
      answer: {
        text: "Select at least one member before saving.",
        showAlert: true,
      },
    });
  }

  if (!draft.groupKey) {
    const promptedDraft = context.deps.drafts.promptForName(action.chatId, context.ownerId);

    if (!promptedDraft) {
      return callbackResult({
        answer: {
          text: "That draft expired. Start again from New Subgroup.",
          showAlert: true,
        },
      });
    }

    return callbackResult({
      answer: {
        text: "Send the subgroup name as your next message in this group.",
        showAlert: true,
      },
      editMessage: screenMessage(
        context.deps.presentation.buildDraftScreen(
          context.registered,
          promptedDraft,
          context.deps.store.getMembers(action.chatId),
        ),
      ),
    });
  }

  const saved = await context.deps.store.upsertGroup(
    action.chatId,
    draft.groupKey,
    draft.memberIds,
  );

  if (!saved) {
    return callbackResult({
      answer: {
        text: "That subgroup name is invalid.",
        showAlert: true,
      },
    });
  }

  context.deps.drafts.clear(action.chatId, context.ownerId);
  const savedGroup = context.deps.store.getGroup(action.chatId, saved);

  if (!savedGroup) {
    return callbackResult({
      answer: {
        text: `Saved @${saved}`,
      },
      editMessage: screenMessage(buildHomeScreenForChat(context.deps, context.registered)),
    });
  }

  return callbackResult({
    answer: {
      text: `Saved @${saved}`,
    },
    editMessage: screenMessage(
      context.deps.presentation.buildGroupScreen(
        context.registered,
        savedGroup,
        context.deps.store.getGroupMembers(action.chatId, saved),
        0,
      ),
    ),
  });
}

export function handleDraftCancelCallback(
  action: CallbackAction<"draftCancel">,
  context: DraftManagerCallbackContext,
): ManagerActionResult {
  context.deps.drafts.clear(action.chatId, context.ownerId);

  return callbackResult({
    answer: {
      text: "Draft cleared.",
    },
    editMessage: screenMessage(buildHomeScreenForChat(context.deps, context.registered)),
  });
}
