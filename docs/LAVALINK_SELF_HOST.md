# Lavalink v4 independent host

Xiaoji's production music path requires a separately hosted Lavalink node. The current NyankoHost bot container is Node-only and must not be treated as a Java/Docker sidecar host.

This bundle pins Lavalink `4.2.2`, LavaSrc `4.8.3`, yt-dlp `2026.07.04`, and Deno `2.9.5`. The version and configuration choices follow the official [Lavalink repository](https://github.com/lavalink-devs/Lavalink), [Docker guide](https://lavalink.dev/getting-started/docker), [LavaSrc repository](https://github.com/topi314/LavaSrc), and [yt-dlp EJS guidance](https://github.com/yt-dlp/yt-dlp/wiki/EJS). LavaSrc's yt-dlp source handles ordinary public YouTube video URLs and `ytsearch:` queries; both Lavalink's built-in YouTube source and the separate youtube-source plugin are disabled.

The built-in SoundCloud source is enabled only for a final same-track fallback. The bot sends a finite set of explicit `scsearch:` queries, derived only from trusted title identity, after a YouTube URL resolved to trusted non-live metadata and both YouTube playback paths failed. Every result still passes exact normalized title/artist/version semantics and a two-second duration tolerance; ambiguous equal matches fail closed. No OAuth, cookie, PoToken, remote cipher, proxy, or IP-rotation feature is enabled, and SoundCloud is never described as direct YouTube audio.

The yt-dlp release asset and Deno archive are downloaded from immutable release URLs and verified with their official SHA-256 digests during the Docker build. Deno supplies the external JavaScript runtime now required for full YouTube challenge support. Do not add OAuth, cookies, proof tokens, visitor data, account credentials, remote components, proxies, IP rotation, or alternate client identities to this anonymous deployment profile.

LavaSrc providers and all unrelated LavaSrc sources are disabled. Playlist and mix limits remain one because `/music play` accepts only one normal public video, not playlists, live streams, private, age-restricted, member-only, deleted, or geo-restricted content.

## Start on a separate Docker host

```bash
cd deploy/lavalink
cp lavalink.env.example lavalink.env
# Replace LAVALINK_SERVER_PASSWORD with a long random value.
mkdir -p plugins
sudo chown -R 322:322 plugins
docker compose --env-file lavalink.env config
docker compose --env-file lavalink.env up -d
docker compose --env-file lavalink.env ps
docker compose --env-file lavalink.env logs --tail=200 lavalink
```

The safe default binds port 2333 to `127.0.0.1`. For a bot on another host, expose Lavalink through a TLS reverse proxy and firewall it to the bot host, or set `LAVALINK_BIND_ADDRESS=0.0.0.0` only on a private network/firewalled interface. Never publish an unprotected node to the internet.

## Bot environment

```env
LAVALINK_HOST=lavalink.example.com
LAVALINK_PORT=443
LAVALINK_PASSWORD=the_same_long_random_password
LAVALINK_SECURE=true
LAVALINK_NODE_NAME=ProductionLavalink
LAVALINK_RECONNECT_TRIES=10
LAVALINK_RECONNECT_INTERVAL_MS=5000
LAVALINK_ALLOW_PUBLIC_FALLBACK=false
```

Restart Xiaoji, then run `/music status`. Required production evidence is:

1. `configurationMode: self-hosted` and `publicFallbackEnabled: false`.
2. At least one runtime node is `connected`.
3. A normal YouTube `watch`, `shorts`, and `youtu.be` URL resolves and produces a Lavalink `TrackStartEvent`/player start plus advancing position.
4. Lavalink logs show LavaSrc `4.8.3` loaded, with yt-dlp `2026.07.04` and Deno `2.9.5` available without source exceptions.
5. When testing the optional same-track fallback, the Discord success reply says `SoundCloud 同曲備援` and `/music status` reports the actual current source as `soundcloud`; a no-match or ambiguous match must fail without reporting playback.

`/music test` only plays a local generated tone. It validates Discord voice/ffmpeg, not YouTube or Lavalink source loading.

Public fallback can be enabled temporarily with `LAVALINK_ALLOW_PUBLIC_FALLBACK=true` plus explicit `LAVALINK_PUBLIC_FALLBACK_HOST`, port, password, and secure-mode values from that provider. No public node password is embedded in the repository. Fallback is off by default, unsupported for production acceptance, and may disappear or reject traffic without notice.

## Deploy a hobby node on Render

The repository root includes a `render.yaml` Blueprint and a digest-pinned Dockerfile under `deploy/lavalink`. The Blueprint deploys a free Singapore web service, prompts for `LAVALINK_SERVER_PASSWORD`, uses Render's injected `PORT`, and limits the JVM heap to 384 MiB.

1. Open `https://dashboard.render.com/blueprints` and create a Blueprint from `https://github.com/xichengyu810067-lab/xiaoji`.
2. Keep the Blueprint path as `render.yaml` and provide a new long random `LAVALINK_SERVER_PASSWORD` when prompted.
3. Wait for `xiaoji-lavalink` to become live and confirm the logs show Lavalink 4.2.2 plus LavaSrc 4.8.3; the Docker build also validates the pinned yt-dlp and Deno versions.
4. Configure Xiaoji with the generated `*.onrender.com` hostname, port `443`, the same password, and `LAVALINK_SECURE=true`.

Render's free web service is suitable for hobby verification, not a production SLA. It can restart and normally spins down after inactivity; an active Lavalink WebSocket exchanges messages and should keep it awake, while Xiaoji already reconnects after interruptions. Upgrade or move the same Docker bundle to an always-on host if reliable production playback is required.
