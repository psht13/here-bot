import test from "node:test";
import assert from "node:assert/strict";

import { managerCallbacks } from "../../../application/callbacks/manager-callbacks.js";
import type { GroupChatInput, UserInput } from "../../../application/ports/chat-repository.js";
import type { Clock, IdGenerator } from "../../../application/ports/system.js";
import { DraftRegistry } from "../../../application/services/draft-registry.js";
import { InlineContextService } from "../../../application/services/inline-context.js";
import { PingCooldownRegistry } from "../../../application/services/ping-cooldown.js";
import { FakeChatRepository } from "../../../application/testing/fake-chat-repository.js";
import {
  HereBotUseCases,
  type CallbackAnswerModel,
  type HereBotPresentation,
  type OutgoingMessage,
} from "../../../application/use-cases/here-bot.js";
import {
  routeManagerCallback,
  type ManagerCallbackResponseAdapter,
} from "./manager-callback-router.js";

const chat: GroupChatInput = {
  id: -1001,
  type: "group",
  title: "Alpha Team",
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

const keyboard = {
  rows: [[{ kind: "callback" as const, text: "Home", data: managerCallbacks.home(chat.id) }]],
};

const presentation: HereBotPresentation = {
  buildHomeScreen: (knownChat, memberCount, groupCount) => ({
    text: `home:${knownChat.title}:${memberCount}:${groupCount}`,
    keyboard,
  }),
  buildMembersScreen: (_knownChat, members, page) => ({
    text: `members:${members.map((member) => member.id).join(",")}:${page}`,
    keyboard,
  }),
  buildGroupsScreen: (_knownChat, groups, page) => ({
    text: `groups:${groups.map((group) => group.key).join(",")}:${page}`,
    keyboard,
  }),
  buildGroupScreen: (_knownChat, group, members, originPage) => ({
    text: `group:${group.key}:${members.map((member) => member.id).join(",")}:${originPage}`,
    keyboard,
  }),
  buildDraftScreen: (_knownChat, draft, allMembers) => ({
    text: [
      "draft",
      draft.groupKey ?? "new",
      draft.memberIds.join(","),
      String(draft.awaitingName),
      String(draft.page),
      String(allMembers.length),
    ].join(":"),
    keyboard,
  }),
  buildMentionChunks: (label, members) => [
    `@${label} ${members.map((member) => member.id).join(" ")}`,
  ],
};

class FakeTelegramResponseAdapter implements ManagerCallbackResponseAdapter {
  readonly answers: CallbackAnswerModel[] = [];
  readonly edits: OutgoingMessage[] = [];
  readonly sentMessages: OutgoingMessage[] = [];
  sendCalls = 0;

  answerCallback(answer: CallbackAnswerModel): Promise<void> {
    this.answers.push(answer);
    return Promise.resolve();
  }

  editMessage(message: OutgoingMessage): Promise<void> {
    this.edits.push(message);
    return Promise.resolve();
  }

  sendMessages(messages: OutgoingMessage[]): Promise<void> {
    this.sendCalls += 1;
    this.sentMessages.push(...messages);
    return Promise.resolve();
  }
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
  const store = new FakeChatRepository();
  const drafts = new DraftRegistry();
  const pingCooldowns = new PingCooldownRegistry();
  const inlineContexts = new InlineContextService(clock);
  const useCases = new HereBotUseCases({
    store,
    drafts,
    pingCooldowns,
    inlineContexts,
    clock,
    idGenerator,
    botUsername: "herebot",
    presentation,
  });

  return {
    store,
    drafts,
    pingCooldowns,
    inlineContexts,
    useCases,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

async function seedMembers(harness: ReturnType<typeof createHarness>): Promise<void> {
  await harness.store.ensureChat(chat);
  await harness.store.upsertMember(chat, alice);
  await harness.store.upsertMember(chat, bob);
  await harness.store.upsertGroup(chat.id, "ops", [bob.id]);
}

test("routeManagerCallback ignores invalid manager callback data", async () => {
  const harness = createHarness();
  const response = new FakeTelegramResponseAdapter();

  const handled = await routeManagerCallback(
    {
      data: "unknown:-1001",
      currentChat: chat,
      actorId: alice.id,
    },
    harness.useCases,
    response,
  );

  assert.equal(handled, false);
  assert.deepEqual(response.answers, []);
  assert.deepEqual(response.edits, []);
  assert.deepEqual(response.sentMessages, []);
  assert.equal(response.sendCalls, 0);
});

test("routeManagerCallback drives every manager action through the response adapter", async () => {
  const harness = createHarness();
  await seedMembers(harness);
  const seenKinds = new Set<string>();

  async function route(kind: string, data: string): Promise<FakeTelegramResponseAdapter> {
    const response = new FakeTelegramResponseAdapter();
    const handled = await routeManagerCallback(
      {
        data,
        currentChat: chat,
        actorId: alice.id,
      },
      harness.useCases,
      response,
    );

    assert.equal(handled, true);
    assert.equal(response.sendCalls, 1);
    seenKinds.add(kind);
    return response;
  }

  const home = await route("home", managerCallbacks.home(chat.id));
  assert.deepEqual(home.answers, [{}]);
  assert.equal(home.edits[0]?.text, "home:Alpha Team:2:1");
  assert.equal(harness.inlineContexts.getChatId(alice.id), chat.id);

  const pingAll = await route("pingAll", managerCallbacks.pingAll(chat.id));
  assert.deepEqual(pingAll.answers, [{}]);
  assert.equal(pingAll.sentMessages[0]?.text, "@here 101 202");
  assert.equal(pingAll.sentMessages[0]?.parseMode, "HTML");

  const members = await route("members", managerCallbacks.members(chat.id, 0));
  assert.equal(members.edits[0]?.text, "members:101,202:0");

  const groups = await route("groups", managerCallbacks.groups(chat.id, 0));
  assert.equal(groups.edits[0]?.text, "groups:ops:0");

  const groupView = await route("groupView", managerCallbacks.groupView(chat.id, "ops", 0));
  assert.equal(groupView.edits[0]?.text, "group:ops:202:0");

  const groupPing = await route("groupPing", managerCallbacks.groupPing(chat.id, "ops"));
  assert.deepEqual(groupPing.answers, [{}]);
  assert.equal(groupPing.sentMessages[0]?.text, "@ops 202");
  assert.equal(groupPing.sentMessages[0]?.parseMode, "HTML");

  const draftNew = await route("draftNew", managerCallbacks.draftNew(chat.id));
  assert.match(draftNew.edits[0]?.text ?? "", /^draft:new::false:0:2$/);

  const draftToggle = await route(
    "draftToggle",
    managerCallbacks.draftToggle(chat.id, 0, alice.id),
  );
  assert.equal(draftToggle.edits[0]?.text, "draft:new:101:false:0:2");

  const promptForName = await route("draftSave", managerCallbacks.draftSave(chat.id));
  assert.equal(
    promptForName.answers[0]?.text,
    "Send the subgroup name as your next message in this group.",
  );
  assert.equal(promptForName.edits[0]?.text, "draft:new:101:true:0:2");

  const draftCancel = await route("draftCancel", managerCallbacks.draftCancel(chat.id));
  assert.equal(draftCancel.answers[0]?.text, "Draft cleared.");
  assert.equal(draftCancel.edits[0]?.text, "home:Alpha Team:2:1");

  const draftEdit = await route("draftEdit", managerCallbacks.draftEdit(chat.id, "ops", 0));
  assert.equal(draftEdit.edits[0]?.text, "draft:ops:202:false:0:2");

  const draftView = await route("draftView", managerCallbacks.draftView(chat.id, 0));
  assert.equal(draftView.edits[0]?.text, "draft:ops:202:false:0:2");

  const saved = await route("draftSave", managerCallbacks.draftSave(chat.id));
  assert.equal(saved.answers[0]?.text, "Saved @ops");
  assert.equal(saved.edits[0]?.text, "group:ops:202:0");

  const groupDelete = await route("groupDelete", managerCallbacks.groupDelete(chat.id, "ops", 0));
  assert.equal(groupDelete.answers[0]?.text, "Deleted @ops");
  assert.equal(groupDelete.edits[0]?.text, "groups::0");

  assert.deepEqual([...seenKinds].sort(), [
    "draftCancel",
    "draftEdit",
    "draftNew",
    "draftSave",
    "draftToggle",
    "draftView",
    "groupDelete",
    "groupPing",
    "groupView",
    "groups",
    "home",
    "members",
    "pingAll",
  ]);
});
