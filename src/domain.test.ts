import test from "node:test";
import assert from "node:assert/strict";

import {
  normalizeKey,
  parseMentionPingRequest,
  parsePingRequest,
  planMentionChunks,
  resolveMemberRefs,
} from "./domain/index.js";
import type { KnownMember } from "./domain/models.js";

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

function knownMember(id: number, displayName: string, username?: string): KnownMember {
  return {
    id,
    displayName,
    username,
    isBot: false,
    lastSeenAt: "2026-01-01T00:00:00.000Z",
  };
}

test("normalizeKey characterizes length, casing, and invalid prefixes", () => {
  const maxLengthKey = `a${"b".repeat(31)}`;

  assert.equal(normalizeKey("a"), null);
  assert.equal(normalizeKey("ab"), "ab");
  assert.equal(normalizeKey(maxLengthKey), maxLengthKey);
  assert.equal(normalizeKey(`${maxLengthKey}c`), null);
  assert.equal(normalizeKey("Gang_1"), "gang_1");
  assert.equal(normalizeKey("  Ops-Team  "), "ops-team");
  assert.equal(normalizeKey("_bad"), null);
  assert.equal(normalizeKey("-bad"), null);
  assert.equal(normalizeKey("bad space"), null);
  assert.equal(normalizeKey("@gang"), null);
});

test("resolveMemberRefs dedupes refs and preserves unresolved inputs", () => {
  const result = resolveMemberRefs(
    members,
    ["@ALICE", "101", "@alice", "202", "202", "@missing", "nobody", "999", ""],
    [303, 101, 303],
  );

  assert.deepEqual(result.ids, [303, 101, 202]);
  assert.deepEqual(result.unresolved, ["@missing", "nobody", "999"]);
});

test("planMentionChunks returns no chunks for empty members", () => {
  assert.deepEqual(
    planMentionChunks("here", [], {
      maxLength: 10,
      getMemberReferenceLength: () => 1,
    }),
    [],
  );
});

test("planMentionChunks keeps a member at the exact chunk boundary", () => {
  const first = knownMember(1, "First");
  const second = knownMember(2, "Second");
  const chunks = planMentionChunks("edge", [first, second], {
    maxLength: 10,
    getMemberReferenceLength: (member) => (member.id === 1 ? 4 : 1),
  });

  assert.deepEqual(chunks, [
    { label: "edge", members: [first] },
    { label: "edge", members: [second] },
  ]);
});

test("planMentionChunks preserves overflow behavior for an oversized first member", () => {
  const oversized = knownMember(999, "Long");
  const chunks = planMentionChunks("long", [oversized], {
    maxLength: 10,
    getMemberReferenceLength: () => 100,
  });

  assert.deepEqual(chunks, [
    { label: "long", members: [] },
    { label: "long", members: [oversized] },
  ]);
});

test("planMentionChunks keeps non-empty members in at least one chunk", () => {
  const chunks = planMentionChunks("here", members, {
    maxLength: 100,
    getMemberReferenceLength: () => 10,
  });

  assert.equal(chunks.length, 1);
  assert.deepEqual(chunks[0]?.members, members);
});

test("parsePingRequest accepts only all or one subgroup token", () => {
  assert.deepEqual(parsePingRequest("all"), { kind: "all" });
  assert.deepEqual(parsePingRequest("  ALL  "), { kind: "all" });
  assert.deepEqual(parsePingRequest("Gang-1"), {
    kind: "group",
    groupKey: "gang-1",
  });
  assert.deepEqual(parsePingRequest("@Gang_1"), {
    kind: "group",
    groupKey: "gang_1",
  });
  assert.deepEqual(parsePingRequest("@all"), {
    kind: "group",
    groupKey: "all",
  });
  assert.equal(parsePingRequest("tag gang"), null);
  assert.equal(parsePingRequest("gang now"), null);
  assert.equal(parsePingRequest("@"), null);
  assert.equal(parsePingRequest("a"), null);
  assert.equal(parsePingRequest(""), null);
});

test("parseMentionPingRequest requires a direct bot mention prefix", () => {
  assert.deepEqual(parseMentionPingRequest("@HereBot all", "hereBot"), {
    kind: "all",
  });
  assert.deepEqual(parseMentionPingRequest("@herebot ops-team", "hereBot"), {
    kind: "group",
    groupKey: "ops-team",
  });
  assert.deepEqual(parseMentionPingRequest(" \n@HEREBOT\t@Ops_Team ", "hereBot"), {
    kind: "group",
    groupKey: "ops_team",
  });
  assert.equal(parseMentionPingRequest("hello @herebot all", "hereBot"), null);
  assert.equal(parseMentionPingRequest("@someoneelse all", "hereBot"), null);
  assert.equal(parseMentionPingRequest("@herebot", "hereBot"), null);
  assert.equal(parseMentionPingRequest("@herebot all now", "hereBot"), null);
  assert.equal(parseMentionPingRequest("@herebot @", "hereBot"), null);
});
