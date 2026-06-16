const { Shoukaku, Connectors } = require('shoukaku');
const { Kazagumo } = require('kazagumo');
const logger = require('../utils/logger');

let kazagumoClient = null;

function getNodesFromEnv() {
    const nodes = [];
    
    // Check if user has configured a custom node in .env
    if (process.env.LAVALINK_HOST) {
        nodes.push({
            name: process.env.LAVALINK_NODE_NAME || 'CustomNode',
            url: `${process.env.LAVALINK_HOST}:${process.env.LAVALINK_PORT || 2333}`,
            auth: process.env.LAVALINK_PASSWORD || 'youshallnotpass',
            secure: process.env.LAVALINK_SECURE === 'true',
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
            },
            {
                name: 'NyxBot SG1',
                url: 'sg1-nodelink.nyxbot.app:3000',
                auth: 'nyxbot.app/support',
                secure: false,
            }
        );
    }

    return nodes;
}

function initializeLavalink(client) {
  if (kazagumoClient) return kazagumoClient;

  const nodes = getNodesFromEnv();
  
  if (nodes.length === 0) {
      logger.warn('Lavalink 初始化警告：未找到任何節點設定。請在 .env 中設定 LAVALINK_HOST 等環境變數。');
  } else {
      logger.info(`準備連線至 ${nodes.length} 個 Lavalink 節點...`);
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

  kazagumoClient.shoukaku.on('error', (name, error) => logger.error(`[Lavalink] 節點 ${name} 發生錯誤: ${error?.message || error}`));
  kazagumoClient.shoukaku.on('ready', (name) => {
      logger.info(`[Lavalink] 節點 ${name} 已成功連線！`);
      logger.info(`[Lavalink] 目前可用節點數量：${kazagumoClient.shoukaku.nodes.size}`);
  });
  kazagumoClient.shoukaku.on('close', (name, code, reason) => logger.warn(`[Lavalink] 節點 ${name} 已斷線 (代碼 ${code})。原因: ${reason || '無'}`));
  kazagumoClient.shoukaku.on('disconnect', (name, players, moved) => {
      if (moved) return;
      players.map(player => player.connection.disconnect());
      logger.warn(`[Lavalink] 節點 ${name} 失去連線`);
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

function getKazagumo() {
    if (!kazagumoClient) {
        throw new Error('Lavalink client has not been initialized. Please ensure the bot is ready.');
    }
    return kazagumoClient;
}

module.exports = {
  initializeLavalink,
  getKazagumo,
};
