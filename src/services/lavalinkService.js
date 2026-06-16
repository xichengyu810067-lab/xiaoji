const { Connectors, Constants } = require('shoukaku');
const { Kazagumo } = require('kazagumo');
const logger = require('../utils/logger');

let kazagumoClient = null;

const CONNECTION_STATE = Constants?.State || {};

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
      logger.info(`[Lavalink] raw ${formatNodeLogContext(name, { op })}`);
  });
}

function initializeLavalink(client) {
  if (kazagumoClient) return kazagumoClient;

  const nodes = getNodesFromEnv();
  
  if (nodes.length === 0) {
      logger.warn('Lavalink 初始化警告：未找到任何節點設定。請在 .env 中設定 LAVALINK_HOST 等環境變數。');
  } else {
      logger.info(`準備連線至 ${nodes.length} 個 Lavalink 節點...`);
      logLavalinkConfigSummary(nodes);
  }

  kazagumoClient = new Kazagumo({
    defaultSearchEngine: 'youtube',
    send: (guildId, payload) => {
        const guild = client.guilds.cache.get(guildId);
        if (guild) guild.shard.send(payload);
    }
  }, new Connectors.DiscordJS(client), nodes, {
    moveOnDisconnect: false,
    resumable: false,
    resumableTimeout: 30,
    reconnectTries: 2,
    restTimeout: 10000,
  });

  attachShoukakuDiagnostics(kazagumoClient.shoukaku);
  kazagumoClient.shoukaku.on('disconnect', (name, players, moved) => {
      if (moved) return;
      if (Array.isArray(players)) {
        players.map(player => player.connection.disconnect());
      }
  });

  kazagumoClient.on("playerStart", (player, track) => {
    client.channels.cache.get(player.textId)?.send({ content: `正在播放：**${track.title}**` }).catch(() => {});
  });

  kazagumoClient.on("playerError", (player, type, error) => {
    logger.error(`[Lavalink] 播放器錯誤 (${type})`, error);
    client.channels.cache.get(player.textId)?.send({ content: `播放發生錯誤：${type}` }).catch(() => {});
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

function getLavalinkStatus() {
    const configuredNodes = getNodesFromEnv();
    const runtimeNodes = kazagumoClient?.shoukaku?.nodes || new Map();
    const nodes = configuredNodes.map((node) => {
        const runtimeNode = runtimeNodes.get?.(node.name);

        return {
            name: node.name,
            url: node.url,
            secure: Boolean(node.secure),
            source: node.source || (process.env.LAVALINK_HOST ? 'env' : 'default'),
            status: kazagumoClient ? getRuntimeNodeStatus(runtimeNode) : 'not_initialized',
            hasPassword: Boolean(node.auth),
        };
    });

    return {
        initialized: Boolean(kazagumoClient),
        usingDefaultNodes: !process.env.LAVALINK_HOST,
        configuredNodeCount: configuredNodes.length,
        connectedNodeCount: kazagumoClient ? nodes.filter((node) => node.status === 'connected').length : 0,
        nodes,
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
};
