import type { GroupChatInput } from "../ports/chat-repository.js";
import type { InlineContextService } from "../services/inline-context.js";
import type { ManagerActionResult } from "../use-cases/here-bot.js";
import type { ManagerAction } from "./manager-callbacks.js";
import {
  handleDraftCancelCallback,
  handleDraftEditCallback,
  handleDraftNewCallback,
  handleDraftSaveCallback,
  handleDraftToggleCallback,
  handleDraftViewCallback,
  handleGroupDeleteCallback,
  handleGroupPingCallback,
  handleGroupsCallback,
  handleGroupViewCallback,
  handleHomeCallback,
  handleMembersCallback,
  handlePingAllCallback,
  type ManagerCallbackHandlerDeps,
} from "./manager-callback-handlers.js";

const SUPPORTED_GROUP_CHAT_TYPES = new Set(["group", "supergroup"]);

export interface ManagerCallbackRouterDeps extends ManagerCallbackHandlerDeps {
  inlineContexts: InlineContextService;
}

export interface ManageManagerCallbackInput {
  action: ManagerAction;
  currentChat?: GroupChatInput | undefined;
  actorId?: number | undefined;
}

function callbackResult(input: {
  answer?: ManagerActionResult["answer"] | undefined;
}): ManagerActionResult {
  const result: ManagerActionResult = {
    messages: [],
  };

  if (input.answer) {
    result.answer = input.answer;
  }

  return result;
}

function isSupportedGroupChat(
  chat: GroupChatInput | undefined,
): chat is GroupChatInput & { type: "group" | "supergroup" } {
  return Boolean(chat && SUPPORTED_GROUP_CHAT_TYPES.has(chat.type));
}

function requireDraftOwner(actorId: number | undefined): number | ManagerActionResult {
  if (typeof actorId === "number") {
    return actorId;
  }

  return callbackResult({
    answer: {
      text: "Only human users can manage subgroup drafts.",
      showAlert: true,
    },
  });
}

export async function handleManagerCallbackAction(
  input: ManageManagerCallbackInput,
  deps: ManagerCallbackRouterDeps,
): Promise<ManagerActionResult> {
  const { action } = input;

  if (!isSupportedGroupChat(input.currentChat) || input.currentChat.id !== action.chatId) {
    return callbackResult({
      answer: {
        text: "Open the manager from inside the target group.",
        showAlert: true,
      },
    });
  }

  if (typeof input.actorId === "number") {
    deps.inlineContexts.remember(input.actorId, input.currentChat.id);
  }

  const registered = deps.store.getChat(action.chatId);

  if (!registered) {
    return callbackResult({
      answer: {
        text: "This group is not registered yet. Run /bind first.",
        showAlert: true,
      },
    });
  }

  const registeredContext = {
    deps,
    registered,
    actorId: input.actorId,
  };

  switch (action.kind) {
    case "home":
      return handleHomeCallback(action, registeredContext);

    case "pingAll":
      return handlePingAllCallback(action, registeredContext);

    case "members":
      return handleMembersCallback(action, registeredContext);

    case "groups":
      return handleGroupsCallback(action, registeredContext);

    case "groupView":
      return handleGroupViewCallback(action, registeredContext);

    case "groupPing":
      return handleGroupPingCallback(action, registeredContext);

    case "groupDelete":
      return handleGroupDeleteCallback(action, registeredContext);

    case "draftNew": {
      const ownerId = requireDraftOwner(input.actorId);

      if (typeof ownerId !== "number") {
        return ownerId;
      }

      return handleDraftNewCallback(action, { deps, registered, ownerId });
    }

    case "draftEdit": {
      const ownerId = requireDraftOwner(input.actorId);

      if (typeof ownerId !== "number") {
        return ownerId;
      }

      return handleDraftEditCallback(action, { deps, registered, ownerId });
    }

    case "draftView": {
      const ownerId = requireDraftOwner(input.actorId);

      if (typeof ownerId !== "number") {
        return ownerId;
      }

      return handleDraftViewCallback(action, { deps, registered, ownerId });
    }

    case "draftToggle": {
      const ownerId = requireDraftOwner(input.actorId);

      if (typeof ownerId !== "number") {
        return ownerId;
      }

      return handleDraftToggleCallback(action, { deps, registered, ownerId });
    }

    case "draftSave": {
      const ownerId = requireDraftOwner(input.actorId);

      if (typeof ownerId !== "number") {
        return ownerId;
      }

      return handleDraftSaveCallback(action, { deps, registered, ownerId });
    }

    case "draftCancel": {
      const ownerId = requireDraftOwner(input.actorId);

      if (typeof ownerId !== "number") {
        return ownerId;
      }

      return handleDraftCancelCallback(action, { deps, registered, ownerId });
    }
  }
}
