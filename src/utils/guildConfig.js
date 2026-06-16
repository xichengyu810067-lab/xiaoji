const fs = require('node:fs');
const path = require('node:path');

const configPath = path.join(__dirname, '..', 'data', 'guildConfig.json');

const defaultAutomodConfig = {
  enabled: false,
  spam: {
    enabled: true,
    maxMessages: 5,
    windowSeconds: 7,
    repeatedMessages: 3,
    repeatedWindowSeconds: 20,
  },
  ads: {
    enabled: true,
    blockDiscordInvites: true,
    blockSuspiciousLinks: true,
  },
  massMentions: {
    enabled: true,
    maxMentions: 6,
    blockEveryoneHere: true,
  },
  action: {
    deleteMessage: true,
    warnUser: true,
    timeoutAfter: 3,
    timeoutMinutes: 10,
    infractionWindowMinutes: 10,
  },
  allowDomains: [],
};

const defaultGuildConfig = {
  logChannelId: null,
  welcomeChannelId: null,
  autorole: {
    roleId: null,
  },
  weatherDefaultCity: null,
  announce: {
    allowMentions: false,
  },
  memory: {
    sharePublicAcrossChannels: false,
  },
  automod: defaultAutomodConfig,
};

function ensureConfigFile() {
  const directory = path.dirname(configPath);

  if (!fs.existsSync(directory)) {
    fs.mkdirSync(directory, { recursive: true });
  }

  if (!fs.existsSync(configPath)) {
    fs.writeFileSync(configPath, '{}\n', 'utf8');
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function mergeConfig(defaults, stored) {
  if (!isPlainObject(stored)) {
    return structuredClone(defaults);
  }

  const output = { ...structuredClone(defaults), ...stored };

  for (const [key, value] of Object.entries(defaults)) {
    if (isPlainObject(value)) {
      output[key] = mergeConfig(value, stored[key]);
    }
  }

  return output;
}

function normalizeDomain(domain) {
  return String(domain || '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .split('/')[0];
}

function normalizeGuildConfig(config) {
  const normalized = mergeConfig(defaultGuildConfig, config);

  normalized.logChannelId = normalized.logChannelId || null;
  normalized.welcomeChannelId = normalized.welcomeChannelId || null;
  normalized.autorole.roleId = normalized.autorole.roleId || null;
  normalized.weatherDefaultCity = normalized.weatherDefaultCity
    ? String(normalized.weatherDefaultCity).trim().slice(0, 100)
    : null;
  normalized.announce.allowMentions = Boolean(normalized.announce.allowMentions);
  normalized.memory.sharePublicAcrossChannels = Boolean(normalized.memory.sharePublicAcrossChannels);
  normalized.automod.allowDomains = Array.from(
    new Set((normalized.automod.allowDomains || []).map(normalizeDomain).filter(Boolean))
  ).sort();

  return normalized;
}

function readAllGuildConfig() {
  ensureConfigFile();

  try {
    const raw = fs.readFileSync(configPath, 'utf8').trim();

    if (!raw) {
      return {};
    }

    const parsed = JSON.parse(raw);

    if (!isPlainObject(parsed)) {
      return {};
    }

    return parsed;
  } catch {
    return {};
  }
}

function writeAllGuildConfig(config) {
  ensureConfigFile();
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

function getGuildConfig(guildId) {
  const allConfig = readAllGuildConfig();
  return normalizeGuildConfig(allConfig[guildId]);
}

function setGuildConfig(guildId, guildConfig) {
  const allConfig = readAllGuildConfig();
  allConfig[guildId] = normalizeGuildConfig(guildConfig);
  writeAllGuildConfig(allConfig);
  return allConfig[guildId];
}

function updateGuildConfig(guildId, updater) {
  const allConfig = readAllGuildConfig();
  const current = normalizeGuildConfig(allConfig[guildId]);
  const next = updater(structuredClone(current)) || current;
  allConfig[guildId] = normalizeGuildConfig(next);
  writeAllGuildConfig(allConfig);
  return allConfig[guildId];
}

function setGuildLogChannel(guildId, logChannelId) {
  return updateGuildConfig(guildId, (config) => {
    config.logChannelId = logChannelId;
    return config;
  });
}

function setGuildWelcomeChannel(guildId, welcomeChannelId) {
  return updateGuildConfig(guildId, (config) => {
    config.welcomeChannelId = welcomeChannelId;
    return config;
  });
}

function setAutorole(guildId, roleId) {
  return updateGuildConfig(guildId, (config) => {
    config.autorole.roleId = roleId || null;
    return config;
  });
}

function setAutomodOptions(guildId, options) {
  return updateGuildConfig(guildId, (config) => {
    for (const [pathKey, value] of Object.entries(options)) {
      const pathParts = pathKey.split('.');
      let cursor = config.automod;

      for (const part of pathParts.slice(0, -1)) {
        cursor = cursor[part];
      }

      cursor[pathParts.at(-1)] = value;
    }

    return config;
  });
}

function setWeatherDefaultCity(guildId, city) {
  return updateGuildConfig(guildId, (config) => {
    const normalizedCity = String(city || '').trim();
    config.weatherDefaultCity = normalizedCity || null;
    return config;
  });
}

function setAnnounceAllowMentions(guildId, allowMentions) {
  return updateGuildConfig(guildId, (config) => {
    config.announce.allowMentions = Boolean(allowMentions);
    return config;
  });
}

function setAntiSpamEnabled(guildId, enabled) {
  return updateGuildConfig(guildId, (config) => {
    config.automod.enabled = Boolean(enabled);
    config.automod.spam.enabled = Boolean(enabled);
    return config;
  });
}

function addAllowedDomain(guildId, domain) {
  const normalizedDomain = normalizeDomain(domain);

  if (!normalizedDomain) {
    return getGuildConfig(guildId);
  }

  return updateGuildConfig(guildId, (config) => {
    config.automod.allowDomains = Array.from(
      new Set([...(config.automod.allowDomains || []), normalizedDomain])
    ).sort();
    return config;
  });
}

function removeAllowedDomain(guildId, domain) {
  const normalizedDomain = normalizeDomain(domain);
  return updateGuildConfig(guildId, (config) => {
    config.automod.allowDomains = (config.automod.allowDomains || []).filter((item) => item !== normalizedDomain);
    return config;
  });
}

function getExportableGuildConfig(guildId) {
  return {
    exportedAt: new Date().toISOString(),
    guildId,
    config: getGuildConfig(guildId),
  };
}

module.exports = {
  addAllowedDomain,
  defaultGuildConfig,
  getExportableGuildConfig,
  getGuildConfig,
  normalizeDomain,
  normalizeGuildConfig,
  readAllGuildConfig,
  removeAllowedDomain,
  setAnnounceAllowMentions,
  setAntiSpamEnabled,
  setAutomodOptions,
  setAutorole,
  setGuildConfig,
  setGuildLogChannel,
  setGuildWelcomeChannel,
  setWeatherDefaultCity,
  updateGuildConfig,
  writeAllGuildConfig,
};
