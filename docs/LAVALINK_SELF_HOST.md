# Lavalink v4 independent host

Xiaoji's production music path requires a separately hosted Lavalink node. The current NyankoHost bot container is Node-only and must not be treated as a Java/Docker sidecar host.

This bundle pins Lavalink `4.2.2` and the official youtube-source plugin `1.18.2`. The version and configuration choices were checked against the official [Lavalink repository](https://github.com/lavalink-devs/Lavalink), [Docker guide](https://lavalink.dev/getting-started/docker), and [youtube-source repository](https://github.com/lavalink-devs/youtube-source). The built-in YouTube source is disabled as required by the plugin documentation.

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
