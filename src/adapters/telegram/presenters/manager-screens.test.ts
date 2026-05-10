import test from "node:test";
import assert from "node:assert/strict";

import type { DraftState } from "../../../application/services/draft-registry.js";
import type { KnownChat, KnownMember, MentionGroup } from "../../../domain/models.js";
import {
  buildDraftScreen,
  buildGroupScreen,
  buildGroupsScreen,
  buildHomeScreen,
  buildMembersScreen,
} from "./manager-screens.js";

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

test("buildHomeScreen renders exact Telegram HTML text", () => {
  assert.equal(
    buildHomeScreen(chat(), 3, 2).text,
    [
      "<b>Alpha &amp; &lt;Beta&gt;</b>",
      "Tracked members: <b>3</b>",
      "Custom groups: <b>2</b>",
      "",
      "Use the buttons below to ping everyone, browse members, and manage subgroups.",
    ].join("\n"),
  );
});

test("buildMembersScreen renders exact Telegram HTML text", () => {
  assert.equal(
    buildMembersScreen(chat(), [member(1), member(2)], 0).text,
    [
      "<b>Alpha &amp; &lt;Beta&gt; Members</b>",
      "Tracked members: <b>2</b>",
      "Page 1/1",
      "",
      "- Member 1 (@member_1)",
      "- Member 2 (@member_2)",
    ].join("\n"),
  );
});

test("buildGroupsScreen renders exact Telegram HTML text", () => {
  assert.equal(
    buildGroupsScreen(chat(), [group("ops", 2)], 0).text,
    [
      "<b>Alpha &amp; &lt;Beta&gt; Subgroups</b>",
      "Custom groups: <b>1</b>",
      "Page 1/1",
      "",
      "- @ops (2 members)",
    ].join("\n"),
  );
});

test("buildGroupScreen renders exact Telegram HTML text", () => {
  assert.equal(
    buildGroupScreen(chat(), group("ops", 2), [member(1), member(2)], 0).text,
    [
      "<b>@ops</b> in <b>Alpha &amp; &lt;Beta&gt;</b>",
      "Members: <b>2</b>",
      "",
      "- Member 1 (@member_1)",
      "- Member 2 (@member_2)",
    ].join("\n"),
  );
});

test("buildDraftScreen renders exact Telegram HTML text", () => {
  assert.equal(
    buildDraftScreen(
      chat(),
      draft({
        groupKey: "ops",
        memberIds: [101, 103],
      }),
      [member(1), member(2), member(3)],
    ).text,
    [
      "<b>Subgroup Builder</b> for <b>Alpha &amp; &lt;Beta&gt;</b>",
      "Editing: <code>@ops</code>",
      "Selected members: <b>2</b> of <b>3</b>",
      "Page 1/1",
      "",
      "Tap members below to toggle them.",
      "Press Save to update this subgroup.",
      "",
      "Currently selected:",
      "- Member 1 (@member_1)",
      "- Member 3 (@member_3)",
    ].join("\n"),
  );
});
