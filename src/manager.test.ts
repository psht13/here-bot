import test from "node:test";
import assert from "node:assert/strict";

import {
  buildDraftScreen,
  buildGroupScreen,
  buildGroupsScreen,
  buildHomeScreen,
  buildMembersScreen,
} from "./adapters/telegram/presenters/manager-screens.js";
import { managerCallbacks, parseManagerAction } from "./application/callbacks/manager-callbacks.js";
import { DraftRegistry, type DraftState } from "./application/services/draft-registry.js";
import type { KnownChat, KnownMember, MentionGroup } from "./domain/models.js";

function chat(overrides: Partial<KnownChat> = {}): KnownChat {
  return {
    id: -1001,
    type: "group",
    title: "Alpha & <Beta>",
    workspaceKey: "alpha-beta",
    members: {},
    groups: {},
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function member(index: number, overrides: Partial<KnownMember> = {}): KnownMember {
  return {
    id: 100 + index,
    displayName: `Member ${index}`,
    username: `member_${index}`,
    isBot: false,
    lastSeenAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function members(count: number): KnownMember[] {
  return Array.from({ length: count }, (_, index) => member(index + 1));
}

function group(key: string, memberCount: number): MentionGroup {
  return {
    key,
    label: key,
    memberIds: Array.from({ length: memberCount }, (_, index) => 100 + index),
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function draft(overrides: Partial<DraftState> = {}): DraftState {
  return {
    chatId: -1001,
    userId: 55,
    memberIds: [],
    page: 0,
    awaitingName: false,
    updatedAt: 1_000,
    ...overrides,
  };
}

test("parseManagerAction reads compact callback payloads", () => {
  const action = parseManagerAction("gv:-1001234567890:gang:2");

  assert.deepEqual(action, {
    kind: "groupView",
    chatId: -1001234567890,
    groupKey: "gang",
    page: 2,
  });
});

test("parseManagerAction reads every generated callback shape", () => {
  assert.deepEqual(parseManagerAction(managerCallbacks.home(-1001)), {
    kind: "home",
    chatId: -1001,
  });
  assert.deepEqual(parseManagerAction(managerCallbacks.pingAll(-1001)), {
    kind: "pingAll",
    chatId: -1001,
  });
  assert.deepEqual(parseManagerAction(managerCallbacks.members(-1001, 2)), {
    kind: "members",
    chatId: -1001,
    page: 2,
  });
  assert.deepEqual(parseManagerAction(managerCallbacks.groups(-1001, 3)), {
    kind: "groups",
    chatId: -1001,
    page: 3,
  });
  assert.deepEqual(parseManagerAction(managerCallbacks.groupView(-1001, "Ops_Team", 4)), {
    kind: "groupView",
    chatId: -1001,
    groupKey: "ops_team",
    page: 4,
  });
  assert.deepEqual(parseManagerAction(managerCallbacks.groupPing(-1001, "Ops_Team")), {
    kind: "groupPing",
    chatId: -1001,
    groupKey: "ops_team",
  });
  assert.deepEqual(parseManagerAction(managerCallbacks.groupDelete(-1001, "Ops_Team", 5)), {
    kind: "groupDelete",
    chatId: -1001,
    groupKey: "ops_team",
    page: 5,
  });
  assert.deepEqual(parseManagerAction(managerCallbacks.draftNew(-1001)), {
    kind: "draftNew",
    chatId: -1001,
  });
  assert.deepEqual(parseManagerAction(managerCallbacks.draftEdit(-1001, "Ops_Team", 6)), {
    kind: "draftEdit",
    chatId: -1001,
    groupKey: "ops_team",
    page: 6,
  });
  assert.deepEqual(parseManagerAction(managerCallbacks.draftView(-1001, 7)), {
    kind: "draftView",
    chatId: -1001,
    page: 7,
  });
  assert.deepEqual(parseManagerAction(managerCallbacks.draftToggle(-1001, 8, 202)), {
    kind: "draftToggle",
    chatId: -1001,
    page: 8,
    memberId: 202,
  });
  assert.deepEqual(parseManagerAction(managerCallbacks.draftSave(-1001)), {
    kind: "draftSave",
    chatId: -1001,
  });
  assert.deepEqual(parseManagerAction(managerCallbacks.draftCancel(-1001)), {
    kind: "draftCancel",
    chatId: -1001,
  });
});

test("parseManagerAction rejects invalid numbers, pages, and group keys", () => {
  assert.equal(parseManagerAction("hm:not-a-number"), null);
  assert.equal(parseManagerAction("hm:9007199254740992"), null);
  assert.equal(parseManagerAction("ml:-1001:-1"), null);
  assert.equal(parseManagerAction("gl:-1001:nope"), null);
  assert.equal(parseManagerAction("dt:-1001:0:not-a-member"), null);
  assert.equal(parseManagerAction("gp:-1001:@ops"), null);
  assert.equal(parseManagerAction("gv:-1001:a:0"), null);
  assert.equal(parseManagerAction("de:-1001:bad key:0"), null);
  assert.equal(parseManagerAction("unknown:-1001"), null);
});

test("parseManagerAction preserves current handling of negative chats and extra segments", () => {
  assert.deepEqual(parseManagerAction("hm:-42:ignored"), {
    kind: "home",
    chatId: -42,
  });
  assert.deepEqual(parseManagerAction("gv:-1001234567890:Ops-Team:2:ignored"), {
    kind: "groupView",
    chatId: -1001234567890,
    groupKey: "ops-team",
    page: 2,
  });
});

test("DraftRegistry tracks a per-user draft lifecycle", () => {
  const drafts = new DraftRegistry();
  const draft = drafts.create(-1001, 55, [101], "gang");

  assert.deepEqual(draft.memberIds, [101]);
  assert.equal(draft.groupKey, "gang");

  const toggledOff = drafts.toggle(-1001, 55, 101, new Set([101, 202]));
  assert.ok(toggledOff);
  assert.deepEqual(toggledOff.memberIds, []);

  const toggledOn = drafts.toggle(-1001, 55, 202, new Set([101, 202]));
  assert.ok(toggledOn);
  assert.deepEqual(toggledOn.memberIds, [202]);

  const renamed = drafts.setGroupKey(-1001, 55, "crew");
  assert.ok(renamed);
  assert.equal(renamed.groupKey, "crew");

  drafts.clear(-1001, 55);
  assert.equal(drafts.get(-1001, 55), null);
});

test("DraftRegistry characterizes invalid toggles, page clamping, naming, and clear", (t) => {
  let now = 1_000;
  t.mock.method(Date, "now", () => now);

  const drafts = new DraftRegistry();
  const draft = drafts.create(-1001, 55, [101, 101, 202], "gang");

  assert.deepEqual(draft.memberIds, [101, 202]);
  assert.equal(draft.updatedAt, 1_000);

  now = 2_000;
  const fetched = drafts.get(-1001, 55);
  assert.ok(fetched);
  assert.equal(fetched.updatedAt, 2_000);

  assert.equal(drafts.toggle(-1001, 55, 303, new Set([101, 202])), null);
  assert.deepEqual(fetched.memberIds, [101, 202]);
  assert.equal(drafts.toggle(-1001, 99, 101, new Set([101, 202])), null);

  const toggled = drafts.toggle(-1001, 55, 101, new Set([101, 202]));
  assert.ok(toggled);
  assert.deepEqual(toggled.memberIds, [202]);

  const clampedPage = drafts.setPage(-1001, 55, -4);
  assert.ok(clampedPage);
  assert.equal(clampedPage.page, 0);

  const laterPage = drafts.setPage(-1001, 55, 12);
  assert.ok(laterPage);
  assert.equal(laterPage.page, 12);
  assert.equal(drafts.setPage(-1001, 99, 1), null);

  const prompted = drafts.promptForName(-1001, 55);
  assert.ok(prompted);
  assert.equal(prompted.awaitingName, true);
  assert.equal(drafts.promptForName(-1001, 99), null);

  assert.equal(drafts.setGroupKey(-1001, 55, "@bad"), null);
  assert.equal(prompted.groupKey, "gang");
  assert.equal(prompted.awaitingName, true);

  const renamed = drafts.setGroupKey(-1001, 55, "Ops-Team");
  assert.ok(renamed);
  assert.equal(renamed.groupKey, "ops-team");
  assert.equal(renamed.awaitingName, false);

  drafts.clear(-1001, 55);
  assert.equal(drafts.get(-1001, 55), null);
});

test("DraftRegistry drops stale drafts during garbage collection", (t) => {
  let now = 1_000;
  t.mock.method(Date, "now", () => now);

  const drafts = new DraftRegistry();
  drafts.create(-1001, 55, [101], "gang");

  now += 30 * 60 * 1000 + 1;
  drafts.create(-1001, 56, [202], "ops");

  assert.equal(drafts.get(-1001, 55), null);
  assert.deepEqual(drafts.get(-1001, 56)?.memberIds, [202]);
});

test("DraftRegistry preserves exact ttl boundary and expires after it", (t) => {
  let now = 1_000;
  t.mock.method(Date, "now", () => now);

  const drafts = new DraftRegistry();
  drafts.create(-1001, 55, [101], "gang");

  now += 30 * 60 * 1000;
  const boundaryDraft = drafts.get(-1001, 55);
  assert.ok(boundaryDraft);
  assert.deepEqual(boundaryDraft.memberIds, [101]);

  now += 30 * 60 * 1000 + 1;
  assert.equal(drafts.get(-1001, 55), null);
});

test("manager home screen escapes chat titles and renders counts", () => {
  const screen = buildHomeScreen(chat(), 3, 2);

  assert.match(screen.text, /Alpha &amp; &lt;Beta&gt;/);
  assert.match(screen.text, /Tracked members: <b>3<\/b>/);
  assert.match(screen.text, /Custom groups: <b>2<\/b>/);
});

test("members screen handles empty state and paginated member lists", () => {
  const empty = buildMembersScreen(chat(), [], 9);
  const firstPage = buildMembersScreen(chat(), members(7), 0);
  const clampedPage = buildMembersScreen(chat(), members(7), 99);

  assert.match(empty.text, /No tracked members yet/);
  assert.match(firstPage.text, /Page 1\/2/);
  assert.match(firstPage.text, /- Member 1 \(@member_1\)/);
  assert.match(clampedPage.text, /Page 2\/2/);
  assert.match(clampedPage.text, /- Member 7 \(@member_7\)/);
  assert.doesNotMatch(clampedPage.text, /Member 1/);
});

test("groups screen handles empty state and paginated group lists", () => {
  const empty = buildGroupsScreen(chat(), [], 0);
  const savedGroups = [
    group("alpha", 1),
    group("bravo", 2),
    group("charlie", 3),
    group("delta", 4),
    group("echo", 5),
    group("foxtrot", 6),
    group("very-long-group-key-01", 7),
  ];
  const firstPage = buildGroupsScreen(chat(), savedGroups, 0);
  const clampedPage = buildGroupsScreen(chat(), savedGroups, 99);

  assert.match(empty.text, /No custom groups yet/);
  assert.match(firstPage.text, /Page 1\/2/);
  assert.match(firstPage.text, /- @alpha \(1 members\)/);
  assert.match(clampedPage.text, /Page 2\/2/);
  assert.match(clampedPage.text, /- @very-long-group-key-01 \(7 members\)/);
  assert.doesNotMatch(clampedPage.text, /@alpha/);
});

test("group screen renders empty, populated, and overflow member previews", () => {
  const empty = buildGroupScreen(chat(), group("ops", 0), [], 0);
  const populated = buildGroupScreen(chat(), group("ops", 13), members(13), 1);

  assert.match(empty.text, /This subgroup is empty/);
  assert.match(populated.text, /Members: <b>13<\/b>/);
  assert.match(populated.text, /- Member 12 \(@member_12\)/);
  assert.match(populated.text, /- \+1 more members/);
  assert.doesNotMatch(populated.text, /Member 13/);
});

test("draft screen renders new, naming, and edit states", () => {
  const empty = buildDraftScreen(chat(), draft(), []);
  const naming = buildDraftScreen(chat(), draft({ awaitingName: true }), members(7));
  const editing = buildDraftScreen(
    chat(),
    draft({
      groupKey: "ops",
      memberIds: members(9).map((knownMember) => knownMember.id),
      page: 99,
    }),
    members(10),
  );

  assert.match(empty.text, /No tracked members are available yet/);
  assert.match(empty.text, /No one selected yet/);
  assert.match(naming.text, /Send the subgroup name as your next message/);
  assert.match(editing.text, /Editing: <code>@ops<\/code>/);
  assert.match(editing.text, /Selected members: <b>9<\/b> of <b>10<\/b>/);
  assert.match(editing.text, /Page 2\/2/);
  assert.match(editing.text, /- \+1 more selected/);
});
