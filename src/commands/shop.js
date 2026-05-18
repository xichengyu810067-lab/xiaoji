const { PermissionFlagsBits, SlashCommandBuilder } = require('discord.js');
const {
  ShopItemTypes,
  getAllPurchaseHistory,
  getPurchaseHistory,
  getShopItem,
  listShopItems,
  purchaseItem,
  refundPurchase,
} = require('../services/coinService');
const {
  formatCoins,
  formatItemType,
  formatShopItemLine,
  formatUser,
  replyCoinError,
} = require('../utils/coinPresentation');
const { ensureModerationAccess } = require('../utils/moderation');
const logger = require('../utils/logger');

function formatTimestamp(isoString) {
  if (!isoString) {
    return '無';
  }

  const timestamp = Math.floor(new Date(isoString).getTime() / 1000);
  return `<t:${timestamp}:F> (<t:${timestamp}:R>)`;
}

function formatPurchaseLine(purchase) {
  return [
    `#${purchase.id}`,
    `<@${purchase.userId}>`,
    `${purchase.itemName} x${purchase.quantity}`,
    formatCoins(purchase.totalPrice),
    formatItemType(purchase.itemType),
    purchase.status,
    purchase.expiresAt ? `期限 ${formatTimestamp(purchase.expiresAt)}` : '期限 無',
    formatTimestamp(purchase.createdAt),
  ].join('｜');
}

async function validateRoleReward(interaction, item) {
  if (item.type !== ShopItemTypes.ROLE) {
    return { ok: true, role: null, member: null };
  }

  if (!item.roleId) {
    return { ok: false, message: '這個身分組商品尚未設定身分組，暫時不能購買。' };
  }

  const role = await interaction.guild.roles.fetch(item.roleId).catch(() => null);

  if (!role) {
    return { ok: false, message: '找不到這個商品設定的身分組，暫時不能購買。' };
  }

  const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);

  if (!member) {
    return { ok: false, message: '找不到你的伺服器成員資料，暫時不能購買。' };
  }

  if (member.roles.cache.has(role.id)) {
    return { ok: false, message: `你已經擁有 ${role}，不需要重複購買。` };
  }

  const botMember = interaction.guild.members.me || (await interaction.guild.members.fetchMe());

  if (!botMember.permissions.has(PermissionFlagsBits.ManageRoles)) {
    return { ok: false, message: '小吉缺少管理身分組權限，暫時不能販售這個商品。' };
  }

  if (role.managed || role.comparePositionTo(botMember.roles.highest) >= 0) {
    return { ok: false, message: '小吉的最高身分組必須高於商品身分組，暫時不能販售這個商品。' };
  }

  return { ok: true, role, member };
}

async function ensureAdmin(interaction) {
  return ensureModerationAccess(interaction, {
    userPermission: PermissionFlagsBits.Administrator,
    userPermissionName: 'Administrator',
  });
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('shop')
    .setDescription('吉幣商店與購買紀錄')
    .addSubcommand((subcommand) =>
      subcommand
        .setName('list')
        .setDescription('查看目前伺服器的吉幣商店')
        .addIntegerOption((option) => option.setName('page').setDescription('頁數').setMinValue(1))
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('buy')
        .setDescription('使用吉幣購買商店商品')
        .addIntegerOption((option) => option.setName('item-id').setDescription('商品 ID').setRequired(true).setMinValue(1))
        .addIntegerOption((option) => option.setName('quantity').setDescription('購買數量').setMinValue(1).setMaxValue(99))
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('purchases')
        .setDescription('查看自己的購買紀錄')
        .addIntegerOption((option) => option.setName('limit').setDescription('筆數，預設 10').setMinValue(1).setMaxValue(25))
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('purchases-user')
        .setDescription('管理員查看指定使用者購買紀錄')
        .addUserOption((option) => option.setName('user').setDescription('目標使用者').setRequired(true))
        .addIntegerOption((option) => option.setName('limit').setDescription('筆數，預設 10').setMinValue(1).setMaxValue(25))
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('purchases-all')
        .setDescription('管理員查看全伺服器購買紀錄')
        .addIntegerOption((option) => option.setName('limit').setDescription('筆數，預設 10').setMinValue(1).setMaxValue(25))
    ),

  async execute(interaction) {
    try {
      if (!interaction.inGuild()) {
        await interaction.reply({ content: '商店只能在伺服器內使用。', ephemeral: true });
        return;
      }

      const subcommand = interaction.options.getSubcommand();

      if (subcommand === 'purchases-user' || subcommand === 'purchases-all') {
        const access = await ensureAdmin(interaction);
        if (!access.ok) {
          return;
        }
      }

      if (subcommand === 'list') {
        const page = interaction.options.getInteger('page') || 1;
        const result = await listShopItems(interaction.guildId, { page, limit: 10 });

        if (result.items.length === 0) {
          await interaction.reply({ content: '目前商店沒有可購買的商品。', ephemeral: true });
          return;
        }

        await interaction.reply({
          content: [`**吉幣商店｜第 ${result.page} 頁**`, ...result.items.map(formatShopItemLine)].join('\n\n'),
          ephemeral: true,
        });
        return;
      }

      if (subcommand === 'buy') {
        await interaction.deferReply({ ephemeral: true });
        const itemId = interaction.options.getInteger('item-id', true);
        const quantity = interaction.options.getInteger('quantity') || 1;
        const item = await getShopItem(interaction.guildId, itemId);

        if (!item) {
          await interaction.editReply('找不到這個商品，或商品目前不可購買。');
          return;
        }

        const roleValidation = await validateRoleReward(interaction, item);

        if (!roleValidation.ok) {
          await interaction.editReply(roleValidation.message);
          return;
        }

        const purchase = await purchaseItem(interaction.guildId, interaction.user.id, itemId, quantity);

        if (roleValidation.role) {
          try {
            await roleValidation.member.roles.add(roleValidation.role, `小吉商店購買商品 #${item.id}`);
          } catch (error) {
            await refundPurchase(interaction.guildId, interaction.user.id, {
              itemId,
              quantity,
              amount: purchase.totalPrice,
              reason: '身分組給予失敗，自動退款',
            });
            logger.error(
              `商店身分組商品給予失敗，已自動退款。guild=${interaction.guildId} user=${interaction.user.id} item=${item.id}`,
              error
            );
            await interaction.editReply(
              [
                '購買已取消：小吉給予身分組時失敗。',
                `已自動退款：${formatCoins(purchase.totalPrice)}`,
                '請確認小吉有管理身分組權限，且小吉的最高身分組高於商品身分組。',
              ].join('\n')
            );
            return;
          }
        }

        await interaction.editReply(
          [
            `購買成功：${purchase.item.name} x${purchase.quantity}`,
            `花費：${formatCoins(purchase.totalPrice)}`,
            `最新餘額：${formatCoins(purchase.after)}`,
            roleValidation.role ? `已給予身分組：${roleValidation.role}` : null,
            '',
            formatShopItemLine(purchase.item),
          ]
            .filter(Boolean)
            .join('\n')
        );
        return;
      }

      if (subcommand === 'purchases') {
        const limit = interaction.options.getInteger('limit') || 10;
        const purchases = await getPurchaseHistory(interaction.guildId, interaction.user.id, { limit });

        await interaction.reply({
          content: purchases.length
            ? [`**${interaction.user.username} 的購買紀錄**`, ...purchases.map(formatPurchaseLine)].join('\n')
            : '你目前沒有購買紀錄。',
          ephemeral: true,
        });
        return;
      }

      if (subcommand === 'purchases-user') {
        const user = interaction.options.getUser('user', true);
        const limit = interaction.options.getInteger('limit') || 10;
        const purchases = await getPurchaseHistory(interaction.guildId, user.id, { limit });

        await interaction.reply({
          content: purchases.length
            ? [`**${formatUser(user)} 的購買紀錄**`, ...purchases.map(formatPurchaseLine)].join('\n')
            : `${formatUser(user)} 目前沒有購買紀錄。`,
          ephemeral: true,
        });
        return;
      }

      if (subcommand === 'purchases-all') {
        const limit = interaction.options.getInteger('limit') || 10;
        const purchases = await getAllPurchaseHistory(interaction.guildId, { limit });

        await interaction.reply({
          content: purchases.length ? ['**全伺服器購買紀錄**', ...purchases.map(formatPurchaseLine)].join('\n') : '目前沒有購買紀錄。',
          ephemeral: true,
        });
      }
    } catch (error) {
      await replyCoinError(interaction, error);
    }
  },
};
