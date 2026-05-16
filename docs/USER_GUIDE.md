# Xiaoji User Guide

## First Run

1. Fill `.env`.
2. Run `npm run deploy`.
3. Run `npm start`.
4. In Discord, use `/help` to confirm commands are deployed.

## Recommended Setup

```text
/config log-channel channel:#mod-log
/config weather-default-city city:Taipei
/config anti-spam enabled:true
/config announce-mentions enabled:false
/autorole set role:@Member
```

## Testing New Commands

- `/status`: confirm Xiaoji reports runtime status.
- `/remind time:10m message:test`: confirm a reminder is saved and later sent in the same channel.
- `/remind list`, then `/remind delete id:<id>` to delete it.
- `/calendar add title:Meeting starts-at:2026-05-10 20:00`, then `/calendar list`.
- Join a voice channel and paste a YouTube URL, or use `/music play url:<youtube-url>`.
- `/config view`: confirm saved guild settings.
- `/weather`: after setting `weather_default_city`, confirm weather works without passing `city`.

## Troubleshooting

- If new slash commands do not appear, run `npm run deploy`, restart Discord with `Ctrl+R`, and restart the bot.
- `/remind` only works inside a guild text channel.
- `/config` requires Manage Server permission or an owner/mod override from `.env`.
- `/weather` requires `OPENWEATHER_API_KEY`.
