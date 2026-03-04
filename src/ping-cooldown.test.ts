import test from "node:test";
import assert from "node:assert/strict";

import {
  formatPingCooldownMessage,
  PingCooldownRegistry,
} from "./ping-cooldown.js";

test("PingCooldownRegistry enforces cooldowns per chat, user, and label", () => {
  const cooldowns = new PingCooldownRegistry();
  const start = 1_000;

  assert.equal(cooldowns.reserve(-1001, 10, "here", start), 0);
  assert.equal(cooldowns.reserve(-1001, 10, "here", start + 20_000), 40_000);

  assert.equal(cooldowns.reserve(-1001, 11, "here", start + 20_000), 0);
  assert.equal(cooldowns.reserve(-1001, 10, "ops", start + 20_000), 0);
  assert.equal(cooldowns.reserve(-1001, 10, "here", start + 60_000), 0);
});

test("formatPingCooldownMessage renders short and minute-long waits", () => {
  assert.equal(
    formatPingCooldownMessage(5_100),
    "Wait 6s before sending the same ping again.",
  );
  assert.equal(
    formatPingCooldownMessage(60_000),
    "Wait 1 minute before sending the same ping again.",
  );
});
