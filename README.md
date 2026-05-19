# Xiaoji Discord Bot

Xiaoji is a Discord slash command bot built with `discord.js` v14. It supports utility commands, moderation, weather, polls, announcements, autorole, automod, reminders, saved guild configuration, config export, and the 吉幣 virtual currency system.

## Setup

```bash
npm install
Copy-Item .env.example .env
npm run deploy
npm start
```

Required `.env` values:

```env
DISCORD_TOKEN=your_discord_bot_token
DISCORD_CLIENT_ID=your_discord_application_client_id
DISCORD_GUILD_ID=your_main_server_id_for_management_commands
BOT_OWNER_ID=your_discord_user_id
OPENWEATHER_API_KEY=your_openweather_api_key
```

Optional values:

```env
GROQ_API_KEY=your_groq_api_key
OPENAI_API_KEY=your_openai_api_key
COIN_DB_PATH=data/xiaoji.sqlite
COIN_TIMEZONE=Asia/Taipei
```

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
- `/weather city`: show current weather. If city is omitted, Xiaoji uses `weather_default_city`.
- `/poll question option1 option2`: create a button poll.
- `/remind time message`: create a persistent reminder. Examples: `10m`, `1h`, `1d`.
- `/calendar add/list/delete`: manage saved guild calendar events.
- `/music play url`: play a YouTube video in the user's current voice channel.
- `/music queue/skip/pause/resume/stop/leave`: manage music playback and make Xiaoji leave voice.
- You can also paste a YouTube video URL in a text channel; if you are in a voice channel, Xiaoji queues it automatically.
- Xiaoji automatically leaves the voice channel after 3 minutes with an empty queue and no active playback.
- `/coins user`: show your 吉幣 balance, or another user's balance.
- `/daily`: claim the daily 吉幣 reward. Default reward is 50 吉幣, with streak bonuses.
- `/leaderboard`: show the current guild 吉幣 ranking.
- `/bank balance/deposit/withdraw/interest`: manage wallet and demand deposits.
- `/bank fixed-create/fixed-list/fixed-claim/fixed-cancel/fixed-rates`: manage fixed deposits.
- `/bank balance-user/balance-all/fixed-user/fixed-all/rate-set-demand/rate-set-fixed/rate-history`: administrator banking and rate audit tools.
- `/work list/start/submit/submissions/edit/delete/payroll`: choose a job, submit work proof, edit or soft-delete submissions before payroll, and view your payroll records.
- `/work report/tasks`: legacy-compatible work report and task history commands.
- `/work pending/review/status-user/status-all/task-add/tasks-all/admin-remind/role-sync/payroll-preview/payroll-history`: administrator work review, supervision, and payroll tools.
- `/shop list`: show enabled 吉幣 shop items.
- `/shop buy/purchases`: buy items and view your purchase records.
- `/shop purchases-user/purchases-all`: administrator purchase record lookup.
- `/buy item-id quantity`: buy an item with 吉幣.
- `/inventory`: show your purchased items.
- `/economy leaderboard`: show total-assets ranking.
- `/economy overview/user/audit`: administrator economy overview and audit records.
- `/announce`: send an announcement.
- `/autorole`: manage new-member autorole.
- `/automod`: manage automod.
- `/config`: manage saved guild settings: `log_channel`, `anti_spam_enabled`, `weather_default_city`, `announce_allow_mentions`.
- `/export-config`: export saved guild settings without tokens or API keys.
- `/coin-admin add/remove/set/history/reset-user/enable/disable`: manage 吉幣 balances and guild economy state. Administrator is required, except `reset-user` which is owner-only.
- `/shop-admin create/edit/enable/disable/delete`: manage 吉幣 shop items. Administrator is required.
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
- Calendar events are stored in `src/data/calendarEvents.json`.
- Guild quota is stored in `src/data/guildQuotas.json`.
- 吉幣 data is stored in SQLite at `data/xiaoji.sqlite` by default, or `COIN_DB_PATH` if configured.
- Work payroll uses Taiwan time (`Asia/Taipei`) and settles due jobs at 22:00 on the last work day. Valid work submissions are paid once; `deleted` and `rejected` submissions are excluded.

Runtime data files should not contain Discord tokens or API keys. Do not commit `.env`, `src/data/*.json`, `data/*`, `database/*`, `storage/*`, or SQLite database files.

Before major 吉幣 updates, back up the SQLite file from NyankoHost. Restarting PM2/NyankoHost should keep the database file in place as long as `COIN_DB_PATH` points to a persistent local path and the file is not uploaded to GitHub.
