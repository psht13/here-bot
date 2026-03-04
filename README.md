# Here Bot

Telegram does not allow bots to implement a literal Slack-style `@here` trigger, and inline queries do not reveal the exact chat where the user is typing. This project implements the closest reliable Telegram-native version:

- `/here` inside a group or supergroup mentions every tracked member.
- Custom mention groups such as `@gang` are managed with bot commands, then triggered with `/tag gang`.
- `/manage` opens a button-based dashboard for browsing members, opening subgroups, and building subgroup drafts.
- Inline mode auto-resolves from your tracked groups:
  - `@YourBot`
  - `@YourBot all`
  - `@YourBot gang`
- The explicit workspace syntax still works when you want to target a specific group manually:
  - `@YourBot all <workspace-key>`
  - `@YourBot tag <workspace-key> <group-name>`

The bot stores only the members it has actually seen. Telegram bots cannot fetch a full member list for a group or channel on demand.

## What this bot supports

- Group and supergroup chats only.
- Mentioning tracked users with HTML `tg://user?id=...` links.
- Custom reusable mention groups.
- Member-aware inline query results, with optional explicit workspace targeting.
- Persistent local JSON storage.

## What Telegram does not allow

- No bot can register a real `@here` keyword that triggers automatically while you type.
- Inline queries do not include the current chat ID, so the bot can only infer from your tracked groups unless you use explicit workspace syntax.
- Bots cannot enumerate all subscribers of a broadcast channel.
- Users who never interacted after the bot joined cannot be auto-mentioned until the bot sees them.

## Project layout

- `src/index.ts`: bot entrypoint, commands, inline handlers.
- `src/storage.ts`: JSON-backed persistence for groups, members, and custom tags.
- `src/domain.ts`: parsing, mention formatting, and shared helpers.
- `src/manager.ts`: button UI, callback parsing, and subgroup draft state.
- `src/domain.test.ts`: small regression tests for the pure logic.
- `src/manager.test.ts`: regression tests for callback parsing and subgroup drafts.

## Setup

1. Create a bot with BotFather.
2. In BotFather:
   - Enable inline mode with `/setinline`.
   - Disable privacy mode with `/setprivacy` if you want the bot to learn members from normal group messages.
   - Turn on group support if it is disabled.
3. Copy `.env.example` to `.env` and fill in:
   - `BOT_TOKEN`
   - `BOT_USERNAME`
   - `DATA_FILE` (optional, the default is fine)
4. Install dependencies:

```bash
npm install --cache ./.npm-cache
```

5. Start the bot in development:

```bash
npm run dev
```

6. Or build and run it:

```bash
npm run build
npm start
```

## Add the bot to your Telegram group

1. Add the bot to a group or supergroup.
2. For the best member coverage, make the bot an admin in that group.
   - This is required if you want Telegram to send `chat_member` updates for other users.
3. Run `/bind` in the group.
4. Ask each person you want to mention to send at least one message after the bot joins.

After `/bind`, the bot returns a workspace key, for example `my-team-a1b2`. You usually do not need to type it anymore. It remains available as an explicit fallback when you want to target a specific group manually.

## Usage

### Mention everyone

Inside the group:

```text
/here
```

Button dashboard:

```text
/manage
```

The dashboard lets you:

- tap `Ping All` instead of typing `/here`
- tap `Inline Here` to inject the inline query without typing anything extra
- browse tracked members
- open existing subgroups
- build a subgroup by tapping members

Inline mode in any chat input:

```text
@YourBot
```

Or:

```text
@YourBot all
```

If the bot knows you in only one tracked group, it returns that group directly. If it knows you in multiple tracked groups, Telegram shows one result per group and you tap the correct one.

Explicit fallback syntax still works:

```text
@YourBot all my-team-a1b2
```

### Create a smaller custom group

Create or replace a group:

```text
/tagset gang me @alice @bob
```

Or reply to a user's message:

```text
/tagset gang
```

Add members later:

```text
/tagadd gang @charlie
```

Remove members:

```text
/tagremove gang @bob
```

Ping the custom group:

```text
/tag gang
```

Button-driven creation:

1. Run `/manage`
2. Tap `New Subgroup`
3. Tap members to select them
4. Tap `Name + Save`
5. Send:

```text
/tagname gang
```

Editing an existing subgroup:

1. Run `/manage`
2. Tap `Groups`
3. Open a subgroup
4. Tap `Edit Members`
5. Toggle members and tap `Save @group`

List groups:

```text
/tags
```

Delete a group:

```text
/tagdelete gang
```

Inline mode for a custom group:

```text
@YourBot gang
```

If the same subgroup name exists in multiple groups, Telegram shows one result per group and you tap the right one.

Explicit fallback:

```text
@YourBot tag my-team-a1b2 gang
```

## Data model

The bot stores:

- A workspace key for each Telegram group.
- Known members that the bot has observed.
- Custom mention groups and their member IDs.

Data is written to the JSON file defined by `DATA_FILE`.

## Deployment notes

- Long polling is used by default, so you can run this on any small VPS or always-on machine.
- For production, use a process manager such as `systemd`, `pm2`, or Docker.
- If you outgrow the JSON file, replace `JsonStore` with PostgreSQL or SQLite while keeping the same bot handlers.
