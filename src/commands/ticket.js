const { ChannelType, PermissionFlagsBits, SlashCommandBuilder } = require('discord.js');
const { getGuildConfig, setTicketConfig } = require('../utils/guildConfig');
const { isBotOwner } = require('../utils/ownerOnly');
const { ensureModerationAccess, handleCommandError, replyEphemeral, sendModerationLog } = require('../utils/moderation');
const { TicketStateError, closeTicket, openTicket, readTicketState, getOpenTicket } = require('../services/ticketService');

async function replyTicketError(interaction, message) {
  if (interaction.deferred && !interaction.replied) {
    await interaction.editReply({ content: message });
    return;
  }
  await replyEphemeral(interaction, message);
}

async function executeSetup(interaction) {
  const intakeChannel = interaction.options.getChannel('intake-channel', true);
  const supportRole = interaction.options.getRole('support-role', true);
  const access = await ensureModerationAccess(interaction, {
    userPermission: PermissionFlagsBits.ManageGuild,
    userPermissionName: 'Manage Server',
    botPermissions: [PermissionFlagsBits.ManageChannels],
    botPermissionNames: ['Manage Channels'],
  });

  if (!access.ok) return;
  if (!intakeChannel?.isTextBased?.() || supportRole.id === interaction.guild.id || supportRole.managed) {
    await replyEphemeral(interaction, '請選擇有效的客服文字頻道與可指派的客服角色。');
    return;
  }

  setTicketConfig(interaction.guildId, { intakeChannelId: intakeChannel.id, supportRoleId: supportRole.id });
  await interaction.reply({
    content: `客服入口已設定為 ${intakeChannel}，客服角色為 ${supportRole}。`,
    ephemeral: true,
  });
  await sendModerationLog(interaction, {
    action: '/ticket setup',
    target: `${intakeChannel} / ${supportRole}`,
    reason: '設定客服單入口與客服角色',
  });
}

async function executeOpen(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const result = await openTicket({
    guild: interaction.guild,
    channelId: interaction.channelId,
    user: interaction.user,
    subject: interaction.options.getString('subject'),
  });
  await interaction.editReply(`客服單已建立：${result.channel}`);
}

async function executeClose(interaction) {
  const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
  await interaction.deferReply({ ephemeral: true });
  await closeTicket({
    guild: interaction.guild,
    channelId: interaction.channelId,
    closer: interaction.user,
    closerMember: member,
    ownerOverride: isBotOwner(interaction.user.id),
    reason: interaction.options.getString('reason'),
  });
  await interaction.editReply('客服單已關閉。');
}

async function executeStatus(interaction) {
  const config = getGuildConfig(interaction.guildId);
  const state = readTicketState();
  const open = getOpenTicket(state, interaction.guildId, interaction.user.id);
  await replyEphemeral(
    interaction,
    [
      `客服入口：${config.ticket.intakeChannelId ? `<#${config.ticket.intakeChannelId}>` : '未設定'}`,
      `客服角色：${config.ticket.supportRoleId ? `<@&${config.ticket.supportRoleId}>` : '未設定'}`,
      `你的客服單：${open ? `<#${open.channelId}>` : '目前沒有開啟中的客服單'}`,
    ].join('\n')
  );
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('ticket')
    .setDescription('建立與管理私人客服單')
    .setDMPermission(false)
    .addSubcommand((subcommand) =>
      subcommand
        .setName('setup')
        .setDescription('設定客服入口頻道與客服角色')
        .addChannelOption((option) =>
          option
            .setName('intake-channel')
            .setDescription('只允許在此頻道開啟客服單')
            .setRequired(true)
            .addChannelTypes(ChannelType.GuildText)
        )
        .addRoleOption((option) => option.setName('support-role').setDescription('可查看與關閉客服單的角色').setRequired(true))
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('open')
        .setDescription('開啟私人客服單')
        .addStringOption((option) => option.setName('subject').setDescription('需要協助的事項').setMaxLength(500))
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('close')
        .setDescription('由客服或管理員關閉目前客服單')
        .addStringOption((option) => option.setName('reason').setDescription('關閉原因').setMaxLength(500))
    )
    .addSubcommand((subcommand) => subcommand.setName('status').setDescription('查看客服設定與自己的客服單')),

  async execute(interaction) {
    try {
      if (!interaction.inGuild() || !interaction.guild) {
        await replyEphemeral(interaction, '客服單只能在伺服器內使用。');
        return;
      }

      const subcommand = interaction.options.getSubcommand();
      if (subcommand === 'setup') return await executeSetup(interaction);
      if (subcommand === 'open') return await executeOpen(interaction);
      if (subcommand === 'close') return await executeClose(interaction);
      return await executeStatus(interaction);
    } catch (error) {
      if (error instanceof TicketStateError) {
        await replyTicketError(interaction, error.message);
        return;
      }
      await handleCommandError(interaction, error, '客服單操作失敗，請稍後再試。');
    }
  },
};
