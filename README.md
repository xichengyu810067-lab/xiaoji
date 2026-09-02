# Xiaoji Discord Bot

Xiaoji is a Discord slash command bot built with `discord.js` v14. It supports utility commands, moderation, weather, polls, announcements, autorole, automod, reminders, saved guild configuration, config export, the 吉幣 virtual currency system, casino chips, and independent luxury/pawn shop features.

## Setup

```bash
npm install
Copy-Item .env.example .env
npm run deploy
npm start
```

若託管平台無法另外執行 `npm run deploy`，可暫時設定 `AUTO_DEPLOY_COMMANDS=true` 後重啟；小吉會在登入前部署 Slash Commands。確認日誌成功後請改回 `false` 並再次重啟，避免每次啟動都重複部署。

NyankoHost 的 Node.js 啟動模板會把主程式交給全域 `ts-node`。專案因此固定安裝 `typescript@5.9.3` 作為託管環境相容依賴，讓該啟動器能正常初始化；小吉本身仍是純 CommonJS JavaScript，沒有使用或新增 TypeScript 原始碼。

Required `.env` values:

```env
DISCORD_TOKEN=your_discord_bot_token
DISCORD_CLIENT_ID=your_discord_application_client_id
DISCORD_GUILD_ID=your_main_server_id_for_management_commands
BOT_OWNER_ID=your_discord_user_id
OPENWEATHER_API_KEY=your_openweather_api_key
```

`BOT_OWNER_ID` is the standard owner variable. `OWNER_ID` is still accepted as a legacy fallback; if both are set, Xiaoji uses `BOT_OWNER_ID`. `DISCORD_CLIENT_ID` and `DISCORD_GUILD_ID` are standard, with `CLIENT_ID` and `GUILD_ID` accepted only for older `.env` files.

Optional values:

```env
GROQ_API_KEY=your_groq_api_key
OPENAI_API_KEY=your_openai_api_key
AI_CONVERSATION_PATH=data/aiConversationHistory.json
COIN_DB_PATH=data/xiaoji.sqlite
COIN_TIMEZONE=Asia/Taipei
LAVALINK_HOST=your_lavalink_host
LAVALINK_PORT=2333
LAVALINK_PASSWORD=your_lavalink_password
LAVALINK_SECURE=false
LAVALINK_ALLOW_PUBLIC_FALLBACK=false
```

Groq chat is pinned to `openai/gpt-oss-120b` through the OpenAI-compatible endpoint `https://api.groq.com/openai/v1`. A stale `GROQ_MODEL` value from an older deployment is intentionally ignored.

Music source code is retained for future work, but music playback is **not a supported public feature in 1.0.0**. `/music` is registered only in `DISCORD_GUILD_ID`, requires an exact `BOT_OWNER_ID` match for every subcommand, is omitted from `/help`, and may fail. It is a private experiment, not a release promise; its internal maintenance reference is [`docs/LAVALINK_SELF_HOST.md`](docs/LAVALINK_SELF_HOST.md).

For the owner-only local yt-dlp fallback, `YOUTUBE_COOKIES_PATH` may point to one explicit absolute Netscape `cookies.txt` file, following the [official yt-dlp cookie-file format](https://github.com/yt-dlp/yt-dlp/wiki/FAQ#how-do-i-pass-cookies-to-yt-dlp). Xiaoji never reads a browser Cookie database or accepts `--cookies-from-browser`; the path is ignored unless both the requester and guild exactly match `BOT_OWNER_ID` and `DISCORD_GUILD_ID`. The source must be a non-symlink regular file no larger than 1 MiB and remains ignored by Git; on POSIX, the bot process must own it with mode `600`. Xiaoji reads and validates the source through one open file handle, creates a short-lived private snapshot for both yt-dlp metadata and audio subprocesses, and removes that snapshot after completion or failure. The original configured path is never passed to yt-dlp. An invalid or replaced source fails closed without logging its path or contents. This is still experimental and does not prove YouTube availability or audible playback.

`npm run deploy` registers general and administrator-gated slash commands globally, and registers owner-only maintenance commands to `DISCORD_GUILD_ID`. Discord global commands can take some time to appear.

## 24/7 VPS Deployment

Use a VPS plus PM2 for production. Do not put `.env`, Discord token, API keys, server IDs, user IDs, or runtime data JSON files in the public repository.

```bash
git clone https://github.com/YOUR_NAME/YOUR_REPO.git
cd YOUR_REPO
npm ci --omit=dev
cp .env.example .env
nano .env
chmod 600 .env
npm run prod:check
npm run smoke:login
npm run deploy
sudo npm install -g pm2
pm2 startOrRestart ecosystem.config.cjs --env production
pm2 save
pm2 startup
```

After `pm2 startup`, run the `sudo ...` command PM2 prints, then run `pm2 save` again. Full VPS instructions are in [`docs/VPS_DEPLOYMENT.md`](docs/VPS_DEPLOYMENT.md).

Useful production commands:

```bash
npm run prod:check
npm run smoke:login
npm run pm2:status
npm run pm2:logs
npm run pm2:restart
```

## Commands

- `/help`: show command help.
- `/ping`: show latency.
- `/status`: show uptime, memory usage, guild count, command count, version, and last startup time.
- `/weather city`: show current weather. Taiwan city/district inputs such as `新竹竹北`, `新北新莊`, and `台南東區` are normalized before querying. If city is omitted, Xiaoji uses `weather_default_city`.
- `/poll question option1 option2`: create a button poll.
- `/remind time message`: create a persistent reminder. Examples: `10m`, `1h`, `1d`.
- `/calendar add/list/delete`: manage saved guild calendar events.
- `/ticket open subject`: open one private support channel from the configured intake channel; duplicate tickets are rejected per guild and user.
- `/ticket status`: show the configured intake, support role, and your active ticket.
- `/coins user`: show your 吉幣 balance, or another user's balance.
- `/daily`: claim the daily 吉幣 reward. Default reward is 50 吉幣, with streak bonuses.
- `/leaderboard`: show the current guild 吉幣 ranking.
- `/bank balance/deposit/withdraw/interest`: manage wallet and demand deposits.
- `/bank fixed-create/fixed-list/fixed-claim/fixed-cancel/fixed-rates`: manage fixed deposits.
- `/bank balance-user/balance-all/fixed-user/fixed-all/rate-set-demand/rate-set-fixed/rate-history`: administrator banking and rate audit tools.
- `/exchange balance/buy-chips/cashout/history`: exchange 吉幣 and casino 籌碼. Cashing out chips charges a tiered fee.
- `/casino-lobby guide/betting-area/stay/stays`: view the casino lobby, betting area, and lodging.
- `/duel-tower weapons/profile/enter/history`: challenge the duel tower using battle items from the 吉幣 shop.
- `/casino dice/slots/blackjack/roulette/baccarat/poker`: play casino games with 籌碼. If chips are short, Xiaoji auto-buys the missing chips from your 吉幣 wallet.
- `/casino loan-borrow/loan-repay/loan-status/history`: borrow casino chips, repay chip debt, view loan status, and review casino ledger history.
- `/casino-venue menu/add-menu/order/recipe/make/serve/history`: manage restaurant and bar menus, place orders with a required waiter tip, let assigned chefs or bartenders submit production steps, and let waiters serve orders.
- `/work list/start/start-venue/submit/submissions/edit/delete/payroll/penalties/appeal`: choose jobs, start casino venue multi-jobs on one shared cycle, submit work proof, view payroll, and appeal work penalties. If a user reports no available work, payroll uses the 75% basic salary rule.
- `/work report/tasks`: legacy-compatible work report and task history commands.
- `/work pending/review/status-user/status-all/task-add/tasks-all/admin-remind/role-sync/payroll-preview/payroll-history/appeal-review`: administrator work review, supervision, payroll, and owner appeal review tools.
- `/shop list`: show enabled 吉幣 shop items.
- `/shop buy/purchases`: buy items and view your purchase records.
- `/shop purchases-user/purchases-all`: administrator purchase record lookup.
- `/buy item-id quantity`: buy an item with 吉幣.
- `/inventory`: show your purchased items.
- `/luxury list/buy/inventory/history`: use the independent luxury shopping street. This does not share inventory with the regular 吉幣 shop.
- `/pawn quote/sell/active/redeem/history`: pawn luxury items for 80% of their current price, or redeem pawn records at the item's historical highest price.
- `/economy leaderboard`: show total-assets ranking.
- `/economy overview/user/audit`: administrator economy overview and audit records.
- `/announce`: send an announcement.
- `/autorole`: manage new-member autorole.
- `/automod`: manage automod.
- `/word-chain start/stop/status`: administrator-only, start or stop a validated Traditional Chinese text chain in one channel, or view its current word. Entries must be a 2–6 character project-curated word, begin with the previous word's final character, not repeat an earlier word, and alternate users.
- `/number-chain start/stop/status`: administrator-only, start or stop a turn-based number chain in one channel. Players may submit a decimal integer or a bounded exact `+ - * /` parenthesized expression that equals the current target; decimal, exponent, code, implicit multiplication, non-integer results, and division by zero are rejected.
- `/daily-riddle enable/disable/status`: administrators select a text or announcement parent channel, disable future occurrences, or inspect today's event status. Xiaoji needs `View Channel`, `Send Messages`, `Create Public Threads`, `Send Messages in Threads`, and `Read Message History` in the selected channel.
- `/set-welcome`: set the channel used for new-member welcome messages.
- New-member welcomes prefer the saved `/set-welcome` channel. If it is missing, deleted, or not sendable, Xiaoji falls back to the guild system channel and then the first regular text channel where it has `View Channel` and `Send Messages`.
- `/ticket setup intake-channel support-role`: configure the only channel where users may open tickets and the staff role that can access them. Xiaoji requires `Manage Channels`.
- `/ticket close reason`: close the current ticket; only the configured support role, a member with `Manage Channels`/`Administrator`, or the bot owner may close it.
- `/config`: view saved guild settings such as `log_channel`, `welcome_channel`, `anti_spam_enabled`, `weather_default_city`, and `announce_allow_mentions`.
- `/export-config`: export saved guild settings without tokens or API keys.
- `/coin-admin add/remove/set/history/reset-user/enable/disable`: manage 吉幣 balances and guild economy state. Administrator is required, except `reset-user` which is owner-only.
- `/casino-venue delete-menu/reassign/reassign-waiter/cancel`: administrator restaurant, bar, and waiter operations.
- `/shop-admin create/edit/enable/disable/delete`: manage 吉幣 shop items. Administrator is required.
- `/luxury-admin create/edit/enable/disable/delete`: manage luxury shopping street items. Administrator is required.
- `/coin-db status`: owner-only database status check.
- `/quota`, `/quota-set`, `/quota-list`, `/quota-reset`: manage guild quota. These commands are registered only to the main guild and require `BOT_OWNER_ID`.

Management commands require the executor to have the server `Administrator` permission. Owner ID and custom moderator role environment variables are not used for management command access.
Quota management commands require `interaction.user.id` to exactly match `BOT_OWNER_ID`; server administrators, guild owners, and friend-server admins cannot view or edit quota.

## Testing

```bash
npm test
npm run check
npm run audit
```

`npm run check` verifies command loading plus the ticket, private music-code safety boundary, AI history, voice-stay, and welcome-fallback contracts. `npm run prod:check` validates required secrets by presence only, checks optional private-experiment Lavalink policy consistency, and never prints secret values.

The retained music implementation and its internal deployment notes are maintenance assets only. They do not establish YouTube availability, audible playback, or 1.0.0 support. The only credential-bearing input permitted in this private experiment is the explicit `YOUTUBE_COOKIES_PATH` file boundary above. Do not add browser-database access, `--cookies-from-browser`, OAuth, account passwords, manual tokens, visitor data, proxy settings, remote components, or IP routing.

On Windows PowerShell, use `npm.cmd` if `npm` is blocked by execution policy:

```powershell
npm.cmd test
npm.cmd run check
npm.cmd run audit
```

## Data

- Guild settings are stored in `src/data/guildConfig.json`.
- Active polls are stored in `src/data/polls.json`.
- Active reminders are stored in `src/data/reminders.json`.
- Ticket state is stored atomically in ignored `src/data/tickets.json`; ticket records are isolated by guild and restored after restart.
- Calendar events are stored in `src/data/calendarEvents.json`.
- Guild quota is stored in `src/data/guildQuotas.json`.
- 吉幣 data is stored in SQLite at `data/xiaoji.sqlite` by default, or `COIN_DB_PATH` if configured.
- Casino games, blackjack sessions, casino loans, casino lodging, duel tower records, chip accounts, and casino ledger records are stored in the same 吉幣 SQLite database.
- Luxury shopping street items, luxury inventory, purchase records, pawn records, and redemption records are stored separately from the regular 吉幣 shop tables in the same SQLite database.
- Casino restaurant and bar menus, orders, and completed production records are stored in the same 吉幣 SQLite database.
- Work payroll uses Taiwan time (`Asia/Taipei`) and settles due jobs at 22:00 on the last work day. Valid work submissions are paid once; `deleted` and `rejected` submissions are excluded. Chef and bartender venue bonuses are paid through the same payroll cycle.

### Community features and daily riddle

SQLite schema v14 includes disabled-by-default guild feature flags and channel configuration, an idempotent reward-grant ledger tied to `system_reward` coin transactions, a restart-safe delivery outbox, de-identified daily usage counters, a feature health registry, validated text/number chain sessions, and daily-riddle event/message/participant records. `/word-chain start`, `/number-chain start`, and `/daily-riddle enable` explicitly enable their respective feature; all other planned community features remain disabled and unavailable.

Daily riddle uses the versioned, project-curated `daily-riddles-v1` corpus and exact normalized aliases—never AI or network judging. A deterministic question is posted at 10:00 Asia/Taipei and receives its own public thread. Valid human discussion in that thread before 21:30 earns 30 吉幣; each exact correct answer earns another 50 吉幣, with both grants idempotent per user and event. At 21:30 Xiaoji paginates the complete thread history before posting the answer or paying anyone. If history is unavailable or incomplete, the event is marked blocked and no reward is issued. Late startup during the open window publishes once as `published_late`; startup after the window records `missed` without backfilling. Only SHA-256 content hashes, eligibility, and correctness are persisted—message text is not stored.

Number chain uses a local tokenizer and exact BigInt rational parser rather than JavaScript evaluation; players alternate, and only an integer result equal to the current target advances it. Successful text/number chain entries receive `✅`; a failed Discord reaction is retried by a bounded outbox worker without storing the original message text.

Runtime data files should not contain Discord tokens or API keys. Do not commit `.env`, `src/data/*.json`, `data/*`, `database/*`, `storage/*`, or SQLite database files.

AI recent conversation history is a separate private runtime store at `AI_CONVERSATION_PATH` (default `data/aiConversationHistory.json`). It is isolated by guild, channel, and user, survives process restarts, uses atomic serialized writes, and applies configurable turn/count/byte/retention limits. A corrupt file is preserved and AI continues without persistent recent history until the store is explicitly cleared or repaired. This does not change the public/private query behavior of `xiaojiMemory.json`.

Before major 吉幣 updates, back up the SQLite file from NyankoHost. Restarting PM2/NyankoHost should keep the database file in place as long as `COIN_DB_PATH` points to a persistent local path and the file is not uploaded to GitHub.
