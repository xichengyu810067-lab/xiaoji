const { SlashCommandBuilder } = require('discord.js');
const {
  enqueueTrack,
  getMusicUserFacingError,
  getQueue,
  joinMusicVoiceChannel,
  leaveVoiceChannel,
  pauseMusic,
  playTestTone,
  resumeMusic,
  skipTrack,
  stopMusic,
  validateVoiceChannelForPlayback,
} = require('../services/musicService');
const { getLavalinkStatus } = require('../services/lavalinkService');
const logger = require('../utils/logger');

function formatQueue(queueState) {
  const lines = [];

  if (queueState.current) {
    lines.push(`正在播放：**${queueState.current.title}**`);
  } else {
    lines.push('目前沒有正在播放的音樂。');
  }

  if (queueState.queue.length > 0) {
    lines.push('', ...queueState.queue.slice(0, 10).map((track, index) => `${index + 1}. ${track.title}`));
  }

  return lines.join('\n');
}

function formatLavalinkStatus(status) {
  const source = status.usingDefaultNodes ? '預設公開節點' : '.env 自訂節點';
  const lines = [
    '**Lavalink 音樂節點狀態**',
    `initialized: ${status.initialized} (${status.initialized ? '已初始化' : '尚未初始化'})`,
    `usingDefaultNodes: ${status.usingDefaultNodes} (${source})`,
    `configuredNodeCount: ${status.configuredNodeCount}`,
    `runtimeNodeCount: ${status.runtimeNodeCount ?? 0}`,
    `runtimeNodeKeys: ${status.runtimeNodeKeys?.length ? status.runtimeNodeKeys.join(', ') : 'none'}`,
    `connectedNodeCount: ${status.connectedNodeCount}`,
  ];

  if (status.nodes.length > 0) {
    lines.push(
      '',
      ...status.nodes.map(
        (node) =>
          `• name=${node.name} runtimeKey=${node.runtimeKey || 'not_found'} url=${node.secure ? 'wss' : 'ws'}://${node.url} secure=${node.secure} source=${node.source} status=${node.status}`
      )
    );
  }

  if (status.runtimeOnlyNodes?.length > 0) {
    lines.push(
      '',
      'Runtime-only nodes:',
      ...status.runtimeOnlyNodes.map((node) => `• key=${node.key} name=${node.name} status=${node.status}`)
    );
  }

  if (status.connectedNodeCount === 0) {
    lines.push(
      '',
      '目前沒有可用 Lavalink 節點。請 owner 檢查：',
      '- LAVALINK_HOST 是否正確',
      '- LAVALINK_PORT 是否正確',
      '- LAVALINK_SECURE 是否符合節點協定',
      '- LAVALINK_PASSWORD 是否正確',
      '- public node 是否允許外部連線',
      '- hosting 是否阻擋 websocket outbound'
    );
  }

  return lines.join('\n');
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('music')
    .setDescription('播放 YouTube 音樂')
    .addSubcommand((subcommand) => subcommand.setName('join').setDescription('只測試小吉能否加入你的語音頻道'))
    .addSubcommand((subcommand) => subcommand.setName('test').setDescription('播放固定測試音，檢查 voice/player/ffmpeg'))
    .addSubcommand((subcommand) =>
      subcommand
        .setName('play')
        .setDescription('播放 YouTube 影片或搜尋歌曲')
        .addStringOption((option) =>
          option.setName('url').setDescription('YouTube 影片連結或搜尋關鍵字').setRequired(true).setMaxLength(300)
        )
    )
    .addSubcommand((subcommand) => subcommand.setName('queue').setDescription('查看播放佇列'))
    .addSubcommand((subcommand) => subcommand.setName('status').setDescription('查看 Lavalink 音樂節點狀態'))
    .addSubcommand((subcommand) => subcommand.setName('skip').setDescription('跳過目前歌曲'))
    .addSubcommand((subcommand) => subcommand.setName('pause').setDescription('暫停播放'))
    .addSubcommand((subcommand) => subcommand.setName('resume').setDescription('繼續播放'))
    .addSubcommand((subcommand) => subcommand.setName('stop').setDescription('停止播放並清空佇列'))
    .addSubcommand((subcommand) => subcommand.setName('leave').setDescription('讓小吉離開語音頻道')),

  async execute(interaction) {
    const subcommand = interaction.options.getSubcommand();

    if (subcommand === 'queue') {
      await interaction.reply({ content: formatQueue(getQueue(interaction.guildId)), ephemeral: true });
      return;
    }

    if (subcommand === 'status') {
      await interaction.reply({ content: formatLavalinkStatus(getLavalinkStatus()), ephemeral: true });
      return;
    }

    if (subcommand === 'skip') {
      const skippedTrack = skipTrack(interaction.guildId);
      await interaction.reply({
        content: skippedTrack ? `已跳過：${skippedTrack.title}` : '目前沒有正在播放的音樂。',
        ephemeral: true,
      });
      return;
    }

    if (subcommand === 'pause') {
      await interaction.reply({
        content: pauseMusic(interaction.guildId) ? '已暫停播放。' : '目前沒有可以暫停的音樂。',
        ephemeral: true,
      });
      return;
    }

    if (subcommand === 'resume') {
      await interaction.reply({
        content: resumeMusic(interaction.guildId) ? '已繼續播放。' : '目前沒有可以繼續的音樂。',
        ephemeral: true,
      });
      return;
    }

    if (subcommand === 'stop') {
      stopMusic(interaction.guildId);
      await interaction.reply({ content: '已停止播放、清空佇列，並離開語音頻道。', ephemeral: true });
      return;
    }

    if (subcommand === 'leave') {
      const left = leaveVoiceChannel(interaction.guildId);
      await interaction.reply({
        content: left ? '小吉已離開語音頻道。' : '小吉目前不在語音頻道。',
        ephemeral: true,
      });
      return;
    }

    if (!interaction.inGuild() || !interaction.channel?.isTextBased?.()) {
      await interaction.reply({ content: '音樂指令只能在伺服器文字頻道使用。', ephemeral: true });
      return;
    }

    const voiceChannel = interaction.member?.voice?.channel;

    if (!voiceChannel) {
      await interaction.reply({ content: `請先加入語音頻道，再使用 /music ${subcommand}。`, ephemeral: true });
      return;
    }

    if (subcommand === 'join') {
      await interaction.deferReply({ ephemeral: true });

      try {
        const result = await joinMusicVoiceChannel({
          guild: interaction.guild,
          voiceChannel,
          textChannel: interaction.channel,
        });

        await interaction.editReply(`小吉已加入語音頻道：${result.channelName}`);
      } catch (error) {
        logger.warn(`music join command failed in guild ${interaction.guildId}: ${error?.message || error}`);
        await interaction.editReply(getMusicUserFacingError(error));
      }

      return;
    }

    if (subcommand === 'test') {
      await interaction.deferReply();

      try {
        const result = await playTestTone({
          guild: interaction.guild,
          voiceChannel,
          textChannel: interaction.channel,
        });

        await interaction.editReply(`正在播放 ${result.durationSeconds} 秒測試音：${result.track.title}`);
      } catch (error) {
        logger.warn(`music test command failed in guild ${interaction.guildId}: ${error?.message || error}`);
        await interaction.editReply(`無法播放測試音：${getMusicUserFacingError(error)}`);
      }

      return;
    }

    try {
      validateVoiceChannelForPlayback(voiceChannel);
    } catch (error) {
      await interaction.reply({ content: error.message, ephemeral: true });
      return;
    }

    await interaction.deferReply();

    try {
      const result = await enqueueTrack({
        guild: interaction.guild,
        voiceChannel,
        textChannel: interaction.channel,
        url: interaction.options.getString('url', true),
        requestedBy: interaction.user.id,
      });

      await interaction.editReply(
        result.started ? `已開始播放：${result.track.title}` : `已加入播放佇列：${result.track.title}`
      );
    } catch (error) {
      logger.warn(`music play command failed in guild ${interaction.guildId}: ${error?.message || error}`);
      await interaction.editReply(`無法播放：${getMusicUserFacingError(error)}`);
    }
  },
};

module.exports.formatQueue = formatQueue;
module.exports.formatLavalinkStatus = formatLavalinkStatus;
