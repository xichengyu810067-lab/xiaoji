const { SlashCommandBuilder } = require('discord.js');
const {
  enqueueTrack,
  getQueue,
  leaveVoiceChannel,
  pauseMusic,
  resumeMusic,
  skipTrack,
  stopMusic,
} = require('../services/musicService');

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

module.exports = {
  data: new SlashCommandBuilder()
    .setName('music')
    .setDescription('播放 YouTube 音樂')
    .addSubcommand((subcommand) =>
      subcommand
        .setName('play')
        .setDescription('播放 YouTube 影片')
        .addStringOption((option) =>
          option.setName('url').setDescription('YouTube 影片連結').setRequired(true).setMaxLength(300)
        )
    )
    .addSubcommand((subcommand) => subcommand.setName('queue').setDescription('查看播放佇列'))
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
      await interaction.reply({ content: '請先加入語音頻道，再使用 /music play。', ephemeral: true });
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
      await interaction.editReply(`無法播放這個 YouTube 連結：${error.message}`);
    }
  },
};

module.exports.formatQueue = formatQueue;
