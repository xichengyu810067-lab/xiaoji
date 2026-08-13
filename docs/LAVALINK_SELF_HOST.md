# Lavalink v4 independent host

Xiaoji's production music path requires a separately hosted Lavalink node. The current NyankoHost bot container is Node-only and must not be treated as a Java/Docker sidecar host.

This bundle pins Lavalink `4.2.2` and the official youtube-source plugin `1.18.2`. The version and configuration choices were checked against the official [Lavalink repository](https://github.com/lavalink-devs/Lavalink), [Docker guide](https://lavalink.dev/getting-started/docker), and [youtube-source repository](https://github.com/lavalink-devs/youtube-source). The built-in YouTube source is disabled as required by the plugin documentation.

The plugin queries clients in configured order. This bundle uses `IOS`, then `MWEB`, `ANDROID_MUSIC`, and `TVHTML5_SIMPLY`. The official capability table marks all four as OAuth-free clients with both playback and video metadata support; `IOS` is intentionally first. `IOS` does not return Opus formats, so Lavalink may transcode its audio. `ANDROID_MUSIC` is a playback-capable client and is distinct from `MUSIC`.

`MUSIC` is deliberately omitted because the official table marks it as search-only with no playback support. Search remains enabled and is handled by the configured playback-capable clients. `TV` is also omitted because its playback requires OAuth sign-in and it supplies no metadata. Do not add OAuth, cookies, proof tokens, account credentials, IP rotation, or other identity workarounds to this anonymous deployment profile. The pinned youtube-source `1.18.2` release includes playback fixes for format itag `18` and Spring compatibility fixes.

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

`/music test` only plays a local generated tone. It validates Discord voice/ffmpeg, not YouTube or Lavalink source loading.

Public fallback can be enabled temporarily with `LAVALINK_ALLOW_PUBLIC_FALLBACK=true` plus explicit `LAVALINK_PUBLIC_FALLBACK_HOST`, port, password, and secure-mode values from that provider. No public node password is embedded in the repository. Fallback is off by default, unsupported for production acceptance, and may disappear or reject traffic without notice.

## Deploy a hobby node on Render

The repository root includes a `render.yaml` Blueprint and a digest-pinned Dockerfile under `deploy/lavalink`. The Blueprint deploys a free Singapore web service, prompts for `LAVALINK_SERVER_PASSWORD`, uses Render's injected `PORT`, and limits the JVM heap to 384 MiB.

1. Open `https://dashboard.render.com/blueprints` and create a Blueprint from `https://github.com/xichengyu810067-lab/xiaoji`.
2. Keep the Blueprint path as `render.yaml` and provide a new long random `LAVALINK_SERVER_PASSWORD` when prompted.
3. Wait for `xiaoji-lavalink` to become live and confirm the logs show Lavalink 4.2.2 plus youtube-source 1.18.2.
4. Configure Xiaoji with the generated `*.onrender.com` hostname, port `443`, the same password, and `LAVALINK_SECURE=true`.

Render's free web service is suitable for hobby verification, not a production SLA. It can restart and normally spins down after inactivity; an active Lavalink WebSocket exchanges messages and should keep it awake, while Xiaoji already reconnects after interruptions. Upgrade or move the same Docker bundle to an always-on host if reliable production playback is required.
