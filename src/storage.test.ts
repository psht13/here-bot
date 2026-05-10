import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import type { KnownChat, KnownMember, MentionGroup, PersistedData } from "./domain/models.js";
import { JsonStore } from "./infrastructure/persistence/json-store.js";

function member(
  id: number,
  displayName: string,
  username?: string,
  lastSeenAt = "2026-01-01T00:00:00.000Z",
): KnownMember {
  const known: KnownMember = {
    id,
    displayName,
    isBot: false,
    lastSeenAt,
  };

  if (username !== undefined) {
    known.username = username;
  }

  return known;
}

function chat(overrides: Partial<KnownChat> = {}): KnownChat {
  return {
    id: -1001,
    type: "group",
    title: "Alpha Chat",
    workspaceKey: "alpha-chat",
    members: {},
    groups: {},
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

async function tempJsonFile(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "here-bot-json-store-"));
  return path.join(directory, "store.json");
}

async function readPersisted(filePath: string): Promise<PersistedData> {
  return JSON.parse(await readFile(filePath, "utf8")) as PersistedData;
}

async function initializedStoreWithMembers(): Promise<JsonStore> {
  const filePath = await tempJsonFile();
  const store = new JsonStore(filePath);

  await store.init();
  await store.ensureChat({ id: -1001, type: "group", title: "Alpha Chat" });
  await store.upsertMember(
    { id: -1001, type: "group", title: "Alpha Chat" },
    {
      id: 101,
      is_bot: false,
      first_name: "Alice",
      last_name: "Example",
      username: "alice",
    },
  );
  await store.upsertMember(
    { id: -1001, type: "group", title: "Alpha Chat" },
    {
      id: 202,
      is_bot: false,
      first_name: "Bob",
      last_name: "Example",
      username: "bob",
    },
  );
  await store.upsertMember(
    { id: -1001, type: "group", title: "Alpha Chat" },
    {
      id: 303,
      is_bot: false,
      first_name: "Cara",
    },
  );

  return store;
}

test("JsonStore init creates a missing file with empty data", async () => {
  const filePath = await tempJsonFile();
  const store = new JsonStore(filePath);

  await store.init();

  assert.deepEqual(store.listChats(), []);
  assert.deepEqual(await readPersisted(filePath), { chats: {} });
});

test("JsonStore init treats a missing chats field as empty data", async () => {
  const filePath = await tempJsonFile();

  await writeFile(filePath, JSON.stringify({}), "utf8");

  const store = new JsonStore(filePath);
  await store.init();

  assert.deepEqual(store.listChats(), []);
  assert.deepEqual(store.getMembers(-1001), []);
  assert.deepEqual(store.listGroups(-1001), []);
});

test("JsonStore init accepts existing partial chat data", async () => {
  const filePath = await tempJsonFile();

  await writeFile(
    filePath,
    JSON.stringify({
      chats: {
        "-1001": {
          id: -1001,
          type: "group",
          title: "Partial Chat",
          workspaceKey: "partial-chat",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      },
    }),
    "utf8",
  );

  const store = new JsonStore(filePath);
  await store.init();

  const storedChat = store.getChat(-1001);
  assert.ok(storedChat);
  assert.equal(storedChat.title, "Partial Chat");
  assert.deepEqual(storedChat.members, {});
  assert.deepEqual(storedChat.groups, {});
});

test("JsonStore init accepts unknown extra fields without changing known data", async () => {
  const filePath = await tempJsonFile();
  const memberWithExtra: KnownMember & { memberExtra: string } = {
    ...member(101, "Alice Example", "alice"),
    memberExtra: "kept",
  };
  const groupWithExtra: MentionGroup & { groupExtra: string } = {
    key: "ops",
    label: "ops",
    memberIds: [101],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    groupExtra: "kept",
  };

  await writeFile(
    filePath,
    JSON.stringify({
      rootExtra: true,
      chats: {
        "-1001": {
          ...chat({
            members: {
              "101": memberWithExtra,
            },
            groups: {
              ops: groupWithExtra,
            },
          }),
          chatExtra: "kept",
        },
      },
    }),
    "utf8",
  );

  const store = new JsonStore(filePath);
  await store.init();

  const storedChat = store.getChat(-1001);
  const storedMember = storedChat?.members["101"];
  const storedGroup = store.getGroup(-1001, "ops");

  assert.equal(storedChat?.title, "Alpha Chat");
  assert.equal((storedChat as unknown as Record<string, unknown> | null)?.chatExtra, "kept");
  assert.equal(storedMember?.displayName, "Alice Example");
  assert.equal((storedMember as unknown as Record<string, unknown> | undefined)?.memberExtra, "kept");
  assert.deepEqual(storedGroup?.memberIds, [101]);
  assert.equal((storedGroup as unknown as Record<string, unknown> | null)?.groupExtra, "kept");
});

test("JsonStore init propagates malformed persisted data", async () => {
  const filePath = await tempJsonFile();

  await writeFile(filePath, "{not json", "utf8");

  const store = new JsonStore(filePath);

  await assert.rejects(store.init(), SyntaxError);
});

test("JsonStore init validates persisted known fields", async () => {
  const filePath = await tempJsonFile();

  await writeFile(
    filePath,
    JSON.stringify({
      chats: {
        "-1001": {
          ...chat(),
          members: {
            "101": {
              ...member(101, "Alice Example", "alice"),
              id: "101",
            },
          },
        },
      },
    }),
    "utf8",
  );

  const store = new JsonStore(filePath);

  await assert.rejects(
    store.init(),
    (error) => error instanceof Error && error.name === "ZodError",
  );
});

test("JsonStore ensureChat creates and updates supported chats", async () => {
  const filePath = await tempJsonFile();
  const store = new JsonStore(filePath);

  await store.init();
  const created = await store.ensureChat({
    id: -1001,
    type: "group",
    title: "  Alpha Chat  ",
  });

  assert.equal(created.id, -1001);
  assert.equal(created.type, "group");
  assert.equal(created.title, "Alpha Chat");
  assert.match(created.workspaceKey, /^[a-z0-9][a-z0-9_-]+$/);

  const updated = await store.ensureChat({
    id: -1001,
    type: "supergroup",
    title: "Renamed Chat",
  });

  assert.equal(updated.type, "supergroup");
  assert.equal(updated.title, "Renamed Chat");
  assert.equal(updated.workspaceKey, created.workspaceKey);
  await assert.rejects(
    store.ensureChat({ id: 1, type: "private", title: "Private Chat" }),
    /only supports groups and supergroups/,
  );
});

test("JsonStore upsertMember ignores bots and removes members from groups", async () => {
  const filePath = await tempJsonFile();
  const store = new JsonStore(filePath);

  await store.init();
  await store.upsertMember(
    { id: -1001, type: "group", title: "Alpha Chat" },
    {
      id: 999,
      is_bot: true,
      first_name: "Helper",
      username: "helper_bot",
    },
  );

  assert.equal(store.getChat(-1001), null);

  await store.ensureChat({ id: -1001, type: "group", title: "Alpha Chat" });
  await store.upsertMember(
    { id: -1001, type: "group", title: "Alpha Chat" },
    {
      id: 101,
      is_bot: false,
      first_name: "Alice",
      last_name: "Example",
      username: "alice",
    },
  );
  await store.upsertMember(
    { id: -1001, type: "group", title: "Alpha Chat" },
    {
      id: 202,
      is_bot: false,
      first_name: "Bob",
    },
  );
  await store.upsertGroup(-1001, "ops", [101, 202]);

  assert.equal(store.getChat(-1001)?.members["101"]?.displayName, "Alice Example");
  assert.equal(store.getChat(-1001)?.members["101"]?.username, "alice");
  assert.equal(store.getChat(-1001)?.members["202"]?.displayName, "Bob");

  await store.upsertMember(
    { id: -1001, type: "group", title: "Alpha Chat" },
    {
      id: 101,
      is_bot: false,
      first_name: "Alice",
      last_name: "Example",
      username: "alice",
    },
  );

  assert.equal(await store.removeMember(-1001, 101), true);
  assert.equal(store.getChat(-1001)?.members["101"], undefined);
  assert.deepEqual(store.getGroup(-1001, "ops")?.memberIds, [202]);
  assert.equal(await store.removeMember(-1001, 101), false);
  assert.equal(await store.removeMember(-9999, 101), false);
});

test("JsonStore manages groups and lists them by key", async () => {
  const store = await initializedStoreWithMembers();

  assert.deepEqual(store.getGroupMembers(-1001, "missing"), []);
  assert.deepEqual(store.getGroupMembers(-9999, "ops"), []);
  assert.equal(await store.upsertGroup(-9999, "ops", [101]), null);
  assert.equal(await store.upsertGroup(-1001, "@ops", [101]), null);
  assert.equal(await store.upsertGroup(-1001, "Ops-Team", [101, 101, 999, 202]), "ops-team");
  assert.deepEqual(store.getGroup(-1001, "OPS-team")?.memberIds, [101, 202]);
  assert.deepEqual(
    store.getGroupMembers(-1001, "ops-team").map((known) => known.id),
    [101, 202],
  );

  assert.equal(await store.addToGroup(-1001, "ops-team", [202, 303, 999]), "ops-team");
  assert.deepEqual(store.getGroup(-1001, "ops-team")?.memberIds, [101, 202, 303]);

  assert.equal(await store.removeFromGroup(-1001, "ops-team", [101, 999]), "ops-team");
  assert.deepEqual(store.getGroup(-1001, "ops-team")?.memberIds, [202, 303]);
  assert.equal(await store.removeFromGroup(-1001, "missing", [202]), null);
  assert.equal(await store.addToGroup(-1001, "new-group", [101]), "new-group");
  assert.deepEqual(store.getGroup(-1001, "new-group")?.memberIds, [101]);

  await store.upsertGroup(-1001, "zz", [303]);
  await store.upsertGroup(-1001, "aa", [101]);
  assert.deepEqual(
    store.listGroups(-1001).map((group) => group.key),
    ["aa", "new-group", "ops-team", "zz"],
  );
  assert.deepEqual(store.listGroups(-9999), []);

  assert.equal(await store.deleteGroup(-1001, "OPS-team"), true);
  assert.equal(store.getGroup(-1001, "ops-team"), null);
  assert.equal(await store.deleteGroup(-1001, "ops-team"), false);
  assert.equal(await store.deleteGroup(-1001, "@bad"), false);
  assert.equal(await store.deleteGroup(-9999, "aa"), false);
});

test("JsonStore preserves empty groups", async () => {
  const store = await initializedStoreWithMembers();

  assert.equal(await store.upsertGroup(-1001, "empty-group", []), "empty-group");

  assert.deepEqual(store.getGroup(-1001, "empty-group")?.memberIds, []);
  assert.deepEqual(store.getGroupMembers(-1001, "empty-group"), []);
  assert.deepEqual(
    store.listGroups(-1001).map((group) => group.key),
    ["empty-group"],
  );
});

test("JsonStore removeMember removes member IDs from every group", async () => {
  const store = await initializedStoreWithMembers();

  assert.equal(await store.upsertGroup(-1001, "ops", [101, 202]), "ops");
  assert.equal(await store.upsertGroup(-1001, "qa", [303, 101]), "qa");
  assert.equal(await store.removeMember(-1001, 101), true);

  assert.equal(store.getChat(-1001)?.members["101"], undefined);
  assert.deepEqual(store.getGroup(-1001, "ops")?.memberIds, [202]);
  assert.deepEqual(store.getGroup(-1001, "qa")?.memberIds, [303]);
});

test("JsonStore preserves group member order when removing by lookup set", async () => {
  const store = await initializedStoreWithMembers();

  assert.equal(await store.upsertGroup(-1001, "ops", [303, 101, 202]), "ops");
  assert.equal(await store.removeFromGroup(-1001, "ops", [101, 999]), "ops");
  assert.deepEqual(store.getGroup(-1001, "ops")?.memberIds, [303, 202]);
});

test("JsonStore lists chats for a member by last-seen recency", async () => {
  const filePath = await tempJsonFile();
  const data: PersistedData = {
    chats: {
      "-1001": chat({
        id: -1001,
        title: "Older Chat",
        workspaceKey: "older-chat",
        members: {
          "42": member(42, "Shared User", "shared", "2026-01-02T00:00:00.000Z"),
        },
      }),
      "-1002": chat({
        id: -1002,
        title: "Newest Chat",
        workspaceKey: "newest-chat",
        members: {
          "42": member(42, "Shared User", "shared", "2026-01-03T00:00:00.000Z"),
        },
      }),
      "-1003": chat({
        id: -1003,
        title: "Other User Chat",
        workspaceKey: "other-user-chat",
        members: {
          "99": member(99, "Someone Else", "other", "2026-01-04T00:00:00.000Z"),
        },
      }),
    },
  };

  await writeFile(filePath, JSON.stringify(data), "utf8");

  const store = new JsonStore(filePath);
  await store.init();

  assert.equal(store.getChatByWorkspaceKey(" NEWEST-CHAT ")?.id, -1002);
  assert.equal(store.getChatByWorkspaceKey("missing"), null);
  assert.deepEqual(
    store.listChats().map((storedChat) => storedChat.title),
    ["Newest Chat", "Older Chat", "Other User Chat"],
  );
  assert.deepEqual(
    store.listChatsForMember(42).map((storedChat) => storedChat.title),
    ["Newest Chat", "Older Chat"],
  );
  assert.deepEqual(
    store.listChatsForMemberByRecency(42).map((storedChat) => storedChat.title),
    ["Newest Chat", "Older Chat"],
  );
});

test("JsonStore indexed member-chat lookups preserve title order and stable recency ties", async () => {
  const filePath = await tempJsonFile();
  const data: PersistedData = {
    chats: {
      "-2002": chat({
        id: -2002,
        title: "Beta Chat",
        workspaceKey: "beta-chat",
        members: {
          "42": member(42, "Shared User", "shared", "2026-01-02T00:00:00.000Z"),
        },
      }),
      "-3003": chat({
        id: -3003,
        title: "Gamma Chat",
        workspaceKey: "gamma-chat",
        members: {
          "42": member(42, "Shared User", "shared", "2026-01-03T00:00:00.000Z"),
        },
      }),
      "-1001": chat({
        id: -1001,
        title: "Alpha Chat",
        workspaceKey: "alpha-chat",
        members: {
          "42": member(42, "Shared User", "shared", "2026-01-03T00:00:00.000Z"),
        },
      }),
      "-4004": chat({
        id: -4004,
        title: "Delta Chat",
        workspaceKey: "delta-chat",
        members: {
          "99": member(99, "Other User", "other", "2026-01-04T00:00:00.000Z"),
        },
      }),
    },
  };

  await writeFile(filePath, JSON.stringify(data), "utf8");

  const store = new JsonStore(filePath);
  await store.init();

  assert.deepEqual(
    store.listChatsForMember(42).map((storedChat) => storedChat.title),
    ["Alpha Chat", "Beta Chat", "Gamma Chat"],
  );
  assert.deepEqual(
    store.listChatsForMemberByRecency(42).map((storedChat) => storedChat.title),
    ["Alpha Chat", "Gamma Chat", "Beta Chat"],
  );
});

test("JsonStore workspace index keeps first persisted duplicate lookup behavior", async () => {
  const filePath = await tempJsonFile();
  const data: PersistedData = {
    chats: {
      "-1001": chat({
        id: -1001,
        title: "First Shared",
        workspaceKey: "shared-key",
      }),
      "-1002": chat({
        id: -1002,
        title: "Second Shared",
        workspaceKey: "shared-key",
      }),
    },
  };

  await writeFile(filePath, JSON.stringify(data), "utf8");

  const store = new JsonStore(filePath);
  await store.init();

  assert.equal(store.getChatByWorkspaceKey(" SHARED-KEY ")?.id, -1001);
});

test("JsonStore keeps unchanged-member lastSeenAt in memory until a later commit", async () => {
  const filePath = await tempJsonFile();
  const store = new JsonStore(filePath);
  const chatInput = { id: -1001, type: "group", title: "Alpha Chat" };
  const userInput = {
    id: 101,
    is_bot: false,
    first_name: "Alice",
    last_name: "Example",
    username: "alice",
  };

  await store.init();
  await store.upsertMember(chatInput, userInput);

  const firstSeenAt = store.getChat(-1001)?.members["101"]?.lastSeenAt;
  const firstPersistedSeenAt = (await readPersisted(filePath)).chats["-1001"]?.members["101"]
    ?.lastSeenAt;

  assert.ok(firstSeenAt);
  assert.equal(firstPersistedSeenAt, firstSeenAt);

  await sleep(10);
  await store.upsertMember(chatInput, userInput);

  const secondSeenAt = store.getChat(-1001)?.members["101"]?.lastSeenAt;
  const unchangedPersistedSeenAt = (await readPersisted(filePath)).chats["-1001"]?.members["101"]
    ?.lastSeenAt;

  assert.ok(secondSeenAt);
  assert.notEqual(secondSeenAt, firstSeenAt);
  assert.equal(unchangedPersistedSeenAt, firstPersistedSeenAt);

  await store.upsertGroup(-1001, "ops", [101]);

  const laterPersistedSeenAt = (await readPersisted(filePath)).chats["-1001"]?.members["101"]
    ?.lastSeenAt;

  assert.equal(laterPersistedSeenAt, secondSeenAt);
});

test("JsonStore successful writes do not leave temp files", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "here-bot-json-store-"));
  const filePath = path.join(directory, "store.json");
  const store = new JsonStore(filePath);

  await store.init();
  await store.ensureChat({ id: -1001, type: "group", title: "Alpha Chat" });

  assert.deepEqual((await readdir(directory)).sort(), ["store.json"]);
});
