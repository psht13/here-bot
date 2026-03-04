import test from "node:test";
import assert from "node:assert/strict";

import { DraftRegistry, parseManagerAction } from "./manager.js";

test("parseManagerAction reads compact callback payloads", () => {
  const action = parseManagerAction("gv:-1001234567890:gang:2");

  assert.deepEqual(action, {
    kind: "groupView",
    chatId: -1001234567890,
    groupKey: "gang",
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
