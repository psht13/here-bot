# here-bot repo audit and Codex implementation prompts

Repository: https://github.com/psht13/here-bot

Goal: refactor to onion/layer architecture, improve test coverage to 90%+, optimize code safely, and preserve current behavior.

## Static audit summary

This was a static audit based on repository file inspection, not a runtime verification.

Overall, the repo is in a good place for a small Telegram bot, but it is not yet structured for long-term maintainability, high coverage, or onion architecture. The biggest issue is that `src/index.ts` acts as a god module: it parses env, creates singletons, wires the Grammy bot, owns command handlers, inline handling, manager callbacks, cooldowns, draft saving, message rendering, and persistence calls.

The current tooling is minimal: TypeScript, `node:test`, `tsx`, `grammy`, `dotenv`, and `zod`; scripts exist for `dev`, `build`, `check`, `start`, and `test`, but not for linting, formatting, CI, or coverage thresholds. The TypeScript config is a strong point because it already enables `strict`, `noUncheckedIndexedAccess`, and `exactOptionalPropertyTypes`.

## What is already good

- The pure helpers in `domain.ts` are easy to test: key normalization, HTML escaping, mention chunking, ping parsing, and member reference resolution are separated from Telegram I/O.
- The data model is straightforward: `KnownMember`, `MentionGroup`, `KnownChat`, and `PersistedData` are simple and understandable.
- `JsonStore` uses a queued write chain and atomic temp-file rename, which is a good baseline for single-process JSON persistence.
- `manager.ts` is partly separated from `index.ts` and already contains mostly pure UI-screen builders plus callback parsing and draft state.
- There are initial regression tests for domain parsing/chunking and manager draft/callback behavior.

## Main architecture problems

The repo currently has a “script with helper modules” architecture, not onion architecture. The dependency direction should become:

```text
domain -> application -> infrastructure/adapters -> main composition root
```

Right now, `index.ts` directly depends on Grammy, env, store implementation, cooldown registry, draft registry, manager rendering, command logic, inline logic, and Telegram response formatting. That makes behavior hard to test without Telegram-shaped mocks.

The domain layer also mixes a few concerns. For example, mention rendering uses Telegram HTML links, so that belongs closer to an application presenter or Telegram adapter, not core domain. The real domain concepts are members, chats, groups, ping requests, validation, and membership resolution.

The storage class exposes mutable internal objects through methods like `getChat`. That makes accidental mutation possible without a commit. It is manageable in a small app, but it is risky once more handlers and services are added.

The persistence layer mutates memory before committing to disk. That is common in simple stores, but it means failed writes can leave memory and disk divergent. Add tests for this behavior before changing it.

`upsertMember` updates `lastSeenAt` and `chat.updatedAt` in memory, but skips commit when display name and username have not changed. That may mean the new `lastSeenAt` is not persisted on disk. This is likely a bug, but changing it is technically a behavior change. First add a characterization test that locks the current behavior, then decide whether to fix it in a separate behavior-changing PR.

## Efficiency notes

Most current inefficiencies are acceptable for a small group bot, but they are easy to clean up while refactoring.

- `listChatsForMemberByRecency` sorts chats and then filters/sorts by recency. Fine for small data, but it can become noisy on every inline query.
- `getChatByWorkspaceKey` linearly scans chats. Fine now, but a store-level index would be cleaner.
- `DraftRegistry.gc`, `PingCooldownRegistry.gc`, and inline context cleanup scan the full map during normal operations. Fine for small scale, but a throttled cleanup or TTL-cache wrapper would be better.
- `removeFromGroup` uses `includes` inside `filter`; switch to a `Set` for O(n) removal.
- Some handlers recompute values like `store.getMembers(chat.id)` multiple times in one command. Cache the local result.
- `removeMember` calls `new Date().toISOString()` repeatedly during one logical operation. Use one `nowIso` per operation for consistency.
- `buildMentionChunks` uses a fixed max length and string length. Add tests for very long display names and boundary chunking. Do not silently change chunk behavior until tests capture current behavior.

## Code standards gaps

There is no lint script, no formatter script, no coverage gate, and no CI workflow visible from the inspected files. The current test script uses Node’s test runner with `tsx`, which is fine, but there is no coverage threshold.

For the stated goal, add:

- ESLint
- Prettier
- coverage threshold
- CI
- architecture-boundary tests

## Recommended target architecture

Suggested structure:

```text
src/
  main.ts                         # composition root only

  config/
    env.ts                        # zod env parsing

  domain/
    models.ts                     # domain entities/types
    group-key.ts                  # normalizeKey, validation
    ping-request.ts               # parsePingRequest, parseMentionPingRequest
    mentions.ts                   # pure mention chunk planning, no Grammy
    member-resolution.ts          # resolveMemberRefs

  application/
    ports/
      chat-repository.ts
      clock.ts
      id-generator.ts
    services/
      ping-service.ts
      tag-service.ts
      draft-service.ts
      inline-context-service.ts
      cooldown-service.ts
    use-cases/
      bind-chat.ts
      track-message-members.ts
      ping-chat.ts
      manage-tags.ts
      resolve-inline-query.ts

  infrastructure/
    persistence/
      json-chat-repository.ts
      persisted-schema.ts

  adapters/
    telegram/
      bot-factory.ts
      commands/
        bind-command.ts
        here-command.ts
        tag-commands.ts
        manage-command.ts
      callbacks/
        manager-callback-router.ts
      inline/
        inline-query-handler.ts
      presenters/
        telegram-mention-presenter.ts
        manager-screens.ts
      context/
        telegram-context-utils.ts

  testing/
    fakes/
      fake-chat-repository.ts
      fake-clock.ts
      fake-id-generator.ts
```

Dependency rules:

```text
domain: no imports from application, infrastructure, adapters, grammy, fs, dotenv
application: imports domain and ports only
infrastructure: implements application ports
adapters: depends on application services and framework APIs
main: wires everything together
```

# Codex prompts

Use these in order. They are intentionally split into small PR-sized steps so Codex does not rewrite the whole repo at once.

---

## Prompt 1 - Add characterization tests before refactoring

```text
You are working in https://github.com/psht13/here-bot.

Goal: add characterization tests for current behavior before any architecture refactor. Do not change production behavior.

Tasks:
1. Keep the existing node:test + tsx setup.
2. Add tests for:
   - normalizeKey edge cases: length, uppercase normalization, invalid leading character, spaces, @ prefix rejection.
   - parsePingRequest and parseMentionPingRequest edge cases.
   - buildMentionChunks with empty members, HTML escaping, chunk boundary behavior, and a very long displayName.
   - resolveMemberRefs with duplicate refs, username case-insensitivity, numeric ids, unresolved refs, and "extraIds".
   - PingCooldownRegistry reserve/expiry behavior using explicit now values.
   - DraftRegistry lifecycle, invalid toggles, setPage clamping, promptForName, setGroupKey invalid names, clear.
   - parseManagerAction behavior for valid callbacks, invalid numbers, negative chat IDs, extra callback segments, invalid pages, invalid group keys.
   - JsonStore init with missing file, existing partial data, ensureChat, upsertMember, removeMember, upsertGroup, addToGroup, removeFromGroup, deleteGroup, listGroups, listChatsForMemberByRecency.
3. Use temporary directories/files for JsonStore tests.
4. Do not make assertions based on Telegram network behavior.
5. Keep all current production files behavior-compatible.
6. Run:
   - npm run check
   - npm test
   - npm run build
7. Return a summary of files changed and any behavior that appears surprising but was preserved.
```

---

## Prompt 2 - Add coverage, lint, format, and CI gates

```text
You are working in https://github.com/psht13/here-bot.

Goal: add quality gates without changing runtime behavior.

Tasks:
1. Add a coverage script requiring at least 90% lines, branches, and functions for src production files.
   - Keep node:test unless there is a strong reason to change.
   - Exclude test files from coverage.
2. Add ESLint for TypeScript with sensible strict rules.
3. Add Prettier or a minimal formatting script.
4. Add npm scripts:
   - lint
   - format
   - test:coverage
   - ci
5. ci should run typecheck, lint, tests with coverage, and build.
6. Add a GitHub Actions workflow on push and pull_request using Node 22 and npm ci.
7. Do not change bot behavior.
8. Run all new scripts locally and fix failures.
9. Return the exact commands run and final status.
```

---

## Prompt 3 - Split config and composition root from bot registration

```text
You are working in https://github.com/psht13/here-bot.

Goal: separate environment parsing and bot composition from handler implementation. No behavior changes.

Tasks:
1. Create src/config/env.ts:
   - export Env type
   - export loadEnv(input: NodeJS.ProcessEnv): Env
   - preserve the current zod validation messages and DATA_FILE default.
2. Create src/main.ts as the composition root:
   - load env
   - create JsonStore
   - create DraftRegistry
   - create PingCooldownRegistry
   - create Bot
   - register handlers
   - init store
   - register commands
   - start bot
3. Convert src/index.ts into either:
   - a thin re-export/compat entry, or
   - move its logic into adapters/telegram/bot-factory.ts and update package scripts.
4. Introduce createTelegramBotApp(deps) or registerTelegramHandlers(bot, deps), so tests can register handlers without parsing env or starting the bot.
5. No import of dotenv/config outside main/composition.
6. Do not change command text, callback data, inline result text, parse modes, or persistence behavior.
7. Run npm run ci.
8. Return a before/after module map.
```

---

## Prompt 4 - Introduce onion architecture folders and dependency boundaries

```text
You are working in https://github.com/psht13/here-bot.

Goal: create the onion/layer architecture skeleton and move existing modules into it without behavior changes.

Target dependency direction:
domain -> application -> infrastructure/adapters -> main

Tasks:
1. Create folders:
   - src/domain
   - src/application
   - src/application/ports
   - src/application/services
   - src/infrastructure/persistence
   - src/adapters/telegram
   - src/adapters/telegram/presenters
2. Move current pure model/domain code:
   - models.ts into src/domain/models.ts
   - domain.ts split or moved into src/domain/* while preserving exports through compatibility barrels if needed.
3. Move JsonStore into src/infrastructure/persistence/json-store.ts.
4. Move manager screen/presenter code into src/adapters/telegram/presenters/manager-screens.ts unless you decide to keep draft state in application and only UI rendering in adapter.
5. Update imports.
6. Add a dependency-boundary test or lint rule that fails if:
   - domain imports grammy, fs, dotenv, zod, or infrastructure/adapters.
   - application imports grammy, fs, dotenv, or infrastructure/adapters.
7. Preserve all public behavior and existing tests.
8. Run npm run ci.
9. Return a dependency graph summary.
```

---

## Prompt 5 - Add repository port and make JsonStore an implementation

```text
You are working in https://github.com/psht13/here-bot.

Goal: decouple application logic from JSON persistence. No behavior changes.

Tasks:
1. Create src/application/ports/chat-repository.ts with an interface that covers the current JsonStore operations:
   - init
   - ensureChat
   - upsertMember
   - removeMember
   - getChat
   - getChatByWorkspaceKey
   - listChats
   - listChatsForMember
   - listChatsForMemberByRecency
   - getMembers
   - getGroup
   - getGroupMembers
   - upsertGroup
   - addToGroup
   - removeFromGroup
   - deleteGroup
   - listGroups
2. Make JsonStore implement this interface.
3. Add a FakeChatRepository for application tests.
4. Do not change JSON file format.
5. Preserve the current behavior where appropriate, including any surprising lastSeenAt persistence behavior unless a test explicitly documents a decision.
6. Add tests for the port contract that can run against JsonStore and FakeChatRepository.
7. Run npm run ci.
8. Return any API methods that feel too storage-specific and suggest later simplification.
```

---

## Prompt 6 - Extract application services/use cases from Telegram handlers

```text
You are working in https://github.com/psht13/here-bot.

Goal: make command behavior testable without Grammy by extracting application services/use cases. No behavior changes.

Tasks:
1. Extract these use cases/services:
   - trackMessageMembers
   - bindChat
   - getHomeDashboard
   - pingAll
   - pingTag
   - tagSet
   - tagAdd
   - tagRemove
   - tagDelete
   - listTags
   - saveDraftAsGroup
   - resolveInlinePing
   - manageDraft actions
2. Services should accept simple DTOs, not Grammy Context.
3. Services should return simple result DTOs like:
   - reply text + parse mode
   - manager screen model
   - mention chunks
   - error message
   - inline result model
4. Keep Telegram-specific sending/editing in adapters/telegram only.
5. Inject:
   - ChatRepository
   - DraftRegistry or DraftService
   - PingCooldownRegistry or CooldownService
   - InlineContextService
   - Clock
   - IdGenerator
6. Preserve all command strings, reply text, parse modes, callback data, and inline result behavior.
7. Add unit tests for each use case using fakes.
8. Run npm run ci.
9. Return a list of behavior paths now covered by tests.
```

---

## Prompt 7 - Move Telegram-specific rendering out of domain

```text
You are working in https://github.com/psht13/here-bot.

Goal: keep core domain pure and put Telegram HTML rendering in adapter/presenter layer. No behavior changes.

Tasks:
1. Identify functions that are Telegram-format-specific:
   - escapeHtml
   - buildMention
   - buildMentionChunks, if it emits Telegram HTML directly
   - manager screen HTML text builders
2. Move Telegram HTML rendering to src/adapters/telegram/presenters.
3. Keep domain-level logic for:
   - member identity
   - group key validation
   - ping request parsing
   - member reference resolution
   - chunk planning if represented without Telegram HTML.
4. If moving buildMentionChunks would be too disruptive, preserve a compatibility export and mark the old location as deprecated internally.
5. Add tests that prove rendered output is byte-for-byte/string-for-string the same as before.
6. Run npm run ci.
7. Return the new domain API surface.
```

---

## Prompt 8 - Optimize safe hot paths without behavior changes

```text
You are working in https://github.com/psht13/here-bot.

Goal: optimize obvious hot paths while preserving behavior.

Tasks:
1. Replace includes-in-filter patterns with Set-based lookups where output order remains identical.
2. Avoid repeated store calls inside one handler/use case by caching local values.
3. Use one now/nowIso per logical persistence operation where this does not alter tested behavior.
4. Throttle or centralize GC for:
   - DraftRegistry
   - PingCooldownRegistry
   - InlineContextService
   while preserving expiry semantics.
5. Consider maintaining internal indexes in JsonStore for workspaceKey and member chat lookup, but only if tests prove identical output ordering.
6. Do not change:
   - sorting order
   - callback data
   - reply text
   - inline result content
   - JSON schema
7. Add micro-level tests for ordering and expiry.
8. Run npm run ci.
9. Return a table of optimizations and why each is behavior-safe.
```

---

## Prompt 9 - Harden persistence and validation

```text
You are working in https://github.com/psht13/here-bot.

Goal: improve persistence robustness while preserving the current JSON schema and public bot behavior.

Tasks:
1. Add zod schema validation for persisted JSON.
2. Preserve current tolerant behavior for missing chats/members/groups fields.
3. Add tests for:
   - malformed JSON
   - missing file
   - missing nested fields
   - unknown extra fields
   - empty groups
   - member removal also removing member IDs from groups
4. Consider returning defensive copies from repository read methods.
   - If this changes behavior, stop and document it instead of applying.
5. Improve temp-file write safety for single-process use.
6. Do not migrate or rename existing JSON fields.
7. Run npm run ci.
8. Return any behavior that would need a migration in a future PR.
```

---

## Prompt 10 - Refactor Telegram manager callback handling

```text
You are working in https://github.com/psht13/here-bot.

Goal: split manager callback handling into a focused router and tested handlers. No behavior changes.

Tasks:
1. Move callback parsing and callback data builders into a dedicated module.
2. Move each callback action handler into separate functions:
   - home
   - pingAll
   - members
   - groups
   - groupView
   - groupPing
   - groupDelete
   - draftNew
   - draftEdit
   - draftView
   - draftToggle
   - draftSave
   - draftCancel
3. Keep parseManagerAction behavior exactly as currently characterized.
4. Keep all callback data strings exactly the same.
5. Add tests for every action path using fake repository/drafts/cooldowns and a fake Telegram response adapter.
6. Run npm run ci.
7. Return a coverage report summary for callback handling.
```

---

## Prompt 11 - Add full command behavior tests

```text
You are working in https://github.com/psht13/here-bot.

Goal: reach 90%+ meaningful coverage on command behavior. No behavior changes.

Tasks:
1. Add tests for commands:
   - /start
   - /help
   - /bind
   - /status
   - /manage
   - /here
   - /tags
   - /tag
   - /tagset
   - /tagadd
   - /tagremove
   - /tagdelete
   - /tagname
2. Use application services or a fake Telegram adapter. Avoid real Telegram API calls.
3. Cover:
   - non-group chat rejection
   - empty members
   - unknown subgroup
   - unresolved members
   - cooldown hit/miss
   - reply-to-user selection
   - "me" selection
   - draft save success/failure
4. Assert exact response text for current behavior.
5. Run npm run test:coverage.
6. If coverage is below 90%, add tests for missing production branches rather than weakening thresholds.
7. Run npm run ci.
8. Return uncovered branches that remain and why.
```

---

## Prompt 12 - Final architecture cleanup and documentation

```text
You are working in https://github.com/psht13/here-bot.

Goal: finalize the onion/layer refactor and document it. No behavior changes.

Tasks:
1. Remove obsolete compatibility exports if all imports have migrated.
2. Add docs/architecture.md explaining:
   - domain layer
   - application layer
   - infrastructure layer
   - Telegram adapter layer
   - composition root
   - dependency rules
3. Update README project layout to match the new structure.
4. Add a short "Testing and coverage" section with:
   - npm test
   - npm run test:coverage
   - npm run ci
5. Ensure package scripts point to the correct entrypoint.
6. Run npm run ci.
7. Return:
   - final folder tree
   - coverage numbers
   - command outputs
   - any intentional non-changes due to behavior compatibility.
```

---

## Suggested acceptance criteria for the whole job

```text
npm run ci passes
coverage >= 90% lines, branches, functions
domain has no framework/filesystem/env imports
application has no Grammy/filesystem/dotenv imports
main.ts is the only composition root
Telegram handlers are thin adapters
JsonStore implements a repository port
existing bot replies/callbacks/inline behavior are unchanged
README reflects the new architecture
```

The most important guardrail: make Codex add characterization tests first. For this repo, that matters more than the refactor itself because many “cleanups” can accidentally change Telegram-visible text, callback data, or JSON persistence behavior.
