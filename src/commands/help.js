const { SlashCommandBuilder } = require('discord.js');

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
      ['/work list/start/submit/submissions/edit/delete/payroll', '小吉工作提交與吉幣薪資系統'],
      ['/bank balance/deposit/withdraw/interest', '小吉銀行系統'],
      ['/casino dice/slots/blackjack/loan-borrow/loan-repay/loan-status/history', '使用吉幣遊玩賭場與貸幣兌換'],
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
      ['/work pending/review/payroll-preview/payroll-history', '管理員審核工作提交與查看薪資'],
      ['/shop-admin create/edit/enable/disable/delete', '管理吉幣商店商品'],
      ['/coin-db status', 'owner 查看吉幣資料庫狀態'],
    ],
  },
];

module.exports = {
  data: new SlashCommandBuilder().setName('help').setDescription('列出小吉可用指令'),

  async execute(interaction) {
    const content = commandGroups
      .map((group) => {
        const commands = group.commands.map(([usage, description]) => `\`${usage}\` - ${description}`).join('\n');
        return `**${group.title}**\n${commands}`;
      })
      .join('\n\n');

    await interaction.reply({
      content,
      ephemeral: true,
    });
  },
};
