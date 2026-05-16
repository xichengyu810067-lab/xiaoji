const fs = require('node:fs');
const path = require('node:path');
const logger = require('../utils/logger');

const auditDataPath = path.join(__dirname, '..', 'data', 'guildAudit.json');
const whitelistDataPath = path.join(__dirname, '..', 'data', 'inviterWhitelist.json');

const AuditStatus = {
  APPROVED: 'approved',
  PENDING: 'pending',
  DENIED: 'denied',
  UNKNOWN: 'unknown',
};

function ensureDataFiles() {
  [auditDataPath, whitelistDataPath].forEach((filePath) => {
    const directory = path.dirname(filePath);
    if (!fs.existsSync(directory)) {
      fs.mkdirSync(directory, { recursive: true });
    }
    if (!fs.existsSync(filePath)) {
      const initialContent = filePath === auditDataPath ? '{}\n' : '[]\n';
      fs.writeFileSync(filePath, initialContent, 'utf8');
    }
  });
}

function readAuditData() {
  ensureDataFiles();
  try {
    return JSON.parse(fs.readFileSync(auditDataPath, 'utf8'));
  } catch (error) {
    logger.error('Failed to read guild audit data', error);
    return {};
  }
}

function writeAuditData(data) {
  ensureDataFiles();
  fs.writeFileSync(auditDataPath, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

function readWhitelistData() {
  ensureDataFiles();
  try {
    return JSON.parse(fs.readFileSync(whitelistDataPath, 'utf8'));
  } catch (error) {
    logger.error('Failed to read inviter whitelist data', error);
    return [];
  }
}

function writeWhitelistData(data) {
  ensureDataFiles();
  fs.writeFileSync(whitelistDataPath, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

// Guild Audit Methods
function getGuildAudit(guildId) {
  const data = readAuditData();
  return data[guildId] || null;
}

function isGuildApproved(guildId) {
  const audit = getGuildAudit(guildId);
  return audit?.status === AuditStatus.APPROVED;
}

function setGuildAudit(guildId, { status, name, inviterId, reason, manualAudit }) {
  const data = readAuditData();
  const now = new Date().toISOString();
  
  data[guildId] = {
    guildId,
    name: name || data[guildId]?.name || null,
    status,
    inviterId: inviterId || data[guildId]?.inviterId || null,
    addedAt: data[guildId]?.addedAt || now,
    updatedAt: now,
    approvedAt: status === AuditStatus.APPROVED ? now : data[guildId]?.approvedAt || null,
    deniedAt: status === AuditStatus.DENIED ? now : data[guildId]?.deniedAt || null,
    reason: reason || null,
    manualAudit: manualAudit !== undefined ? manualAudit : data[guildId]?.manualAudit || false,
  };
  
  writeAuditData(data);
  return data[guildId];
}

async function syncExistingGuilds(client) {
  const guilds = client.guilds.cache;
  let syncCount = 0;
  
  for (const guild of guilds.values()) {
    const audit = getGuildAudit(guild.id);
    if (!audit) {
      setGuildAudit(guild.id, {
        status: AuditStatus.UNKNOWN,
        name: guild.name,
        manualAudit: true, // Legacy servers require manual owner action, no auto-leave
      });
      syncCount++;
    }
  }
  
  if (syncCount > 0) {
    logger.info(`Synced ${syncCount} existing guilds to audit system as UNKNOWN (manual audit required)`);
  }
}

// Whitelist Methods
function getWhitelist() {
  return readWhitelistData();
}

function isWhitelisted(userId) {
  const whitelist = getWhitelist();
  return whitelist.some((entry) => entry.userId === userId);
}

function addToWhitelist(userId, addedBy) {
  const whitelist = getWhitelist();
  if (whitelist.some((entry) => entry.userId === userId)) {
    return false;
  }
  
  whitelist.push({
    userId,
    addedBy,
    addedAt: new Date().toISOString(),
  });
  
  writeWhitelistData(whitelist);
  return true;
}

function removeFromWhitelist(userId) {
  const whitelist = getWhitelist();
  const initialLength = whitelist.length;
  const filtered = whitelist.filter((entry) => entry.userId !== userId);
  
  if (filtered.length === initialLength) {
    return false;
  }
  
  writeWhitelistData(filtered);
  return true;
}

async function checkAndAutoLeave(client) {
  const data = readAuditData();
  const now = Date.now();
  const limitMs = 24 * 60 * 60 * 1000; // 24 hours
  
  for (const guildId of Object.keys(data)) {
    const audit = data[guildId];
    if (audit.manualAudit) {
      continue;
    }

    if (audit.status === AuditStatus.PENDING || audit.status === AuditStatus.UNKNOWN) {
      const addedAt = new Date(audit.addedAt).getTime();
      if (now - addedAt > limitMs) {
        logger.info(`Auto-leaving guild ${guildId} due to audit timeout`);
        
        try {
          const guild = await client.guilds.fetch(guildId).catch(() => null);
          if (guild) {
            await guild.leave();
            setGuildAudit(guildId, {
              status: AuditStatus.DENIED,
              reason: 'Audit timeout (24h)',
            });
            
            // Notify owner
            const ownerId = process.env.BOT_OWNER_ID;
            if (ownerId) {
              const owner = await client.users.fetch(ownerId).catch(() => null);
              if (owner) {
                await owner.send(`小吉已自動離開伺服器 **${audit.name || guildId}**，因為超過 24 小時未被批准。`).catch(() => null);
              }
            }
          }
        } catch (error) {
          logger.error(`Failed to auto-leave guild ${guildId}`, error);
        }
      }
    }
  }
}

module.exports = {
  AuditStatus,
  addToWhitelist,
  checkAndAutoLeave,
  getGuildAudit,
  getWhitelist,
  isGuildApproved,
  isWhitelisted,
  removeFromWhitelist,
  setGuildAudit,
  syncExistingGuilds,
};
