import type { GroupChatInput } from "../../../application/ports/chat-repository.js";
import { parseManagerAction } from "../../../application/callbacks/manager-callbacks.js";
import type {
  CallbackAnswerModel,
  ManagerActionResult,
  OutgoingMessage,
} from "../../../application/use-cases/here-bot.js";

export interface ManagerCallbackUseCases {
  manageDraftAction(input: {
    action: NonNullable<ReturnType<typeof parseManagerAction>>;
    currentChat?: GroupChatInput | undefined;
    actorId?: number | undefined;
  }): Promise<ManagerActionResult>;
}

export interface ManagerCallbackResponseAdapter {
  answerCallback(answer: CallbackAnswerModel): Promise<void>;
  editMessage(message: OutgoingMessage): Promise<void>;
  sendMessages(messages: OutgoingMessage[]): Promise<void>;
}

export interface ManagerCallbackRouteInput {
  data: string;
  currentChat?: GroupChatInput | undefined;
  actorId?: number | undefined;
}

export async function routeManagerCallback(
  input: ManagerCallbackRouteInput,
  useCases: ManagerCallbackUseCases,
  response: ManagerCallbackResponseAdapter,
): Promise<boolean> {
  const action = parseManagerAction(input.data);

  if (!action) {
    return false;
  }

  const result = await useCases.manageDraftAction({
    action,
    currentChat: input.currentChat,
    actorId: input.actorId,
  });

  if (result.answer) {
    await response.answerCallback(result.answer);
  }

  if (result.editMessage) {
    await response.editMessage(result.editMessage);
  }

  await response.sendMessages(result.messages);

  return true;
}
