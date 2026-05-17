# Xiaoji Commands

## Utility

- `/help`: show command help.
- `/ping`: show latency.
- `/status`: show uptime, memory usage, guild count, command count, version, and last startup time.
- `/weather city:Taipei`: show current weather.
- `/poll question:Lunch? option1:Rice option2:Noodles duration-minutes:10`: create a poll.
- `/remind time:10m message:Drink water`: create a persistent reminder.
- `/remind list`: list your active reminders.
- `/remind delete id:<reminder-id>`: delete your reminder.
- `/calendar add title starts-at description`: add a guild calendar event.
- `/calendar list days:30`: list upcoming calendar events.
- `/calendar delete id:<event-id>`: delete a calendar event.
- `/music play url:<youtube-url>`: play a YouTube video in your voice channel.
- `/music queue`: show the music queue.
- `/music skip`, `/music pause`, `/music resume`, `/music stop`: control playback.

## 吉幣

- `/coins user`: show your 吉幣 balance, or another user's balance.
- `/daily`: claim the daily 吉幣 reward.
- `/leaderboard page`: show the current guild 吉幣 ranking.
- `/shop page`: show enabled shop items.
- `/buy item-id quantity`: buy a shop item with 吉幣.
- `/inventory`: show your purchased items.

## Configuration

- `/config view`: show saved guild settings.
- `/config log-channel channel:#mod-log`: set `log_channel`.
- `/config anti-spam enabled:true`: set `anti_spam_enabled`.
- `/config weather-default-city city:Taipei`: set `weather_default_city`.
- `/config announce-mentions enabled:false`: set `announce_allow_mentions`.
- `/quota`: show guild quota. Owner-only via `BOT_OWNER_ID`.
- `/quota-set guild-id limit used`: set guild quota. Owner-only via `BOT_OWNER_ID`.
- `/quota-list`: list guild quotas. Owner-only via `BOT_OWNER_ID`.
- `/quota-reset guild-id clear-limit`: reset or remove guild quota. Owner-only via `BOT_OWNER_ID`.
- `/coin-db status`: show 吉幣 database status. Owner-only via `BOT_OWNER_ID`.

## Moderation And Server Tools

- `/announce channel:#announcements message:Hello allow-mentions:false`: send an announcement.
- `/automod status`: show automod settings.
- `/autorole set role:@Member`: set autorole.
- `/export-config`: export guild settings as JSON.
- `/clear amount:10`: delete recent messages.
- `/timeout user duration reason`: timeout a member.
- `/kick user reason`: kick a member.
- `/ban user reason`: ban a user.
- `/unban user-id reason`: unban a user.
- `/role-add user role`: add a role.
- `/role-remove user role`: remove a role.
- `/coin-admin add/remove/set/history/reset-user/enable/disable`: manage 吉幣 balances and guild economy state.
- `/shop-admin create/edit/enable/disable/delete`: manage 吉幣 shop items.
