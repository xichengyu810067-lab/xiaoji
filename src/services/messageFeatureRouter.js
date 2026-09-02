const { FEATURE_KEYS, getGuildFeatureSetting } = require('./featurePlatformService');
const { handleWordChainMessage } = require('./wordChainService');

function createMessageFeatureRouter({ handlers = {}, loadSetting = getGuildFeatureSetting } = {}) {
  const orderedHandlers = FEATURE_KEYS.filter((featureKey) => typeof handlers[featureKey] === 'function').map((featureKey) => [
    featureKey,
    handlers[featureKey],
  ]);

  return async function routeMessageFeatures(message) {
    if (!message?.guildId || !message.author || message.author.bot || orderedHandlers.length === 0) {
      return { handled: false, featureKey: null };
    }

    for (const [featureKey, handler] of orderedHandlers) {
      const setting = await loadSetting(message.guildId, featureKey);

      if (
        !setting.enabled ||
        (featureKey === 'word_chain' && !setting.channelId) ||
        (setting.channelId && setting.channelId !== message.channelId)
      ) {
        continue;
      }

      const handled = await handler(message, setting);

      if (handled) {
        return { handled: true, featureKey };
      }
    }

    return { handled: false, featureKey: null };
  };
}

// Feature handlers are deliberately registered here in platform order.  Disabled
// features remain no-ops because the router loads their persisted setting first.
const routeMessageFeatures = createMessageFeatureRouter({
  handlers: {
    word_chain: handleWordChainMessage,
  },
});

module.exports = {
  createMessageFeatureRouter,
  routeMessageFeatures,
};
