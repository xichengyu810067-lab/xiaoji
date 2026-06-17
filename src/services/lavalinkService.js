const { Connectors, Constants } = require('shoukaku');
const { Kazagumo } = require('kazagumo');
const logger = require('../utils/logger');

let kazagumoClient = null;
let lastInitializationDiagnostics = null;
let discordVoiceRawDiagnosticsAttached = false;

const CONNECTION_STATE = Constants?.State || {};
const PLAYER_STATE_LABELS = {
    0: 'connecting',
    1: 'connected',
    2: 'disconnecting',
    3: 'disconnected',
    4: 'destroying',
    5: 'destroyed',
};
const playbackDiagnosticsByGuild = new Map();
const pendingPlaybackStartsByGuild = new Map();

function toIsoTime(ms = Date.now()) {
    return new Date(ms).toISOString();
}

function isRecent(timestampMs, withinMs = 60_000) {
    return Boolean(timestampMs && Date.now() - timestampMs <= withinMs);
}

function getPlaybackDiagnostics(guildId) {
    if (!guildId) {
        return null;
    }

    if (!playbackDiagnosticsByGuild.has(guildId)) {
        playbackDiagnosticsByGuild.set(guildId, {
            guildId,
            lastEvent: null,
            lastPlayerStartAt: null,
            lastPlayerStartAtMs: null,
            lastPlayerEndAt: null,
            lastPlayerEndAtMs: null,
            lastPlayerErrorAt: null,
            lastPlayerErrorAtMs: null,
            lastPlayerUpdateAt: null,
            lastPlayerUpdateAtMs: null,
            lastTrackStartEventAt: null,
            lastTrackStartEventAtMs: null,
            lastTrackEndEventAt: null,
            lastTrackEndEventAtMs: null,
            lastTrackExceptionEventAt: null,
            lastTrackExceptionEventAtMs: null,
            lastTrackStuckEventAt: null,
            lastTrackStuckEventAtMs: null,
            lastVoiceStateUpdateAt: null,
            lastVoiceStateUpdateAtMs: null,
            lastVoiceServerUpdateAt: null,
            lastVoiceServerUpdateAtMs: null,
            lastPosition: null,
            previousPosition: null,
            positionIncreased: false,
            lastTrackTitle: null,
            lastTrackEventType: null,
            lastPlayerError: null,
            lastVoiceChannelId: null,
            lastVoiceEndpointPresent: null,
            lastVoiceTokenPresent: null,
        });
    }

    return playbackDiagnosticsByGuild.get(guildId);
}

function resolvePendingPlaybackStart(guildId, eventType, payload = {}) {
    const pending = pendingPlaybackStartsByGuild.get(guildId);

    if (!pending?.length) {
        return;
    }

    pendingPlaybackStartsByGuild.delete(guildId);

    for (const waiter of pending) {
        clearTimeout(waiter.timer);
        waiter.resolve({
            confirmed: true,
            eventType,
            guildId,
            at: toIsoTime(),
            ...payload,
        });
    }
}

function setDiagnosticTimestamp(diagnostics, key, timestampMs = Date.now()) {
    diagnostics[key] = toIsoTime(timestampMs);
    diagnostics[`${key}Ms`] = timestampMs;
}

function recordPlaybackEvent(guildId, eventType, payload = {}) {
    const diagnostics = getPlaybackDiagnostics(guildId);

    if (!diagnostics) {
        return null;
    }

    const timestampMs = Date.now();
    diagnostics.lastEvent = eventType;
    diagnostics.lastTrackEventType = payload.trackEventType || diagnostics.lastTrackEventType;

    if (typeof payload.position === 'number') {
        diagnostics.previousPosition = diagnostics.lastPosition;
        diagnostics.lastPosition = payload.position;
        diagnostics.positionIncreased =
            typeof diagnostics.previousPosition === 'number' && payload.position > diagnostics.previousPosition;
    }

    if (payload.trackTitle) {
        diagnostics.lastTrackTitle = payload.trackTitle;
    }

    if (payload.errorMessage) {
        diagnostics.lastPlayerError = payload.errorMessage;
    }

    if (payload.voiceChannelId !== undefined) {
        diagnostics.lastVoiceChannelId = payload.voiceChannelId;
    }

    if (payload.endpointPresent !== undefined) {
        diagnostics.lastVoiceEndpointPresent = payload.endpointPresent;
    }

    if (payload.tokenPresent !== undefined) {
        diagnostics.lastVoiceTokenPresent = payload.tokenPresent;
    }

    const timestampKeyByEvent = {
        playerStart: 'lastPlayerStartAt',
        playerEnd: 'lastPlayerEndAt',
        playerError: 'lastPlayerErrorAt',
        playerUpdate: 'lastPlayerUpdateAt',
        TrackStartEvent: 'lastTrackStartEventAt',
        TrackEndEvent: 'lastTrackEndEventAt',
        TrackExceptionEvent: 'lastTrackExceptionEventAt',
        TrackStuckEvent: 'lastTrackStuckEventAt',
        voiceStateUpdate: 'lastVoiceStateUpdateAt',
        voiceServerUpdate: 'lastVoiceServerUpdateAt',
    };
    const timestampKey = timestampKeyByEvent[eventType];

    if (timestampKey) {
        setDiagnosticTimestamp(diagnostics, timestampKey, timestampMs);
    }

    if (eventType === 'playerStart' || eventType === 'TrackStartEvent') {
        resolvePendingPlaybackStart(guildId, eventType, payload);
    }

    return diagnostics;
}

function waitForLavalinkPlaybackStart(guildId, timeoutMs = 5000, { startedAfter = Date.now() } = {}) {
    const diagnostics = getPlaybackDiagnostics(guildId);
    const recentPlayerStart = diagnostics?.lastPlayerStartAtMs && diagnostics.lastPlayerStartAtMs >= startedAfter;
    const recentTrackStart =
        diagnostics?.lastTrackStartEventAtMs && diagnostics.lastTrackStartEventAtMs >= startedAfter;

    if (recentPlayerStart || recentTrackStart) {
        return Promise.resolve({
            confirmed: true,
            eventType: recentPlayerStart ? 'playerStart' : 'TrackStartEvent',
            guildId,
            at: recentPlayerStart ? diagnostics.lastPlayerStartAt : diagnostics.lastTrackStartEventAt,
        });
    }

    return new Promise((resolve) => {
        const waiter = {
            resolve,
            timer: setTimeout(() => {
                const pending = pendingPlaybackStartsByGuild.get(guildId) || [];
                pendingPlaybackStartsByGuild.set(
                    guildId,
                    pending.filter((entry) => entry !== waiter)
                );
                resolve({
                    confirmed: false,
                    eventType: null,
                    guildId,
                    at: toIsoTime(),
                });
            }, timeoutMs),
        };

        waiter.timer.unref?.();
        const pending = pendingPlaybackStartsByGuild.get(guildId) || [];
        pending.push(waiter);
        pendingPlaybackStartsByGuild.set(guildId, pending);
    });
}

function getNodesFromEnv() {
    const nodes = [];
    const hasCustomNode = Boolean(process.env.LAVALINK_HOST);
    
    // Check if user has configured a custom node in .env
    if (hasCustomNode) {
        nodes.push({
            name: process.env.LAVALINK_NODE_NAME || 'CustomNode',
            url: `${process.env.LAVALINK_HOST}:${process.env.LAVALINK_PORT || 2333}`,
            auth: process.env.LAVALINK_PASSWORD || 'youshallnotpass',
            secure: process.env.LAVALINK_SECURE === 'true',
            source: 'env',
        });
    }

    // Default reliable public nodes as fallback if no custom node is provided
    if (nodes.length === 0) {
        nodes.push(
            {
                name: 'Jirayu',
                url: 'lavalink.jirayu.net:13592',
                auth: 'youshallnotpass',
                secure: false,
                source: 'default',
            },
            {
                name: 'NyxBot SG1',
                url: 'sg1-nodelink.nyxbot.app:3000',
                auth: 'nyxbot.app/support',
                secure: false,
                source: 'default',
            }
        );
    }

    return nodes;
}

function parseNodeUrl(url) {
    const [host, ...portParts] = String(url || '').split(':');
    return {
        host: host || 'unknown',
        port: portParts.join(':') || 'unknown',
    };
}

function getNodePublicUrl(node) {
    return `${node.secure ? 'wss' : 'ws'}://${node.url}`;
}

function getSafeNodeSummary(node) {
    const { host, port } = parseNodeUrl(node.url);

    return {
        name: node.name,
        host,
        port,
        secure: Boolean(node.secure),
        hasPassword: Boolean(node.auth),
        source: node.source || 'unknown',
        url: getNodePublicUrl(node),
    };
}

function getConfiguredNodeByName(name) {
    return getNodesFromEnv().find((node) => node.name === name);
}

function getRuntimeNode(name) {
    return kazagumoClient?.shoukaku?.nodes?.get?.(name);
}

function getRuntimeNodeKeys(shoukaku = kazagumoClient?.shoukaku) {
    return [...(shoukaku?.nodes?.keys?.() || [])];
}

function scrubNodeSecret(value, node) {
    let output = String(value ?? '');
    if (node?.auth) {
        output = output.split(node.auth).join('[redacted-lavalink-password]');
    }
    return output;
}

function getNodeStateLabel(runtimeNode) {
    if (!runtimeNode) {
        return 'not_found';
    }

    if (runtimeNode.state === CONNECTION_STATE.CONNECTING) {
        return 'connecting';
    }

    if (runtimeNode.state === CONNECTION_STATE.CONNECTED) {
        return 'connected';
    }

    if (runtimeNode.state === CONNECTION_STATE.DISCONNECTING) {
        return 'disconnecting';
    }

    if (runtimeNode.state === CONNECTION_STATE.DISCONNECTED) {
        return 'disconnected';
    }

    return String(runtimeNode.state ?? runtimeNode.status ?? 'unknown');
}

function getConnectionStateLabel(state) {
    if (state === CONNECTION_STATE.CONNECTING) {
        return 'connecting';
    }

    if (state === CONNECTION_STATE.CONNECTED) {
        return 'connected';
    }

    if (state === CONNECTION_STATE.DISCONNECTING) {
        return 'disconnecting';
    }

    if (state === CONNECTION_STATE.DISCONNECTED) {
        return 'disconnected';
    }

    return String(state ?? 'unknown');
}

function getPlayerStateLabel(state) {
    return PLAYER_STATE_LABELS[state] || String(state ?? 'unknown');
}

function formatNodeLogContext(name, extra = {}) {
    const configuredNode = getConfiguredNodeByName(name);
    const runtimeNode = getRuntimeNode(name);
    const summary = configuredNode ? getSafeNodeSummary(configuredNode) : null;
    const details = {
        node: name,
        url: summary?.url || 'unknown',
        secure: summary ? summary.secure : 'unknown',
        source: summary?.source || 'unknown',
        state: getNodeStateLabel(runtimeNode),
        reconnects: runtimeNode?.reconnects ?? 'unknown',
        ...extra,
    };

    return Object.entries(details)
        .map(([key, value]) => `${key}=${value}`)
        .join(' ');
}

function logLavalinkConfigSummary(nodes) {
    const source = nodes.some((node) => node.source === 'env') ? 'env custom node' : 'default nodes';
    logger.info(`[Lavalink] 設定摘要：source=${source}, configuredNodeCount=${nodes.length}`);

    for (const node of nodes) {
        const summary = getSafeNodeSummary(node);
        logger.info(
            `[Lavalink] 節點設定：name=${summary.name}, host=${summary.host}, port=${summary.port}, secure=${summary.secure}, hasPassword=${summary.hasPassword ? 'yes' : 'no'}, source=${summary.source}`
        );
    }
}

function logNodeRuntimeSnapshot(label, nodes, kazagumo, client) {
    const shoukaku = kazagumo?.shoukaku;
    const runtimeNodeKeys = getRuntimeNodeKeys(shoukaku);
    const diagnostics = {
        label,
        nodesArrayPassed: Array.isArray(nodes),
        nodesArrayCount: Array.isArray(nodes) ? nodes.length : 0,
        kazagumoInitialized: Boolean(kazagumo),
        shoukakuInitialized: Boolean(shoukaku),
        connectorInitialized: Boolean(shoukaku?.connector),
        shoukakuIdPresent: Boolean(shoukaku?.id),
        discordClientReady: Boolean(client?.isReady?.() || client?.readyAt),
        runtimeNodeCount: shoukaku?.nodes?.size ?? 0,
        runtimeNodeKeys,
    };

    lastInitializationDiagnostics = diagnostics;
    logger.info(
        `[Lavalink] runtime snapshot ${label}: nodesArrayPassed=${diagnostics.nodesArrayPassed}, nodesArrayCount=${diagnostics.nodesArrayCount}, kazagumoInitialized=${diagnostics.kazagumoInitialized}, shoukakuInitialized=${diagnostics.shoukakuInitialized}, connectorInitialized=${diagnostics.connectorInitialized}, shoukakuIdPresent=${diagnostics.shoukakuIdPresent}, discordClientReady=${diagnostics.discordClientReady}, runtimeNodeCount=${diagnostics.runtimeNodeCount}, runtimeNodeKeys=${runtimeNodeKeys.length ? runtimeNodeKeys.join(',') : 'none'}`
    );

    if (diagnostics.runtimeNodeCount === 0) {
        logger.warn(
            `[Lavalink] runtime node count is 0: nodesArrayPassed=${diagnostics.nodesArrayPassed}, nodesArrayCount=${diagnostics.nodesArrayCount}, kazagumoInitialized=${diagnostics.kazagumoInitialized}, shoukakuInitialized=${diagnostics.shoukakuInitialized}, connectorInitialized=${diagnostics.connectorInitialized}. Shoukaku DiscordJS connector may have missed clientReady if Lavalink was initialized after Discord ready.`
        );
    }
}

function scheduleRuntimeDiagnostics(nodes, kazagumo, client) {
    for (const delayMs of [5000, 15000]) {
        const timer = setTimeout(() => {
            logNodeRuntimeSnapshot(`after_${delayMs / 1000}s`, nodes, kazagumo, client);
        }, delayMs);
        timer.unref?.();
    }
}

function ensureRuntimeNodesAfterReady(client, nodes, kazagumo) {
    const shoukaku = kazagumo?.shoukaku;
    if (!shoukaku) {
        logger.error('[Lavalink] Shoukaku instance missing immediately after Kazagumo initialization.');
        return;
    }

    const clientReady = Boolean(client?.isReady?.() || client?.readyAt);
    if (!clientReady || shoukaku.nodes.size > 0) {
        return;
    }

    const botId = client?.user?.id;
    if (!botId) {
        logger.error('[Lavalink] Cannot add runtime nodes manually because Discord client user id is missing.');
        return;
    }

    shoukaku.id = shoukaku.id || botId;
    logger.warn('[Lavalink] Discord client is already ready and Shoukaku has no runtime nodes; adding configured nodes manually.');

    for (const node of nodes) {
        try {
            if (shoukaku.nodes.has(node.name)) {
                continue;
            }

            shoukaku.addNode(node);
            logger.info(`[Lavalink] 手動建立 runtime node：name=${node.name}, url=${getNodePublicUrl(node)}, secure=${Boolean(node.secure)}, source=${node.source || 'unknown'}`);
        } catch (error) {
            const message = scrubNodeSecret(error?.message || error, node);
            logger.error(`[Lavalink] 手動建立 runtime node 失敗：name=${node.name}, message=${message}`);
        }
    }
}

function warnIfUnsupportedNodeRuntime() {
    const major = Number.parseInt(process.versions.node.split('.')[0], 10);
    if (major >= 24) {
        logger.warn(
            `[Lavalink] 目前 Node.js 版本為 ${process.version}。Kazagumo/Shoukaku 官方 engines 為 Node >=18，但音樂連線問題若仍存在，建議正式環境改用 Node 20 LTS 或 Node 22 LTS 排除 Node 24 相容性變因。`
        );
    }
}

function attachShoukakuDiagnostics(shoukaku) {
  shoukaku.on('ready', (name, lavalinkResume, libraryResume) => {
      logger.info(`[Lavalink] ready ${formatNodeLogContext(name, { lavalinkResume, libraryResume })}`);
      logger.info(`[Lavalink] 目前 runtime 節點數量：${shoukaku.nodes.size}`);
  });

  shoukaku.on('error', (name, error) => {
      const configuredNode = getConfiguredNodeByName(name);
      const message = scrubNodeSecret(error?.message || error, configuredNode);
      const stack = error?.stack ? scrubNodeSecret(error.stack, configuredNode) : '';
      logger.error(`[Lavalink] error ${formatNodeLogContext(name, { message, stack })}`);
  });

  shoukaku.on('close', (name, code, reason) => {
      const configuredNode = getConfiguredNodeByName(name);
      const safeReason = scrubNodeSecret(reason || 'none', configuredNode);
      logger.warn(`[Lavalink] close ${formatNodeLogContext(name, { code, reason: safeReason })}`);
  });

  shoukaku.on('disconnect', (name, count) => {
      logger.warn(`[Lavalink] disconnect ${formatNodeLogContext(name, { players: count })}`);
  });

  shoukaku.on('reconnecting', (name, reconnectsLeft, reconnectInterval) => {
      logger.warn(`[Lavalink] reconnecting ${formatNodeLogContext(name, { reconnectsLeft, reconnectInterval })}`);
  });

  shoukaku.on('debug', (name, info) => {
      const configuredNode = getConfiguredNodeByName(name);
      logger.info(`[Lavalink] debug ${formatNodeLogContext(name, { info: scrubNodeSecret(info, configuredNode) })}`);
  });

  shoukaku.on('raw', (name, json) => {
      const op = json && typeof json === 'object' ? json.op || json.type || 'unknown' : 'unknown';
      const guildId = json && typeof json === 'object' ? json.guildId : null;
      const eventType = json && typeof json === 'object' ? json.type : null;

      if (op === 'event') {
          if (['TrackStartEvent', 'TrackEndEvent', 'TrackExceptionEvent', 'TrackStuckEvent'].includes(eventType)) {
              recordPlaybackEvent(guildId, eventType, {
                  trackEventType: eventType,
                  errorMessage: json?.exception?.message || json?.reason || null,
              });
          }

          logger.info(`[Lavalink] raw ${formatNodeLogContext(name, { op, eventType: eventType || 'unknown', guildId: guildId || 'unknown' })}`);
          return;
      }

      if (op === 'playerUpdate') {
          recordPlaybackEvent(guildId, 'playerUpdate', {
              position: json?.state?.position,
          });
          logger.info(
              `[Lavalink] raw ${formatNodeLogContext(name, {
                  op,
                  guildId: guildId || 'unknown',
                  position: json?.state?.position ?? 'unknown',
              })}`
          );
          return;
      }

      logger.info(`[Lavalink] raw ${formatNodeLogContext(name, { op })}`);
  });
}

function attachDiscordVoiceRawDiagnostics(client) {
    if (discordVoiceRawDiagnosticsAttached) {
        return;
    }

    discordVoiceRawDiagnosticsAttached = true;
    client.on('raw', (packet) => {
        if (!packet || (packet.t !== 'VOICE_STATE_UPDATE' && packet.t !== 'VOICE_SERVER_UPDATE')) {
            return;
        }

        const guildId = packet.d?.guild_id;

        if (!guildId) {
            return;
        }

        if (packet.t === 'VOICE_STATE_UPDATE') {
            if (packet.d?.user_id !== client.user?.id) {
                return;
            }

            recordPlaybackEvent(guildId, 'voiceStateUpdate', {
                voiceChannelId: packet.d?.channel_id || null,
            });
            logger.info(
                `[Discord Voice] raw voiceStateUpdate guildId=${guildId} channelId=${packet.d?.channel_id || 'none'} sessionIdPresent=${packet.d?.session_id ? 'yes' : 'no'} selfMute=${Boolean(packet.d?.self_mute)} selfDeaf=${Boolean(packet.d?.self_deaf)}`
            );
            return;
        }

        recordPlaybackEvent(guildId, 'voiceServerUpdate', {
            endpointPresent: Boolean(packet.d?.endpoint),
            tokenPresent: Boolean(packet.d?.token),
        });
        logger.info(
            `[Discord Voice] raw voiceServerUpdate guildId=${guildId} endpointPresent=${packet.d?.endpoint ? 'yes' : 'no'} tokenPresent=${packet.d?.token ? 'yes' : 'no'}`
        );
    });
}

function initializeLavalink(client) {
  if (kazagumoClient) return kazagumoClient;

  const nodes = getNodesFromEnv();
  warnIfUnsupportedNodeRuntime();
  
  if (nodes.length === 0) {
      logger.warn('Lavalink 初始化警告：未找到任何節點設定。請在 .env 中設定 LAVALINK_HOST 等環境變數。');
  } else {
      logger.info(`準備連線至 ${nodes.length} 個 Lavalink 節點...`);
      logLavalinkConfigSummary(nodes);
  }

  try {
    kazagumoClient = new Kazagumo({
      defaultSearchEngine: 'youtube',
      send: (guildId, payload) => {
          const guild = client.guilds.cache.get(guildId);
          if (guild) guild.shard.send(payload);
      }
    }, new Connectors.DiscordJS(client), nodes, {
      moveOnDisconnect: false,
      resume: false,
      resumeTimeout: 30,
      reconnectTries: 2,
      restTimeout: 10000,
    });
  } catch (error) {
    logger.error(`[Lavalink] Kazagumo 初始化同步失敗：${error?.message || error}`);
    throw error;
  }

  logger.info('[Lavalink] Kazagumo instance created successfully.');
  logger.info(`[Lavalink] Shoukaku connector initialized: ${Boolean(kazagumoClient.shoukaku?.connector)}`);

  attachShoukakuDiagnostics(kazagumoClient.shoukaku);
  attachDiscordVoiceRawDiagnostics(client);
  ensureRuntimeNodesAfterReady(client, nodes, kazagumoClient);
  logNodeRuntimeSnapshot('immediate', nodes, kazagumoClient, client);
  scheduleRuntimeDiagnostics(nodes, kazagumoClient, client);
  kazagumoClient.shoukaku.on('disconnect', (name, players, moved) => {
      if (moved) return;
      if (Array.isArray(players)) {
        players.map(player => player.connection.disconnect());
      }
  });

  kazagumoClient.on("playerCreate", (player) => {
    logger.info(
      `[Lavalink] playerCreate guildId=${player.guildId} voiceId=${player.voiceId || 'unknown'} textId=${player.textId || 'unknown'} node=${player.node?.name || 'unknown'} state=${getPlayerStateLabel(player.state)}`
    );
  });

  kazagumoClient.on("playerStart", (player, track) => {
    recordPlaybackEvent(player.guildId, 'playerStart', {
        trackTitle: track?.title || player.queue?.current?.title || null,
        position: player.position,
    });
    logger.info(
      `[Lavalink] playerStart guildId=${player.guildId} voiceId=${player.voiceId || 'unknown'} textId=${player.textId || 'unknown'} node=${player.node?.name || 'unknown'} state=${getPlayerStateLabel(player.state)} title=${track?.title || 'unknown'}`
    );
    client.channels.cache.get(player.textId)?.send({ content: `正在播放：**${track.title}**` }).catch(() => {});
  });

  kazagumoClient.on("playerEnd", (player, track) => {
    recordPlaybackEvent(player.guildId, 'playerEnd', {
        trackTitle: track?.title || null,
        position: player.position,
    });
    logger.info(
      `[Lavalink] playerEnd guildId=${player.guildId} node=${player.node?.name || 'unknown'} state=${getPlayerStateLabel(player.state)} title=${track?.title || 'unknown'}`
    );
  });

  kazagumoClient.on("playerUpdate", (player, data) => {
    recordPlaybackEvent(player.guildId, 'playerUpdate', {
        position: data?.state?.position ?? player.position,
    });
    logger.info(
      `[Lavalink] playerUpdate guildId=${player.guildId} node=${player.node?.name || 'unknown'} state=${getPlayerStateLabel(player.state)} position=${data?.state?.position ?? player.position ?? 'unknown'} playing=${Boolean(player.playing)} paused=${Boolean(player.paused)}`
    );
  });

  kazagumoClient.on("playerError", (player, type, error) => {
    recordPlaybackEvent(player.guildId, 'playerError', {
        errorMessage: error?.message || String(error || type),
    });
    logger.error(`[Lavalink] playerError guildId=${player.guildId} node=${player.node?.name || 'unknown'} type=${type} message=${error?.message || error}`);
    client.channels.cache.get(player.textId)?.send({ content: `播放發生錯誤：${type}` }).catch(() => {});
  });

  kazagumoClient.on("playerClosed", (player, data) => {
    logger.warn(
      `[Lavalink] playerClosed guildId=${player.guildId} node=${player.node?.name || 'unknown'} code=${data?.code ?? 'unknown'} reason=${data?.reason || 'unknown'} byRemote=${data?.byRemote ?? 'unknown'}`
    );
  });

  kazagumoClient.on("playerException", (player, data) => {
    recordPlaybackEvent(player.guildId, 'TrackExceptionEvent', {
        trackEventType: 'TrackExceptionEvent',
        errorMessage: data?.exception?.message || data?.message || 'unknown',
    });
    logger.error(
      `[Lavalink] playerException guildId=${player.guildId} node=${player.node?.name || 'unknown'} message=${data?.exception?.message || data?.message || 'unknown'}`
    );
  });

  kazagumoClient.on("playerStuck", (player, data) => {
    recordPlaybackEvent(player.guildId, 'TrackStuckEvent', {
        trackEventType: 'TrackStuckEvent',
        errorMessage: `thresholdMs=${data?.thresholdMs ?? 'unknown'}`,
    });
    logger.warn(
      `[Lavalink] playerStuck guildId=${player.guildId} node=${player.node?.name || 'unknown'} thresholdMs=${data?.thresholdMs ?? 'unknown'}`
    );
  });

  kazagumoClient.on("playerDestroy", (player) => {
    logger.info(`[Lavalink] playerDestroy guildId=${player.guildId} node=${player.node?.name || 'unknown'}`);
  });

  return kazagumoClient;
}

function isConnectedNode(node) {
    if (!node) {
        return false;
    }

    const state = String(node.state ?? node.status ?? '').toLowerCase();
    return Boolean(
        node.stats ||
        node.state === CONNECTION_STATE.CONNECTED ||
        state.includes('connected') ||
        state === '1'
    );
}

function getRuntimeNodeStatus(node) {
    if (!node) {
        return 'not_found';
    }

    return getNodeStateLabel(node);
}

function getPlayerPlaybackStatus(guildId) {
    if (!guildId) {
        return null;
    }

    const diagnostics = getPlaybackDiagnostics(guildId);
    const player = kazagumoClient?.players?.get?.(guildId);
    const connection = kazagumoClient?.shoukaku?.connections?.get?.(guildId);
    const position = player?.position ?? player?.shoukaku?.position ?? null;

    return {
        guildId,
        nodeStatus: player?.node ? getNodeStateLabel(player.node) : 'not_found',
        playerExists: Boolean(player),
        playerConnected: player?.state === 1 || connection?.state === CONNECTION_STATE.CONNECTED,
        playerState: getPlayerStateLabel(player?.state),
        connectionState: getConnectionStateLabel(connection?.state),
        voiceId: player?.voiceId || connection?.channelId || null,
        textId: player?.textId || null,
        playing: Boolean(player?.playing),
        paused: Boolean(player?.paused),
        currentTrackTitle: player?.queue?.current?.title || diagnostics?.lastTrackTitle || null,
        queueLength: player?.queue?.length ?? 0,
        volume: player?.volume ?? null,
        position,
        positionIncreased: Boolean(diagnostics?.positionIncreased),
        recentTrackStartEvent: isRecent(diagnostics?.lastTrackStartEventAtMs),
        recentPlayerStart: isRecent(diagnostics?.lastPlayerStartAtMs),
        recentPlayerUpdate: isRecent(diagnostics?.lastPlayerUpdateAtMs),
        lastTrackStartEventAt: diagnostics?.lastTrackStartEventAt || null,
        lastPlayerStartAt: diagnostics?.lastPlayerStartAt || null,
        lastPlayerUpdateAt: diagnostics?.lastPlayerUpdateAt || null,
        lastVoiceStateUpdateAt: diagnostics?.lastVoiceStateUpdateAt || null,
        lastVoiceServerUpdateAt: diagnostics?.lastVoiceServerUpdateAt || null,
        lastEvent: diagnostics?.lastEvent || null,
        lastPlayerError: diagnostics?.lastPlayerError || null,
        lastVoiceChannelId: diagnostics?.lastVoiceChannelId || null,
        lastVoiceEndpointPresent: diagnostics?.lastVoiceEndpointPresent,
        lastVoiceTokenPresent: diagnostics?.lastVoiceTokenPresent,
    };
}

function getLavalinkStatus(guildId = null) {
    const configuredNodes = getNodesFromEnv();
    const runtimeNodes = kazagumoClient?.shoukaku?.nodes || new Map();
    const runtimeNodeKeys = getRuntimeNodeKeys(kazagumoClient?.shoukaku);
    const nodes = configuredNodes.map((node) => {
        const runtimeNode = runtimeNodes.get?.(node.name);

        return {
            name: node.name,
            url: node.url,
            secure: Boolean(node.secure),
            source: node.source || (process.env.LAVALINK_HOST ? 'env' : 'default'),
            status: kazagumoClient ? getRuntimeNodeStatus(runtimeNode) : 'not_initialized',
            hasPassword: Boolean(node.auth),
            runtimeKey: runtimeNode ? node.name : null,
        };
    });
    const runtimeOnlyNodes = [...runtimeNodes.entries()]
        .filter(([key]) => !configuredNodes.some((node) => node.name === key))
        .map(([key, runtimeNode]) => ({
            key,
            name: runtimeNode?.name || key,
            status: getRuntimeNodeStatus(runtimeNode),
        }));

    return {
        initialized: Boolean(kazagumoClient),
        usingDefaultNodes: !process.env.LAVALINK_HOST,
        configuredNodeCount: configuredNodes.length,
        runtimeNodeCount: runtimeNodes.size,
        runtimeNodeKeys,
        connectedNodeCount: kazagumoClient ? nodes.filter((node) => node.status === 'connected').length : 0,
        nodes,
        runtimeOnlyNodes,
        diagnostics: lastInitializationDiagnostics,
        playback: getPlayerPlaybackStatus(guildId),
    };
}

function getKazagumo() {
    if (!kazagumoClient) {
        throw new Error('Lavalink client has not been initialized. Please ensure the bot is ready.');
    }
    return kazagumoClient;
}

module.exports = {
  initializeLavalink,
  getLavalinkStatus,
  getKazagumo,
  waitForLavalinkPlaybackStart,
};
