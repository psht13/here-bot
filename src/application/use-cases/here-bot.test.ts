import test from "node:test";
import assert from "node:assert/strict";

import { planMentionChunks } from "../../domain/index.js";
import type { KnownMember } from "../../domain/models.js";
import { managerCallbacks, parseManagerAction } from "../callbacks/manager-callbacks.js";
import type { GroupChatInput, UserInput } from "../ports/chat-repository.js";
import type { Clock, IdGenerator } from "../ports/system.js";
import { DraftRegistry } from "../services/draft-registry.js";
import { InlineContextService } from "../services/inline-context.js";
import { PingCooldownRegistry } from "../services/ping-cooldown.js";
import { FakeChatRepository } from "../testing/fake-chat-repository.js";
import { HereBotUseCases, type CommandResult, type HereBotPresentation } from "./here-bot.js";

const chat: GroupChatInput = {
  id: -1001,
  type: "group",
  title: "Alpha Team",
};

const otherChat: GroupChatInput = {
  id: -2002,
  type: "supergroup",
  title: "Beta Team",
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

const carol: UserInput = {
  id: 303,
  is_bot: false,
  first_name: "Carol",
  username: "carol",
};

const botUser: UserInput = {
  id: 404,
  is_bot: true,
  first_name: "Helper Bot",
  username: "helper_bot",
};

const testKeyboard = {
  rows: [
    [
      { kind: "callback" as const, text: "Ping All", data: managerCallbacks.pingAll(chat.id) },
      { kind: "switchInlineCurrent" as const, text: "Inline Here", query: "all" },
    ],
    [
      { kind: "callback" as const, text: "Groups", data: managerCallbacks.groups(chat.id, 0) },
      { kind: "callback" as const, text: "Members", data: managerCallbacks.members(chat.id, 0) },
    ],
  ],
};

function user(id: number): UserInput {
  return {
    id,
    is_bot: false,
    first_name: `Member ${id}`,
    username: `member_${id}`,
  };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function renderMention(member: KnownMember): string {
  return `<a href="tg://user?id=${member.id}">${escapeHtml(member.displayName)}</a>`;
}

const testPresentation: HereBotPresentation = {
  buildHomeScreen: (knownChat, memberCount, groupCount) => ({
    text: [
      `<b>${escapeHtml(knownChat.title)}</b>`,
      `Tracked members: <b>${memberCount}</b>`,
      `Custom groups: <b>${groupCount}</b>`,
    ].join("\n"),
    keyboard: testKeyboard,
  }),
  buildMembersScreen: (knownChat, knownMembers, page) => ({
    text: [
      `<b>${escapeHtml(knownChat.title)} Members</b>`,
      `Tracked members: <b>${knownMembers.length}</b>`,
      `Page ${page + 1}/1`,
    ].join("\n"),
    keyboard: testKeyboard,
  }),
  buildGroupsScreen: (knownChat, groups, page) => ({
    text: [
      `<b>${escapeHtml(knownChat.title)} Subgroups</b>`,
      `Page ${page + 1}/1`,
      ...groups.map((group) => `- @${group.key} (${group.memberIds.length} members)`),
    ].join("\n"),
    keyboard: testKeyboard,
  }),
  buildGroupScreen: (knownChat, group, knownMembers) => ({
    text: [
      `<b>@${group.key}</b> in <b>${escapeHtml(knownChat.title)}</b>`,
      `Members: <b>${knownMembers.length}</b>`,
    ].join("\n"),
    keyboard: testKeyboard,
  }),
  buildDraftScreen: (knownChat, draft, allMembers) => ({
    text: [
      `<b>Subgroup Builder</b> for <b>${escapeHtml(knownChat.title)}</b>`,
      draft.groupKey ? `Editing: <code>@${draft.groupKey}</code>` : "New subgroup draft",
      `Selected members: <b>${draft.memberIds.length}</b> of <b>${allMembers.length}</b>`,
      draft.awaitingName
        ? "Send the subgroup name as your next message in this group."
        : "Press Name + Save to enter naming mode.",
    ].join("\n"),
    keyboard: testKeyboard,
  }),
  buildMentionChunks: (label, knownMembers) =>
    planMentionChunks(label, knownMembers, {
      maxLength: 3900,
      getMemberReferenceLength: (knownMember) => renderMention(knownMember).length,
    }).map((chunk) => {
      const mentions = chunk.members
        .map((knownMember) => ` ${renderMention(knownMember)}`)
        .join("");
      return `@${chunk.label}${mentions}`;
    }),
};

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
    presentation: testPresentation,
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

async function seedMembers(
  harness: ReturnType<typeof createHarness>,
  members: UserInput[] = [alice, bob, carol],
  targetChat: GroupChatInput = chat,
): Promise<void> {
  await harness.store.ensureChat(targetChat);

  for (const member of members) {
    await harness.store.upsertMember(targetChat, member);
  }
}

function firstText(result: CommandResult): string {
  return result.messages[0]?.text ?? "";
}

test("trackMessageMembers tracks message participants and inline context", async () => {
  const harness = createHarness();

  const result = await harness.useCases.trackMessageMembers({
    chat,
    sender: alice,
    replyToUser: bob,
    newMembers: [carol, botUser],
    messageText: "hello",
  });

  assert.deepEqual(result.messages, []);
  assert.equal(result.stopPropagation, undefined);
  assert.deepEqual(
    harness.store.getMembers(chat.id).map((member) => member.id),
    [101, 202, 303],
  );

  const inline = harness.useCases.resolveInlinePing({
    query: "all",
    userId: alice.id,
  });

  assert.equal(inline.results[0]?.title, "Ping everyone in Alpha Team");
  assert.match(inline.results[0]?.inputMessageContent.messageText ?? "", /^@here /);
});

test("InlineContextService keeps exact ttl context and expires after it", () => {
  const harness = createHarness();

  harness.inlineContexts.remember(alice.id, chat.id);
  harness.advance(10 * 60 * 1000);

  assert.equal(harness.inlineContexts.getChatId(alice.id), chat.id);

  harness.advance(1);

  assert.equal(harness.inlineContexts.getChatId(alice.id), null);
});

test("trackMessageMembers saves an awaiting-name draft and stops propagation", async () => {
  const harness = createHarness();
  await seedMembers(harness, [alice, bob]);
  harness.drafts.create(chat.id, alice.id, [alice.id, bob.id]);
  harness.drafts.promptForName(chat.id, alice.id);

  const result = await harness.useCases.trackMessageMembers({
    chat,
    sender: alice,
    replyToUser: carol,
    newMembers: [carol],
    messageText: "Ops-Team",
  });

  assert.equal(result.stopPropagation, true);
  assert.match(firstText(result), /<b>@ops-team<\/b>/);
  assert.equal(harness.drafts.get(chat.id, alice.id), null);
  assert.deepEqual(
    harness.store.getGroupMembers(chat.id, "ops-team").map((member) => member.id),
    [101, 202],
  );
  assert.deepEqual(
    harness.store.getMembers(chat.id).map((member) => member.id),
    [101, 202],
  );
});

test("bindChat, getHomeDashboard, and listTags return manager DTOs", async () => {
  const harness = createHarness();
  await seedMembers(harness, [alice, bob]);
  await harness.store.upsertGroup(chat.id, "ops", [alice.id]);

  const bind = await harness.useCases.bindChat(chat);
  assert.equal(bind.messages[0]?.parseMode, "HTML");
  assert.match(firstText(bind), /Registered <b>Alpha Team<\/b>/);
  assert.equal(bind.messages[0]?.keyboard?.rows[0]?.[0]?.text, "Ping All");

  const dashboard = await harness.useCases.getHomeDashboard(chat);
  assert.match(firstText(dashboard), /Tracked members: <b>2<\/b>/);
  assert.equal(dashboard.messages[0]?.keyboard?.rows[1]?.[0]?.text, "Groups");

  const tags = await harness.useCases.listTags(chat);
  assert.match(firstText(tags), /Alpha Team Subgroups/);
  assert.match(firstText(tags), /- @ops \(1 members\)/);
});

test("pingAll returns missing-member help, mentions, and cooldown errors", async () => {
  const harness = createHarness();

  const empty = await harness.useCases.pingAll({
    chat,
    chatId: chat.id,
    requesterId: alice.id,
  });
  assert.match(firstText(empty), /No members are tracked/);

  await seedMembers(harness, [alice, bob]);
  const firstPing = await harness.useCases.pingAll({
    chat,
    chatId: chat.id,
    requesterId: alice.id,
  });
  assert.equal(firstPing.messages[0]?.parseMode, "HTML");
  assert.match(firstText(firstPing), /^@here /);
  assert.match(firstText(firstPing), /tg:\/\/user\?id=101/);

  const secondPing = await harness.useCases.pingAll({
    chat,
    chatId: chat.id,
    requesterId: alice.id,
  });
  assert.equal(firstText(secondPing), "Wait 1 minute before sending the same ping again.");

  harness.advance(60_001);
  const afterCooldown = await harness.useCases.pingAll({
    chatId: chat.id,
    requesterId: alice.id,
  });
  assert.match(firstText(afterCooldown), /^@here /);
});

test("pingTag and mention pings preserve usage, empty, success, and cooldown paths", async () => {
  const harness = createHarness();
  await seedMembers(harness, [alice, bob]);
  await harness.store.upsertGroup(chat.id, "ops", [bob.id]);

  const usage = await harness.useCases.pingTag({
    chat,
    matchText: "",
    requesterId: alice.id,
  });
  assert.equal(firstText(usage), "Usage: /tag <group-name>");

  const missing = await harness.useCases.pingTag({
    chat,
    matchText: "missing",
    requesterId: alice.id,
  });
  assert.equal(
    firstText(missing),
    "That group is empty or does not exist. Create it with /tagset first.",
  );

  const success = await harness.useCases.pingTag({
    chat,
    matchText: "Ops",
    requesterId: alice.id,
  });
  assert.match(firstText(success), /^@ops /);
  assert.match(firstText(success), /tg:\/\/user\?id=202/);

  const cooldown = await harness.useCases.pingTag({
    chat,
    matchText: "ops",
    requesterId: alice.id,
  });
  assert.equal(firstText(cooldown), "Wait 1 minute before sending the same ping again.");

  const badMention = harness.useCases.pingMentionText({
    chatId: chat.id,
    messageText: "@herebot ops now",
    requesterId: alice.id,
  });
  assert.equal(firstText(badMention), "Usage: @herebot all or @herebot <subgroup-name>");

  const missingMention = harness.useCases.pingMentionText({
    chatId: chat.id,
    messageText: "@herebot missing",
    requesterId: bob.id,
  });
  assert.equal(
    firstText(missingMention),
    "That subgroup is empty or does not exist. Create it with /tagset first.",
  );
});

test("tagSet covers usage, unresolved refs, empty selections, replies, and me refs", async () => {
  const harness = createHarness();

  const usage = await harness.useCases.tagSet({
    chat,
    matchText: "",
    requesterId: alice.id,
  });
  assert.match(firstText(usage), /^Usage: \/tagset/);

  const untrackedEmpty = await harness.useCases.tagSet({
    chat,
    matchText: "ops",
    requesterId: alice.id,
  });
  assert.equal(untrackedEmpty.messages.length, 2);
  assert.match(untrackedEmpty.messages[0]?.text ?? "", /I can only add people I have seen/);
  assert.match(untrackedEmpty.messages[1]?.text ?? "", /No users selected/);

  await seedMembers(harness, [alice, bob]);
  const unresolved = await harness.useCases.tagSet({
    chat,
    matchText: "ops @missing",
    requesterId: alice.id,
  });
  assert.equal(
    firstText(unresolved),
    "I could not resolve: @missing.\nOnly tracked users in this group can be added.",
  );

  const replySelection = await harness.useCases.tagSet({
    chat,
    matchText: "replyteam",
    requesterId: alice.id,
    replyToUserId: bob.id,
  });
  assert.equal(firstText(replySelection), "Saved @replyteam with 1 member.");
  assert.deepEqual(
    harness.store.getGroupMembers(chat.id, "replyteam").map((member) => member.id),
    [202],
  );

  const meSelection = await harness.useCases.tagSet({
    chat,
    matchText: "ops me @bob",
    requesterId: alice.id,
  });
  assert.equal(firstText(meSelection), "Saved @ops with 2 members.");
  assert.deepEqual(
    harness.store.getGroupMembers(chat.id, "ops").map((member) => member.id),
    [101, 202],
  );
});

test("tagAdd, tagRemove, and tagDelete manage group membership errors and success", async () => {
  const harness = createHarness();
  await seedMembers(harness, [alice, bob, carol]);
  await harness.store.upsertGroup(chat.id, "ops", [alice.id, bob.id]);

  assert.match(
    firstText(
      await harness.useCases.tagAdd({
        chat,
        matchText: "",
        requesterId: alice.id,
      }),
    ),
    /^Usage: \/tagadd/,
  );
  assert.equal(
    firstText(
      await harness.useCases.tagAdd({
        chat,
        matchText: "ops @missing",
        requesterId: alice.id,
      }),
    ),
    "I could not resolve: @missing.",
  );
  assert.equal(
    firstText(
      await harness.useCases.tagAdd({
        chat,
        matchText: "ops",
        requesterId: alice.id,
      }),
    ),
    "No users selected.",
  );

  const added = await harness.useCases.tagAdd({
    chat,
    matchText: "ops @carol",
    requesterId: alice.id,
  });
  assert.equal(firstText(added), "Updated @ops. It now has 3 members.");

  assert.match(
    firstText(
      await harness.useCases.tagRemove({
        chat,
        matchText: "",
        requesterId: alice.id,
      }),
    ),
    /^Usage: \/tagremove/,
  );
  assert.equal(
    firstText(
      await harness.useCases.tagRemove({
        chat,
        matchText: "ops @missing",
        requesterId: alice.id,
      }),
    ),
    "I could not resolve: @missing.",
  );
  assert.equal(
    firstText(
      await harness.useCases.tagRemove({
        chat,
        matchText: "ops",
        requesterId: alice.id,
      }),
    ),
    "No users selected.",
  );
  assert.equal(
    firstText(
      await harness.useCases.tagRemove({
        chat,
        matchText: "missing @alice",
        requesterId: alice.id,
      }),
    ),
    "That group does not exist.",
  );

  const removed = await harness.useCases.tagRemove({
    chat,
    matchText: "ops @bob",
    requesterId: alice.id,
  });
  assert.equal(firstText(removed), "Updated @ops. It now has 2 members.");

  assert.equal(
    firstText(
      await harness.useCases.tagDelete({
        chat,
        matchText: "",
        requesterId: alice.id,
      }),
    ),
    "Usage: /tagdelete <group-name>",
  );
  assert.equal(
    firstText(
      await harness.useCases.tagDelete({
        chat,
        matchText: "missing",
        requesterId: alice.id,
      }),
    ),
    "That group does not exist.",
  );
  assert.equal(
    firstText(
      await harness.useCases.tagDelete({
        chat,
        matchText: "ops",
        requesterId: alice.id,
      }),
    ),
    "Deleted @ops.",
  );
});

test("saveDraftAsGroup validates commands, drafts, empty selections, and saved screens", async () => {
  const harness = createHarness();
  await seedMembers(harness, [alice, bob]);

  const usage = await harness.useCases.saveDraftAsGroupCommand({
    chat,
    ownerId: alice.id,
    matchText: "",
  });
  assert.equal(firstText(usage), "Usage: /tagname <group-name>");

  const invalid = await harness.useCases.saveDraftAsGroup({
    chatId: chat.id,
    ownerId: alice.id,
    rawGroupName: "@",
  });
  assert.equal(
    firstText(invalid),
    "Invalid subgroup name. Use 2-32 characters: letters, numbers, _ or -.",
  );

  const noDraft = await harness.useCases.saveDraftAsGroup({
    chatId: chat.id,
    ownerId: alice.id,
    rawGroupName: "ops",
  });
  assert.equal(firstText(noDraft), "No active subgroup draft. Start one with /manage.");

  harness.drafts.create(chat.id, alice.id);
  const emptyDraft = await harness.useCases.saveDraftAsGroup({
    chatId: chat.id,
    ownerId: alice.id,
    rawGroupName: "ops",
  });
  assert.equal(firstText(emptyDraft), "Select at least one member before saving.");

  harness.drafts.create(chat.id, alice.id, [alice.id, bob.id]);
  const saved = await harness.useCases.saveDraftAsGroupCommand({
    chat,
    ownerId: alice.id,
    matchText: "@Ops",
  });
  assert.match(firstText(saved), /<b>@ops<\/b>/);
  assert.deepEqual(
    harness.store.getGroupMembers(chat.id, "ops").map((member) => member.id),
    [101, 202],
  );
});

test("resolveInlinePing returns help, errors, context-aware pings, and too-large fallbacks", async () => {
  const harness = createHarness();

  const wrongType = harness.useCases.resolveInlinePing({
    query: "all",
    userId: alice.id,
    chatType: "private",
  });
  assert.equal(wrongType.results[0]?.id, "1000000-id1");
  assert.equal(wrongType.results[0]?.title, "Use this in a group");

  const blank = harness.useCases.resolveInlinePing({
    query: "",
    userId: alice.id,
  });
  assert.equal(blank.results[0]?.id, "help");
  assert.equal(blank.results[0]?.inputMessageContent.parseMode, "HTML");

  const invalid = harness.useCases.resolveInlinePing({
    query: "all now",
    userId: alice.id,
  });
  assert.equal(invalid.results[0]?.title, "Use all or a subgroup");

  const noGroups = harness.useCases.resolveInlinePing({
    query: "all",
    userId: alice.id,
  });
  assert.equal(noGroups.results[0]?.title, "No tracked groups yet");

  await seedMembers(harness, [alice, bob], chat);
  await seedMembers(harness, [alice], otherChat);
  await harness.store.upsertGroup(chat.id, "ops", [bob.id]);
  harness.inlineContexts.remember(alice.id, chat.id);

  const all = harness.useCases.resolveInlinePing({
    query: "all",
    userId: alice.id,
  });
  assert.equal(all.results[0]?.title, "Ping everyone in Alpha Team");
  assert.match(all.results[0]?.inputMessageContent.messageText ?? "", /^@here /);

  const group = harness.useCases.resolveInlinePing({
    query: "@ops",
    userId: alice.id,
  });
  assert.equal(group.results[0]?.title, "Ping @ops in Alpha Team");
  assert.match(group.results[0]?.inputMessageContent.messageText ?? "", /^@ops /);

  const unknown = harness.useCases.resolveInlinePing({
    query: "missing",
    userId: alice.id,
  });
  assert.equal(unknown.results[0]?.title, "Unknown subgroup");
  assert.equal(unknown.results[0]?.description, "I could not find @missing");

  await harness.store.upsertGroup(chat.id, "empty", []);
  const empty = harness.useCases.resolveInlinePing({
    query: "empty",
    userId: alice.id,
  });
  assert.equal(empty.results[0]?.title, "Unknown or empty subgroup");
  assert.match(empty.results[0]?.inputMessageContent.messageText ?? "", /non-empty subgroup/);

  const largeHarness = createHarness();
  const manyMembers = Array.from({ length: 120 }, (_, index) => user(1_000 + index));
  await seedMembers(largeHarness, [alice, ...manyMembers], chat);
  largeHarness.inlineContexts.remember(alice.id, chat.id);
  const large = largeHarness.useCases.resolveInlinePing({
    query: "all",
    userId: alice.id,
  });
  assert.equal(large.results[0]?.title, "Too many members for inline mode");
  assert.match(large.results[0]?.inputMessageContent.messageText ?? "", /too large/);
});

test("manageDraftAction handles callback preconditions, navigation, group pings, and deletes", async () => {
  const harness = createHarness();

  const wrongChat = await harness.useCases.manageDraftAction({
    action: { kind: "home", chatId: chat.id },
    currentChat: otherChat,
    actorId: alice.id,
  });
  assert.equal(wrongChat.answer?.text, "Open the manager from inside the target group.");
  assert.equal(wrongChat.answer?.showAlert, true);

  const unregistered = await harness.useCases.manageDraftAction({
    action: { kind: "home", chatId: chat.id },
    currentChat: chat,
    actorId: alice.id,
  });
  assert.equal(unregistered.answer?.text, "This group is not registered yet. Run /bind first.");

  await seedMembers(harness, [alice, bob]);
  await harness.store.upsertGroup(chat.id, "ops", [bob.id]);
  await harness.store.upsertGroup(chat.id, "empty", []);

  const home = await harness.useCases.manageDraftAction({
    action: parseManagerAction(managerCallbacks.home(chat.id))!,
    currentChat: chat,
    actorId: alice.id,
  });
  assert.match(home.editMessage?.text ?? "", /Alpha Team/);

  const members = await harness.useCases.manageDraftAction({
    action: { kind: "members", chatId: chat.id, page: 0 },
    currentChat: chat,
    actorId: alice.id,
  });
  assert.match(members.editMessage?.text ?? "", /Alpha Team Members/);

  const groups = await harness.useCases.manageDraftAction({
    action: { kind: "groups", chatId: chat.id, page: 0 },
    currentChat: chat,
    actorId: alice.id,
  });
  assert.match(groups.editMessage?.text ?? "", /Alpha Team Subgroups/);

  const missingGroupView = await harness.useCases.manageDraftAction({
    action: { kind: "groupView", chatId: chat.id, groupKey: "missing", page: 0 },
    currentChat: chat,
    actorId: alice.id,
  });
  assert.equal(missingGroupView.answer?.text, "That subgroup no longer exists.");
  assert.match(missingGroupView.editMessage?.text ?? "", /Subgroups/);

  const groupView = await harness.useCases.manageDraftAction({
    action: { kind: "groupView", chatId: chat.id, groupKey: "ops", page: 0 },
    currentChat: chat,
    actorId: alice.id,
  });
  assert.match(groupView.editMessage?.text ?? "", /<b>@ops<\/b>/);

  const emptyPing = await harness.useCases.manageDraftAction({
    action: { kind: "groupPing", chatId: chat.id, groupKey: "empty" },
    currentChat: chat,
    actorId: alice.id,
  });
  assert.equal(emptyPing.answer?.text, "That subgroup is empty.");

  const ping = await harness.useCases.manageDraftAction({
    action: { kind: "groupPing", chatId: chat.id, groupKey: "ops" },
    currentChat: chat,
    actorId: alice.id,
  });
  assert.match(ping.messages[0]?.text ?? "", /^@ops /);

  const pingCooldown = await harness.useCases.manageDraftAction({
    action: { kind: "groupPing", chatId: chat.id, groupKey: "ops" },
    currentChat: chat,
    actorId: alice.id,
  });
  assert.equal(pingCooldown.answer?.text, "Wait 1 minute before sending the same ping again.");

  const pingAll = await harness.useCases.manageDraftAction({
    action: { kind: "pingAll", chatId: chat.id },
    currentChat: chat,
    actorId: bob.id,
  });
  assert.match(pingAll.messages[0]?.text ?? "", /^@here /);

  const deleted = await harness.useCases.manageDraftAction({
    action: { kind: "groupDelete", chatId: chat.id, groupKey: "ops", page: 0 },
    currentChat: chat,
    actorId: alice.id,
  });
  assert.equal(deleted.answer?.text, "Deleted @ops");
  assert.match(deleted.editMessage?.text ?? "", /Subgroups/);

  const alreadyDeleted = await harness.useCases.manageDraftAction({
    action: { kind: "groupDelete", chatId: chat.id, groupKey: "ops", page: 0 },
    currentChat: chat,
    actorId: alice.id,
  });
  assert.equal(alreadyDeleted.answer?.text, "That subgroup was already removed.");
});

test("manageDraftAction handles draft create, edit, view, toggle, save, prompt, and cancel", async () => {
  const harness = createHarness();
  await seedMembers(harness, [alice, bob]);
  await harness.store.upsertGroup(chat.id, "ops", [bob.id]);

  const noActor = await harness.useCases.manageDraftAction({
    action: { kind: "draftNew", chatId: chat.id },
    currentChat: chat,
  });
  assert.equal(noActor.answer?.text, "Only human users can manage subgroup drafts.");

  const draftNew = await harness.useCases.manageDraftAction({
    action: { kind: "draftNew", chatId: chat.id },
    currentChat: chat,
    actorId: alice.id,
  });
  assert.match(draftNew.editMessage?.text ?? "", /New subgroup draft/);

  const emptySave = await harness.useCases.manageDraftAction({
    action: { kind: "draftSave", chatId: chat.id },
    currentChat: chat,
    actorId: alice.id,
  });
  assert.equal(emptySave.answer?.text, "Select at least one member before saving.");

  const toggled = await harness.useCases.manageDraftAction({
    action: { kind: "draftToggle", chatId: chat.id, page: 0, memberId: alice.id },
    currentChat: chat,
    actorId: alice.id,
  });
  assert.match(toggled.editMessage?.text ?? "", /Selected members: <b>1<\/b>/);

  const promptForName = await harness.useCases.manageDraftAction({
    action: { kind: "draftSave", chatId: chat.id },
    currentChat: chat,
    actorId: alice.id,
  });
  assert.equal(
    promptForName.answer?.text,
    "Send the subgroup name as your next message in this group.",
  );
  assert.match(
    promptForName.editMessage?.text ?? "",
    /Send the subgroup name as your next message/,
  );

  const expiredView = await harness.useCases.manageDraftAction({
    action: { kind: "draftView", chatId: chat.id, page: 1 },
    currentChat: chat,
    actorId: bob.id,
  });
  assert.equal(expiredView.answer?.text, "That draft expired. Start again from New Subgroup.");
  assert.match(expiredView.editMessage?.text ?? "", /Alpha Team/);

  const expiredToggle = await harness.useCases.manageDraftAction({
    action: { kind: "draftToggle", chatId: chat.id, page: 0, memberId: alice.id },
    currentChat: chat,
    actorId: bob.id,
  });
  assert.equal(expiredToggle.answer?.text, "That draft expired. Start again from New Subgroup.");
  assert.equal(expiredToggle.editMessage, undefined);

  const missingEdit = await harness.useCases.manageDraftAction({
    action: { kind: "draftEdit", chatId: chat.id, groupKey: "missing", page: 0 },
    currentChat: chat,
    actorId: alice.id,
  });
  assert.equal(missingEdit.answer?.text, "That subgroup no longer exists.");
  assert.match(missingEdit.editMessage?.text ?? "", /Subgroups/);

  const draftEdit = await harness.useCases.manageDraftAction({
    action: { kind: "draftEdit", chatId: chat.id, groupKey: "ops", page: 0 },
    currentChat: chat,
    actorId: alice.id,
  });
  assert.match(draftEdit.editMessage?.text ?? "", /Editing: <code>@ops<\/code>/);

  const view = await harness.useCases.manageDraftAction({
    action: { kind: "draftView", chatId: chat.id, page: 0 },
    currentChat: chat,
    actorId: alice.id,
  });
  assert.match(view.editMessage?.text ?? "", /Subgroup Builder/);

  const saved = await harness.useCases.manageDraftAction({
    action: { kind: "draftSave", chatId: chat.id },
    currentChat: chat,
    actorId: alice.id,
  });
  assert.equal(saved.answer?.text, "Saved @ops");
  assert.match(saved.editMessage?.text ?? "", /<b>@ops<\/b>/);

  harness.drafts.create(chat.id, alice.id, [alice.id], "solo");
  const cancelled = await harness.useCases.manageDraftAction({
    action: { kind: "draftCancel", chatId: chat.id },
    currentChat: chat,
    actorId: alice.id,
  });
  assert.equal(cancelled.answer?.text, "Draft cleared.");
  assert.match(cancelled.editMessage?.text ?? "", /Alpha Team/);
  assert.equal(harness.drafts.get(chat.id, alice.id), null);
});
