import type { HereBotPresentation } from "../../../application/use-cases/here-bot.js";
import {
  buildDraftScreen,
  buildGroupScreen,
  buildGroupsScreen,
  buildHomeScreen,
  buildMembersScreen,
} from "./manager-screens.js";
import { buildMentionChunks } from "./mentions.js";

export const telegramPresentation: HereBotPresentation = {
  buildHomeScreen,
  buildMembersScreen,
  buildGroupsScreen,
  buildGroupScreen,
  buildDraftScreen,
  buildMentionChunks,
};
