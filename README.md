# Xiaoji Discord Bot

Xiaoji is a Discord slash command bot built with `discord.js` v14. It supports utility commands, moderation, weather, polls, announcements, autorole, automod, reminders, saved guild configuration, and config export.

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
```

`npm run deploy` registers general slash commands globally, and registers management slash commands only to `DISCORD_GUILD_ID`. Discord global commands can take some time to appear.

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
- `/announce`: send an announcement.
- `/autorole`: manage new-member autorole.
- `/automod`: manage automod.
- `/config`: manage saved guild settings: `log_channel`, `anti_spam_enabled`, `weather_default_city`, `announce_allow_mentions`.
- `/export-config`: export saved guild settings without tokens or API keys.
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

Runtime data files should not contain Discord tokens or API keys.
