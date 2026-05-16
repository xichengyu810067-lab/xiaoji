const test = require('node:test');
const assert = require('node:assert/strict');
const { OWNER_DENIED_MESSAGE, ensureBotOwner, isBotOwner } = require('../src/utils/ownerOnly');

test('isBotOwner only accepts BOT_OWNER_ID exact match', () => {
  const previousOwnerId = process.env.BOT_OWNER_ID;

  try {
    process.env.BOT_OWNER_ID = '123456789012345678';
    assert.equal(isBotOwner('123456789012345678'), true);
    assert.equal(isBotOwner('123456789012345679'), false);
  } finally {
    if (previousOwnerId === undefined) {
      delete process.env.BOT_OWNER_ID;
    } else {
      process.env.BOT_OWNER_ID = previousOwnerId;
    }
  }
});

test('ensureBotOwner rejects non-owner with exact ephemeral message', async () => {
  const previousOwnerId = process.env.BOT_OWNER_ID;

  try {
    process.env.BOT_OWNER_ID = '123456789012345678';
    let replyPayload;

    const allowed = await ensureBotOwner({
      user: { id: '123456789012345679' },
      replied: false,
      deferred: false,
      async reply(payload) {
        replyPayload = payload;
      },
    });

    assert.equal(allowed, false);
    assert.deepEqual(replyPayload, {
      content: OWNER_DENIED_MESSAGE,
      ephemeral: true,
    });
  } finally {
    if (previousOwnerId === undefined) {
      delete process.env.BOT_OWNER_ID;
    } else {
      process.env.BOT_OWNER_ID = previousOwnerId;
    }
  }
});
