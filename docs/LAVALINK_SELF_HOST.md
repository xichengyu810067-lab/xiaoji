# Lavalink v4 independent host

Xiaoji's production music path requires a separately hosted Lavalink node. The current NyankoHost bot container is Node-only and must not be treated as a Java/Docker sidecar host.

This bundle pins Lavalink `4.2.2` and the official youtube-source plugin `1.18.2`. The version and configuration choices were checked against the official [Lavalink repository](https://github.com/lavalink-devs/Lavalink), [Docker guide](https://lavalink.dev/getting-started/docker), and [youtube-source repository](https://github.com/lavalink-devs/youtube-source). The built-in YouTube source is disabled as required by the plugin documentation.

The built-in SoundCloud source is enabled only for a final same-track fallback. The bot sends a finite set of explicit `scsearch:` queries, derived only from trusted title identity, after a YouTube URL resolved to trusted non-live metadata and both YouTube playback paths failed. Every result still passes exact normalized title/artist/version semantics and a two-second duration tolerance; ambiguous equal matches fail closed. No OAuth, cookie, PoToken, remote cipher, proxy, or IP-rotation feature is enabled, and SoundCloud is never described as direct YouTube audio.

The youtube-source plugin is restricted to the single `TVHTML5_SIMPLY` client. Do not add alternate client identities as an availability workaround; a source failure must continue to fail closed or proceed through the bot's independently validated same-track fallback.

`MUSIC` is deliberately omitted because the official table marks it as search-only with no playback support. `TV` is also omitted because its playback requires OAuth sign-in and it supplies no metadata. Do not add OAuth, cookies, proof tokens, visitor data, account credentials, IP rotation, or other identity workarounds to this anonymous deployment profile. The pinned youtube-source `1.18.2` release includes playback fixes for format itag `18` and Spring compatibility fixes.

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
4. Lavalink logs show the youtube plugin loaded without source exceptions.
5. When testing the optional same-track fallback, the Discord success reply says `SoundCloud 同曲備援` and `/music status` reports the actual current source as `soundcloud`; a no-match or ambiguous match must fail without reporting playback.

`/music test` only plays a local generated tone. It validates Discord voice/ffmpeg, not YouTube or Lavalink source loading.

Public fallback can be enabled temporarily with `LAVALINK_ALLOW_PUBLIC_FALLBACK=true` plus explicit `LAVALINK_PUBLIC_FALLBACK_HOST`, port, password, and secure-mode values from that provider. No public node password is embedded in the repository. Fallback is off by default, unsupported for production acceptance, and may disappear or reject traffic without notice.

## Deploy a hobby node on Render

The repository root includes a `render.yaml` Blueprint and a digest-pinned Dockerfile under `deploy/lavalink`. The Blueprint deploys a free Singapore web service, prompts for `LAVALINK_SERVER_PASSWORD`, uses Render's injected `PORT`, and limits the JVM heap to 384 MiB.

1. Open `https://dashboard.render.com/blueprints` and create a Blueprint from `https://github.com/xichengyu810067-lab/xiaoji`.
2. Keep the Blueprint path as `render.yaml` and provide a new long random `LAVALINK_SERVER_PASSWORD` when prompted.
3. Wait for `xiaoji-lavalink` to become live and confirm the logs show Lavalink 4.2.2 plus youtube-source 1.18.2.
4. Configure Xiaoji with the generated `*.onrender.com` hostname, port `443`, the same password, and `LAVALINK_SECURE=true`.

Render's free web service is suitable for hobby verification, not a production SLA. It can restart and normally spins down after inactivity; an active Lavalink WebSocket exchanges messages and should keep it awake, while Xiaoji already reconnects after interruptions. Upgrade or move the same Docker bundle to an always-on host if reliable production playback is required.
