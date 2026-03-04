import test from "node:test";
import assert from "node:assert/strict";

import {
  buildMentionChunks,
  normalizeKey,
  resolveMemberRefs,
} from "./domain.js";
import type { KnownMember } from "./models.js";

const members: KnownMember[] = [
  {
    id: 101,
    displayName: "Alice Example",
    username: "alice",
    isBot: false,
    lastSeenAt: "2026-01-01T00:00:00.000Z",
  },
  {
    id: 202,
    displayName: "Bob Example",
    username: "bob",
    isBot: false,
    lastSeenAt: "2026-01-01T00:00:00.000Z",
  },
];

test("normalizeKey accepts safe keys and rejects invalid ones", () => {
  assert.equal(normalizeKey("Gang_1"), "gang_1");
  assert.equal(normalizeKey("a"), null);
  assert.equal(normalizeKey("bad space"), null);
});

test("resolveMemberRefs resolves usernames, ids, and reports misses", () => {
  const result = resolveMemberRefs(members, ["@alice", "202", "@missing"], [202]);

  assert.deepEqual(result.ids.sort((a, b) => a - b), [101, 202]);
  assert.deepEqual(result.unresolved, ["@missing"]);
});

test("buildMentionChunks keeps the heading and emits at least one chunk", () => {
  const chunks = buildMentionChunks("here", members);
  const firstChunk = chunks[0];

  assert.equal(chunks.length, 1);
  assert.ok(firstChunk);
  assert.match(firstChunk, /^@here /);
  assert.match(firstChunk, /tg:\/\/user\?id=101/);
  assert.match(firstChunk, /tg:\/\/user\?id=202/);
});
