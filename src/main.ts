import "dotenv/config";

import { pathToFileURL } from "node:url";

import { Bot } from "grammy";

import { randomIdGenerator, systemClock } from "./application/ports/system.js";
import { DraftRegistry } from "./application/services/draft-registry.js";
import { InlineContextService } from "./application/services/inline-context.js";
import { PingCooldownRegistry } from "./application/services/ping-cooldown.js";
import {
  registerTelegramCommands,
  registerTelegramHandlers,
  TELEGRAM_ALLOWED_UPDATES,
} from "./adapters/telegram/telegram.js";
import { loadEnv } from "./config/env.js";
import { JsonStore } from "./infrastructure/persistence/json-store.js";

export async function main(input: NodeJS.ProcessEnv = process.env): Promise<void> {
  const env = loadEnv(input);
  const store = new JsonStore(env.DATA_FILE);
  const drafts = new DraftRegistry();
  const pingCooldowns = new PingCooldownRegistry();
  const inlineContexts = new InlineContextService(systemClock);
  const bot = new Bot(env.BOT_TOKEN);

  registerTelegramHandlers(bot, {
    store,
    drafts,
    pingCooldowns,
    inlineContexts,
    clock: systemClock,
    idGenerator: randomIdGenerator,
    botUsername: env.BOT_USERNAME,
  });

  await store.init();
  await registerTelegramCommands(bot);

  await bot.start({
    allowed_updates: [...TELEGRAM_ALLOWED_UPDATES],
    onStart: (botInfo) => {
      console.log(`Running @${botInfo.username} with data file ${env.DATA_FILE}`);
    },
  });
}

function isDirectRun(): boolean {
  const entrypoint = process.argv[1];

  return Boolean(entrypoint && import.meta.url === pathToFileURL(entrypoint).href);
}

if (isDirectRun()) {
  void main();
}
