import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import type {
  ChatRepository,
  GroupChatInput,
  UserInput,
} from "./application/ports/chat-repository.js";
import { FakeChatRepository } from "./application/testing/fake-chat-repository.js";
import { JsonStore } from "./infrastructure/persistence/json-store.js";

interface RepositoryCase {
  name: string;
  create: () => Promise<ChatRepository>;
}

const alphaChat: GroupChatInput = { id: -1001, type: "group", title: "Alpha Chat" };
const betaChat: GroupChatInput = { id: -1002, type: "group", title: "Beta Chat" };

function user(id: number, firstName: string, lastName?: string, username?: string): UserInput {
  return {
    id,
    is_bot: false,
    first_name: firstName,
    last_name: lastName,
    username,
  };
}

async function tempJsonFile(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "here-bot-repository-contract-"));
  return path.join(directory, "store.json");
}

async function createJsonStore(): Promise<ChatRepository> {
  const store = new JsonStore(await tempJsonFile());
  await store.init();
  return store;
}

async function createFakeRepository(): Promise<ChatRepository> {
  const repository = new FakeChatRepository();
  await repository.init();
  return repository;
}

async function seedMembers(repository: ChatRepository): Promise<void> {
  await repository.ensureChat(alphaChat);
  await repository.upsertMember(alphaChat, user(101, "Alice", "Example", "alice"));
  await repository.upsertMember(alphaChat, user(202, "Bob", "Example", "bob"));
  await repository.upsertMember(alphaChat, user(303, "Cara"));
}

const repositoryCases: RepositoryCase[] = [
  { name: "JsonStore", create: createJsonStore },
  { name: "FakeChatRepository", create: createFakeRepository },
];

for (const repositoryCase of repositoryCases) {
  test(`${repositoryCase.name} contract: init starts with no chats`, async () => {
    const repository = await repositoryCase.create();

    assert.deepEqual(repository.listChats(), []);
    assert.deepEqual(repository.getMembers(-1001), []);
    assert.deepEqual(repository.listGroups(-1001), []);
  });

  test(`${repositoryCase.name} contract: creates, updates, and looks up chats`, async () => {
    const repository = await repositoryCase.create();
    const created = await repository.ensureChat({
      id: -1002,
      type: "group",
      title: "  Beta Chat  ",
    });

    assert.equal(created.id, -1002);
    assert.equal(created.type, "group");
    assert.equal(created.title, "Beta Chat");
    assert.match(created.workspaceKey, /^[a-z0-9][a-z0-9_-]+$/);

    const updated = await repository.ensureChat({
      id: -1002,
      type: "supergroup",
      title: "Renamed Chat",
    });

    assert.equal(updated.type, "supergroup");
    assert.equal(updated.title, "Renamed Chat");
    assert.equal(updated.workspaceKey, created.workspaceKey);
    assert.equal(repository.getChat(-1002)?.workspaceKey, created.workspaceKey);
    assert.equal(
      repository.getChatByWorkspaceKey(` ${updated.workspaceKey.toUpperCase()} `)?.id,
      -1002,
    );
    assert.equal(repository.getChatByWorkspaceKey("missing"), null);

    const defaultTitle = await repository.ensureChat({ id: -1003, type: "group" });
    assert.equal(defaultTitle.title, "chat--1003");

    await repository.ensureChat(alphaChat);
    assert.deepEqual(
      repository.listChats().map((chat) => chat.title),
      ["Alpha Chat", "chat--1003", "Renamed Chat"],
    );

    await assert.rejects(
      repository.ensureChat({ id: 1, type: "private", title: "Private Chat" }),
      /only supports groups and supergroups/,
    );
  });

  test(`${repositoryCase.name} contract: tracks members and member chat recency`, async () => {
    const repository = await repositoryCase.create();

    await repository.upsertMember(
      { id: -9999, type: "group", title: "Bot Chat" },
      {
        id: 404,
        is_bot: true,
        first_name: "Helper",
        username: "helper_bot",
      },
    );
    assert.equal(repository.getChat(-9999), null);

    await repository.ensureChat(alphaChat);
    await repository.ensureChat(betaChat);
    await repository.upsertMember(alphaChat, user(101, "Alice", "Example", "alice"));
    await sleep(10);
    await repository.upsertMember(betaChat, user(101, "Alice", "Example", "alice"));
    await repository.upsertMember(alphaChat, user(202, "Bob", "Example", "bob"));
    await repository.upsertMember(alphaChat, user(303, "", undefined, "cara"));

    assert.deepEqual(
      repository.getMembers(alphaChat.id).map((member) => member.displayName),
      ["Alice Example", "Bob Example", "cara"],
    );
    assert.deepEqual(
      repository.listChatsForMember(101).map((chat) => chat.title),
      ["Alpha Chat", "Beta Chat"],
    );
    assert.deepEqual(
      repository.listChatsForMemberByRecency(101).map((chat) => chat.title),
      ["Beta Chat", "Alpha Chat"],
    );
    assert.deepEqual(repository.listChatsForMember(999), []);

    const firstSeenAt = repository.getChat(alphaChat.id)?.members["101"]?.lastSeenAt;
    await sleep(10);
    await repository.upsertMember(alphaChat, user(101, "Alice", "Example", "alice"));
    const secondSeenAt = repository.getChat(alphaChat.id)?.members["101"]?.lastSeenAt;

    assert.ok(firstSeenAt);
    assert.ok(secondSeenAt);
    assert.notEqual(secondSeenAt, firstSeenAt);

    assert.equal(await repository.removeMember(-9999, 101), false);
    assert.equal(await repository.removeMember(alphaChat.id, 999), false);
    assert.equal(await repository.removeMember(alphaChat.id, 202), true);
    assert.equal(repository.getChat(alphaChat.id)?.members["202"], undefined);
  });

  test(`${repositoryCase.name} contract: manages groups and group members`, async () => {
    const repository = await repositoryCase.create();
    await seedMembers(repository);

    assert.deepEqual(repository.getGroupMembers(alphaChat.id, "missing"), []);
    assert.deepEqual(repository.getGroupMembers(-9999, "ops"), []);
    assert.equal(await repository.upsertGroup(-9999, "ops", [101]), null);
    assert.equal(await repository.upsertGroup(alphaChat.id, "@ops", [101]), null);
    assert.equal(
      await repository.upsertGroup(alphaChat.id, "Ops-Team", [202, 101, 101, 999]),
      "ops-team",
    );
    assert.deepEqual(repository.getGroup(alphaChat.id, "OPS-team")?.memberIds, [202, 101]);
    assert.deepEqual(
      repository.getGroupMembers(alphaChat.id, "ops-team").map((member) => member.id),
      [101, 202],
    );

    const createdAt = repository.getGroup(alphaChat.id, "ops-team")?.createdAt;
    await sleep(10);
    assert.equal(
      await repository.addToGroup(alphaChat.id, "ops-team", [202, 303, 999]),
      "ops-team",
    );
    assert.deepEqual(repository.getGroup(alphaChat.id, "ops-team")?.memberIds, [202, 101, 303]);
    assert.equal(repository.getGroup(alphaChat.id, "ops-team")?.createdAt, createdAt);

    assert.equal(await repository.addToGroup(alphaChat.id, "new-group", [101]), "new-group");
    assert.equal(await repository.addToGroup(-9999, "new-group", [101]), null);
    assert.deepEqual(repository.getGroup(alphaChat.id, "new-group")?.memberIds, [101]);
    assert.equal(
      await repository.removeFromGroup(alphaChat.id, "ops-team", [202, 999]),
      "ops-team",
    );
    assert.deepEqual(repository.getGroup(alphaChat.id, "ops-team")?.memberIds, [101, 303]);
    assert.equal(await repository.removeFromGroup(alphaChat.id, "missing", [101]), null);

    await repository.upsertGroup(alphaChat.id, "zz", [303]);
    await repository.upsertGroup(alphaChat.id, "aa", [101]);
    assert.deepEqual(
      repository.listGroups(alphaChat.id).map((group) => group.key),
      ["aa", "new-group", "ops-team", "zz"],
    );

    assert.equal(await repository.removeMember(alphaChat.id, 101), true);
    assert.deepEqual(repository.getGroup(alphaChat.id, "ops-team")?.memberIds, [303]);

    assert.equal(await repository.deleteGroup(alphaChat.id, "OPS-team"), true);
    assert.equal(repository.getGroup(alphaChat.id, "ops-team"), null);
    assert.equal(await repository.deleteGroup(alphaChat.id, "ops-team"), false);
    assert.equal(await repository.deleteGroup(alphaChat.id, "@bad"), false);
    assert.equal(await repository.deleteGroup(-9999, "aa"), false);
  });
}
