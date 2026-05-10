import test from "node:test";
import assert from "node:assert/strict";

import type { KnownMember } from "../../../domain/models.js";
import { buildMention, buildMentionChunks, escapeHtml } from "./mentions.js";

const MAX_MESSAGE_LENGTH = 3900;

function knownMember(id: number, displayName: string, username?: string): KnownMember {
  return {
    id,
    displayName,
    username,
    isBot: false,
    lastSeenAt: "2026-01-01T00:00:00.000Z",
  };
}

test("escapeHtml preserves the Telegram HTML escaping contract", () => {
  assert.equal(
    escapeHtml('Alice & Bob <Ops> "Team"'),
    "Alice &amp; Bob &lt;Ops&gt; &quot;Team&quot;",
  );
});

test("buildMention renders the exact Telegram user link", () => {
  assert.equal(
    buildMention(knownMember(101, 'Alice & Bob <Ops> "Team"')),
    '<a href="tg://user?id=101">Alice &amp; Bob &lt;Ops&gt; &quot;Team&quot;</a>',
  );
});

test("buildMentionChunks renders the exact single-chunk mention text", () => {
  assert.deepEqual(
    buildMentionChunks("here", [
      knownMember(101, 'Alice & Bob <Ops> "Team"'),
      knownMember(202, "Bob Example"),
    ]),
    [
      '@here <a href="tg://user?id=101">Alice &amp; Bob &lt;Ops&gt; &quot;Team&quot;</a> <a href="tg://user?id=202">Bob Example</a>',
    ],
  );
});

test("buildMentionChunks keeps a member at the exact chunk boundary", () => {
  const heading = "@edge";
  const mentionEnvelopeLength = ` <a href="tg://user?id=1"></a>`.length;
  const exactBoundaryName = "x".repeat(MAX_MESSAGE_LENGTH - heading.length - mentionEnvelopeLength);
  const chunks = buildMentionChunks("edge", [
    knownMember(1, exactBoundaryName),
    knownMember(2, "Next Member"),
  ]);

  assert.equal(chunks.length, 2);
  assert.equal(chunks[0], `@edge <a href="tg://user?id=1">${exactBoundaryName}</a>`);
  assert.equal(chunks[0]?.length, MAX_MESSAGE_LENGTH);
  assert.equal(chunks[1], '@edge <a href="tg://user?id=2">Next Member</a>');
});

test("buildMentionChunks preserves oversized first-member behavior exactly", () => {
  const rawName = `<${"A".repeat(MAX_MESSAGE_LENGTH)}&">`;
  const chunks = buildMentionChunks("long", [knownMember(999, rawName)]);

  assert.deepEqual(chunks, [
    "@long",
    `@long <a href="tg://user?id=999">&lt;${"A".repeat(MAX_MESSAGE_LENGTH)}&amp;&quot;&gt;</a>`,
  ]);
});
