const { EmbedBuilder, SlashCommandBuilder } = require('discord.js');

const commandGroups = [
  {
    title: '一般指令',
    commands: [
      ['/ping', '查看小吉延遲'],
      ['/fortune', '抽一則小吉籤'],
      ['/roll sides count', '擲骰子'],
      ['/weather city', '查詢城市目前天氣'],
      ['/poll question option1 option2', '建立按鈕投票'],
      ['/remind time message', '設定提醒'],
      ['/calendar add/list/delete', '管理行事曆'],
      ['/music play/queue/skip/pause/resume/stop/leave', '播放 YouTube 音樂'],
      ['/coins user', '查詢吉幣餘額'],
      ['/daily', '每日簽到領取吉幣'],
      ['/leaderboard', '查看伺服器吉幣排行榜'],
      ['/shop', '查看吉幣商店'],
      ['/buy item-id quantity', '使用吉幣購買商品'],
      ['/inventory', '查看自己的背包'],
      ['/work list/start/start-venue/submit/submissions/edit/delete/payroll', '小吉工作提交、場館多職業與吉幣薪資系統'],
      ['/bank balance/deposit/withdraw/interest', '小吉銀行系統'],
      ['/exchange balance/buy-chips/cashout/history', '籌碼與吉幣兌換區'],
      ['/casino-lobby guide/stay/betting-area', '賭場大廳導覽、下注區與住宿'],
      ['/duel-tower weapons/enter/profile/history', '使用吉幣商店武器挑戰決鬥塔台'],
      ['/casino dice/slots/blackjack/roulette/baccarat/poker/loan-borrow/loan-repay/loan-status/history', '使用籌碼遊玩賭場與貸幣兌換'],
      ['/casino-venue menu/order/recipe/make/serve', '小吉賭場餐廳、吧檯與服務生小費流程'],
      ['/luxury list/buy/inventory/history', '獨立奢侈品商店街'],
      ['/pawn quote/sell/active/redeem/history', '奢侈品當鋪與贖回'],
      ['/status', '查看小吉狀態'],
      ['/about', '查看專案資訊'],
      ['/help', '顯示指令說明'],
    ],
  },
  {
    title: '管理指令',
    commands: [
      ['/announce channel message', '發送公告'],
      ['/clear amount', '刪除近期訊息'],
      ['/timeout user duration reason', '暫時禁言成員'],
      ['/mute user duration reason', '暫時禁言成員，等同 timeout'],
      ['/kick user reason', '踢出成員'],
      ['/ban user reason', '封鎖使用者'],
      ['/unban user-id reason', '解除封鎖'],
      ['/role-add user role', '新增成員身分組'],
      ['/role-remove user role', '移除成員身分組'],
      ['/set-log channel', '設定管理紀錄頻道'],
      ['/config view/log-channel/anti-spam/weather-default-city/announce-mentions', '設定伺服器設定'],
      ['/autorole set/off/status', '設定新成員自動身分組'],
      ['/automod status/set/allow-domain', '設定自動防護'],
      ['/export-config', '匯出伺服器設定'],
      ['/coin-admin add/remove/set/history/reset-user/enable/disable', '管理吉幣餘額與設定'],
      ['/work pending/review/payroll-preview/payroll-history/penalties/appeal', '工作審核、扣薪查詢與申訴'],
      ['/casino-venue delete-menu/reassign/reassign-waiter/cancel', '管理餐廳、吧檯與服務生指派'],
      ['/shop-admin create/edit/enable/disable/delete', '管理吉幣商店商品'],
      ['/luxury-admin create/edit/enable/disable/delete', '管理奢侈品商店街商品'],
      ['/coin-db status', 'owner 查看吉幣資料庫狀態'],
    ],
  },
];

module.exports = {
  data: new SlashCommandBuilder().setName('help').setDescription('列出小吉可用指令'),

  async execute(interaction) {
    const embed = new EmbedBuilder()
      .setTitle('小吉指令說明')
      .setDescription('以下是目前可用的主要指令。')
      .setColor(0x57a6ff);

    for (const group of commandGroups) {
      let chunk = '';
      let part = 1;

      for (const [usage, description] of group.commands) {
        const line = `\`${usage}\` - ${description}\n`;

        if (chunk.length + line.length > 1000) {
          embed.addFields({
            name: part === 1 ? group.title : `${group.title} ${part}`,
            value: chunk.trim(),
          });
          chunk = '';
          part += 1;
        }

        chunk += line;
      }

      if (chunk) {
        embed.addFields({
          name: part === 1 ? group.title : `${group.title} ${part}`,
          value: chunk.trim(),
        });
      }
    }

    await interaction.reply({
      embeds: [embed],
      ephemeral: true,
    });
  },
};
