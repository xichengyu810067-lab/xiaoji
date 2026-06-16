const { Shoukaku, Connectors } = require('shoukaku');
const { Kazagumo, KazagumoPlayer, KazagumoTrack } = require('kazagumo');
const logger = require('../utils/logger');

// Public nodes list - ideally this should be in config, but we hardcode a reliable one for now
const Nodes = [
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
];

let kazagumoClient = null;

function initializeLavalink(client) {
  if (kazagumoClient) return kazagumoClient;

  kazagumoClient = new Kazagumo({
    defaultSearchEngine: 'youtube',
    send: (guildId, payload) => {
        const guild = client.guilds.cache.get(guildId);
        if (guild) guild.shard.send(payload);
    }
  }, new Connectors.DiscordJS(client), Nodes, {
    moveOnDisconnect: false,
    resumable: false,
    resumableTimeout: 30,
    reconnectTries: 2,
    restTimeout: 10000,
  });

  kazagumoClient.shoukaku.on('error', (_, error) => logger.warn(`Shoukaku Error: ${error}`));
  kazagumoClient.shoukaku.on('ready', (name) => logger.info(`Lavalink Node: ${name} is ready!`));
  kazagumoClient.shoukaku.on('close', (name, code, reason) => logger.warn(`Lavalink Node: ${name} closed with code ${code}. Reason: ${reason || 'No reason'}`));
  kazagumoClient.shoukaku.on('disconnect', (name, players, moved) => {
      if (moved) return;
      players.map(player => player.connection.disconnect());
      logger.warn(`Lavalink Node: ${name} disconnected`);
  });

  kazagumoClient.shoukaku.on('ready', (name) => logger.info(`Kazagumo connected to Node: ${name}`));
  
  kazagumoClient.on("playerStart", (player, track) => {
    client.channels.cache.get(player.textId)?.send({ content: `正在播放：**${track.title}**` }).catch(() => {});
  });

  kazagumoClient.on("playerEnd", (player) => {
    // idle leave timeout will be handled by checking player state later
  });

  kazagumoClient.on("playerEmpty", (player) => {
    // This is fired when the queue is empty
  });

  kazagumoClient.on("playerError", (player, type, error) => {
    logger.error(`Player error: ${type}`, error);
    client.channels.cache.get(player.textId)?.send({ content: `播放錯誤：${type}` }).catch(() => {});
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
