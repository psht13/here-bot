# Architecture

Here Bot is organized as a small onion/layered application. The outer layers translate Telegram and filesystem details into plain application inputs. Inner layers stay framework-free so command behavior can be tested without a Telegram network dependency.

## Domain Layer

Location: `src/domain/`

The domain layer contains core bot concepts and pure rules:

- `models.ts` defines known chats, members, mention groups, and persisted data shapes.
- `index.ts` contains group-key validation, ping request parsing, member reference resolution, display-name selection, workspace-key generation, and framework-neutral mention chunk planning.

The domain layer must not import application services, adapters, infrastructure, Grammy, environment parsing, or filesystem APIs.

## Application Layer

Location: `src/application/`

The application layer coordinates bot behavior using domain rules and ports:

- `use-cases/` contains Telegram-independent command, inline-query, tracking, tag, and manager workflows.
- `callbacks/` contains callback data parsing and manager action handling.
- `services/` contains stateful in-memory helpers such as draft tracking, ping cooldowns, and inline context lookup.
- `ports/` defines contracts for persistence and system dependencies.
- `presenters/` defines framework-neutral screen and keyboard models.
- `testing/` contains fakes used by application and contract tests.

Application code can depend on domain code and application ports. It must not import Telegram/Grammy APIs, persistence implementations, dotenv, or filesystem APIs.

## Infrastructure Layer

Location: `src/infrastructure/`

Infrastructure implements application ports with concrete technical details:

- `persistence/json-store.ts` implements `ChatRepository`.
- `persistence/persisted-schema.ts` validates and normalizes JSON storage data.

Infrastructure may depend on application ports and domain models. It does not own command behavior or Telegram response formatting.

## Telegram Adapter Layer

Location: `src/adapters/telegram/`

The Telegram adapter translates between Grammy contexts and application DTOs:

- `telegram.ts` registers bot commands, middleware, inline queries, callback handlers, and event handlers.
- `callbacks/` adapts manager callback routes to Telegram callback responses.
- `presenters/` renders application screen models and mention chunks as Telegram HTML and inline keyboards.

Adapter code is the only layer that should depend on Grammy. Telegram-visible text, parse modes, callback data, and inline result shapes are preserved here.

## Composition Root

Location: `src/main.ts`

`main.ts` is the composition root. It loads environment variables, constructs concrete dependencies, wires handlers into a Grammy `Bot`, initializes persistence, registers Telegram commands, and starts long polling.

No inner layer should create production singletons or read process environment directly.

## Dependency Rules

Allowed dependency direction:

```text
domain <- application <- infrastructure/adapters <- main
```

Practical rules:

- Domain imports only domain-local code and platform-neutral types.
- Application imports domain and application-local ports/services/use cases.
- Infrastructure implements application ports and can use filesystem or validation libraries.
- Telegram adapters depend on application contracts and Grammy.
- `main.ts` is the only composition root and owns production wiring.
- Compatibility barrels at the old root module paths have been removed after internal imports migrated.

The `src/dependency-boundary.test.ts` test enforces the key framework and outer-layer restrictions for domain and application code.
