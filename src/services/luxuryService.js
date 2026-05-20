const { withCoinDatabase, withCoinTransaction } = require('./coinDatabase');
const {
  CoinServiceError,
  TransactionType,
  ensureGuildSettings,
  ensurePlayer,
  insertAdminLog,
  insertTransaction,
  nowIso,
} = require('./coinService');

const MAX_LUXURY_AMOUNT = 9_000_000_000;
const DEFAULT_PAGE_SIZE = 10;
const MAX_PAGE_SIZE = 25;

function assertEconomyEnabled(settings) {
  if (!settings.enabled) {
    throw new CoinServiceError('COIN_DISABLED', '這個伺服器的吉幣系統目前停用。');
  }
}

function normalizePositiveInteger(value, label = '數量') {
  const amount = Number(value);

  if (!Number.isSafeInteger(amount) || amount <= 0 || amount > MAX_LUXURY_AMOUNT) {
    throw new CoinServiceError('INVALID_LUXURY_AMOUNT', `${label}必須是 1 到 ${MAX_LUXURY_AMOUNT.toLocaleString('zh-TW')} 的整數。`);
  }

  return amount;
}

function normalizeNonNegativeInteger(value, label = '數量', { allowNull = false } = {}) {
  if ((value === null || value === undefined) && allowNull) {
    return null;
  }

  const amount = Number(value);

  if (!Number.isSafeInteger(amount) || amount < 0 || amount > MAX_LUXURY_AMOUNT) {
    throw new CoinServiceError('INVALID_LUXURY_AMOUNT', `${label}必須是 0 到 ${MAX_LUXURY_AMOUNT.toLocaleString('zh-TW')} 的整數。`);
  }

  return amount;
}

function normalizePage(page) {
  const value = Number(page || 1);
  return Number.isSafeInteger(value) && value > 0 ? value : 1;
}

function normalizeLimit(limit, fallback = DEFAULT_PAGE_SIZE) {
  const value = Number(limit || fallback);
  return Number.isSafeInteger(value) && value > 0 ? Math.min(value, MAX_PAGE_SIZE) : fallback;
}

function serializeMetadata(metadata) {
  return metadata ? JSON.stringify(metadata) : null;
}

function mapLuxuryItem(row) {
  return {
    id: Number(row.id),
    guildId: row.guild_id,
    name: row.name,
    description: row.description || '',
    price: Number(row.price),
    enabled: Boolean(row.enabled),
    deleted: Boolean(row.deleted),
    stock: row.stock === null || row.stock === undefined ? null : Number(row.stock),
    purchaseLimit: row.purchase_limit === null || row.purchase_limit === undefined ? null : Number(row.purchase_limit),
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapLuxuryInventory(row) {
  return {
    id: Number(row.id),
    guildId: row.guild_id,
    userId: row.user_id,
    itemId: Number(row.item_id),
    itemName: row.item_name,
    quantity: Number(row.quantity),
    acquiredAt: row.acquired_at,
    updatedAt: row.updated_at,
  };
}

function mapLuxuryPurchase(row) {
  return {
    id: Number(row.id),
    guildId: row.guild_id,
    userId: row.user_id,
    itemId: Number(row.item_id),
    itemName: row.item_name,
    quantity: Number(row.quantity),
    unitPrice: Number(row.unit_price),
    totalPrice: Number(row.total_price),
    createdAt: row.created_at,
  };
}

function mapPawnRecord(row) {
  return {
    id: Number(row.id),
    guildId: row.guild_id,
    userId: row.user_id,
    itemId: Number(row.item_id),
    itemName: row.item_name,
    quantity: Number(row.quantity),
    remainingQuantity: Number(row.remaining_quantity),
    pawnUnitPrice: Number(row.pawn_unit_price),
    payoutAmount: Number(row.payout_amount),
    redeemedQuantity: Number(row.redeemed_quantity || 0),
    redeemedAmount: Number(row.redeemed_amount || 0),
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    redeemedAt: row.redeemed_at || null,
  };
}

function mapPawnRedemption(row) {
  return {
    id: Number(row.id),
    guildId: row.guild_id,
    userId: row.user_id,
    pawnRecordId: Number(row.pawn_record_id),
    itemId: Number(row.item_id),
    itemName: row.item_name,
    quantity: Number(row.quantity),
    redeemUnitPrice: Number(row.redeem_unit_price),
    totalPrice: Number(row.total_price),
    createdAt: row.created_at,
  };
}

function getLuxuryItemRow(api, guildId, itemId, { includeDeleted = true } = {}) {
  return api.get(
    `SELECT *
     FROM luxury_items
     WHERE guild_id = ?
       AND id = ?
       AND (? = 1 OR deleted = 0)`,
    [guildId, itemId, includeDeleted ? 1 : 0]
  );
}

function insertPriceHistory(api, guildId, itemId, price, { operatorId, reason, timestamp }) {
  api.run(
    `INSERT INTO luxury_price_history (guild_id, item_id, price, changed_by, reason, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [guildId, itemId, price, operatorId || null, reason || 'price update', timestamp || nowIso()]
  );
}

function getHistoricalHighPrice(api, guildId, itemId, fallbackPrice) {
  const row = api.get(
    `SELECT MAX(price) AS price
     FROM luxury_price_history
     WHERE guild_id = ? AND item_id = ?`,
    [guildId, itemId]
  );
  const high = Number(row?.price || 0);
  return high > 0 ? high : Number(fallbackPrice || 0);
}

function updateLuxuryInventory(api, guildId, userId, item, quantity, timestamp) {
  api.run(
    `INSERT INTO luxury_inventory
      (guild_id, user_id, item_id, item_name, quantity, acquired_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(guild_id, user_id, item_id) DO UPDATE SET
       item_name = excluded.item_name,
       quantity = luxury_inventory.quantity + excluded.quantity,
       updated_at = excluded.updated_at`,
    [guildId, userId, item.id, item.name, quantity, timestamp, timestamp]
  );
}

function decrementLuxuryInventory(api, guildId, userId, itemId, quantity) {
  api.run(
    `UPDATE luxury_inventory
     SET quantity = quantity - ?, updated_at = ?
     WHERE guild_id = ? AND user_id = ? AND item_id = ?`,
    [quantity, nowIso(), guildId, userId, itemId]
  );
  api.run('DELETE FROM luxury_inventory WHERE guild_id = ? AND user_id = ? AND item_id = ? AND quantity <= 0', [
    guildId,
    userId,
    itemId,
  ]);
}

function assertInventoryQuantity(api, guildId, userId, itemId, quantity) {
  const row = api.get(
    'SELECT quantity FROM luxury_inventory WHERE guild_id = ? AND user_id = ? AND item_id = ?',
    [guildId, userId, itemId]
  );
  const currentQuantity = Number(row?.quantity || 0);

  if (currentQuantity < quantity) {
    throw new CoinServiceError('LUXURY_INVENTORY_NOT_ENOUGH', '你的奢侈品庫存不足。', {
      currentQuantity,
      required: quantity,
    });
  }

  return currentQuantity;
}

async function createLuxuryItem(guildId, input) {
  return withCoinTransaction((api) => {
    ensureGuildSettings(api, guildId);
    const name = String(input.name || '').trim().slice(0, 80);
    const description = String(input.description || '').trim().slice(0, 500);
    const price = normalizePositiveInteger(input.price, '商品價格');
    const stock = normalizeNonNegativeInteger(input.stock, '庫存', { allowNull: true });
    const purchaseLimit = normalizeNonNegativeInteger(input.purchaseLimit, '購買上限', { allowNull: true });
    const timestamp = nowIso();

    if (!name) {
      throw new CoinServiceError('INVALID_LUXURY_ITEM_NAME', '商品名稱不可空白。');
    }

    api.run(
      `INSERT INTO luxury_items
        (guild_id, name, description, price, enabled, deleted, stock, purchase_limit, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, 0, ?, ?, ?, ?, ?)`,
      [guildId, name, description, price, stock, purchaseLimit, input.createdBy || 'unknown', timestamp, timestamp]
    );

    const id = Number(api.get('SELECT last_insert_rowid() AS id').id);
    insertPriceHistory(api, guildId, id, price, {
      operatorId: input.createdBy,
      reason: 'initial price',
      timestamp,
    });
    insertAdminLog(api, {
      guildId,
      operatorId: input.createdBy || 'unknown',
      action: 'luxury_admin:create',
      reason: '新增奢侈品商品',
      details: { itemId: id, name, price },
      createdAt: timestamp,
    });

    return mapLuxuryItem(api.get('SELECT * FROM luxury_items WHERE guild_id = ? AND id = ?', [guildId, id]));
  });
}

async function editLuxuryItem(guildId, itemId, input) {
  return withCoinTransaction((api) => {
    ensureGuildSettings(api, guildId);
    const item = getLuxuryItemRow(api, guildId, itemId, { includeDeleted: false });

    if (!item) {
      throw new CoinServiceError('LUXURY_ITEM_NOT_FOUND', '找不到這個奢侈品商品。');
    }

    const updates = [];
    const params = [];

    function setColumn(column, value) {
      updates.push(`${column} = ?`);
      params.push(value);
    }

    if (input.name !== undefined) {
      const name = String(input.name || '').trim().slice(0, 80);
      if (!name) {
        throw new CoinServiceError('INVALID_LUXURY_ITEM_NAME', '商品名稱不可空白。');
      }
      setColumn('name', name);
    }

    if (input.description !== undefined) {
      setColumn('description', String(input.description || '').trim().slice(0, 500));
    }

    let nextPrice = null;
    if (input.price !== undefined) {
      nextPrice = normalizePositiveInteger(input.price, '商品價格');
      setColumn('price', nextPrice);
    }

    if (input.stock !== undefined) {
      setColumn('stock', normalizeNonNegativeInteger(input.stock, '庫存', { allowNull: true }));
    }

    if (input.purchaseLimit !== undefined) {
      setColumn('purchase_limit', normalizeNonNegativeInteger(input.purchaseLimit, '購買上限', { allowNull: true }));
    }

    if (updates.length === 0) {
      throw new CoinServiceError('NO_CHANGES', '沒有提供要修改的欄位。');
    }

    const timestamp = nowIso();
    setColumn('updated_at', timestamp);
    api.run(`UPDATE luxury_items SET ${updates.join(', ')} WHERE guild_id = ? AND id = ?`, [
      ...params,
      guildId,
      itemId,
    ]);

    if (nextPrice !== null && nextPrice !== Number(item.price)) {
      insertPriceHistory(api, guildId, itemId, nextPrice, {
        operatorId: input.operatorId,
        reason: input.reason || 'price edit',
        timestamp,
      });
    }

    insertAdminLog(api, {
      guildId,
      operatorId: input.operatorId || 'unknown',
      action: 'luxury_admin:edit',
      reason: '修改奢侈品商品',
      details: { itemId, changedColumns: updates.map((update) => update.split(' = ')[0]) },
      createdAt: timestamp,
    });

    return mapLuxuryItem(api.get('SELECT * FROM luxury_items WHERE guild_id = ? AND id = ?', [guildId, itemId]));
  });
}

async function setLuxuryItemEnabled(guildId, itemId, enabled, { operatorId } = {}) {
  return withCoinTransaction((api) => {
    ensureGuildSettings(api, guildId);
    const item = getLuxuryItemRow(api, guildId, itemId, { includeDeleted: false });

    if (!item) {
      throw new CoinServiceError('LUXURY_ITEM_NOT_FOUND', '找不到這個奢侈品商品。');
    }

    const timestamp = nowIso();
    api.run('UPDATE luxury_items SET enabled = ?, updated_at = ? WHERE guild_id = ? AND id = ?', [
      enabled ? 1 : 0,
      timestamp,
      guildId,
      itemId,
    ]);
    insertAdminLog(api, {
      guildId,
      operatorId: operatorId || 'unknown',
      action: enabled ? 'luxury_admin:enable' : 'luxury_admin:disable',
      reason: enabled ? '上架奢侈品商品' : '下架奢侈品商品',
      details: { itemId },
      createdAt: timestamp,
    });

    return mapLuxuryItem(api.get('SELECT * FROM luxury_items WHERE guild_id = ? AND id = ?', [guildId, itemId]));
  });
}

async function deleteLuxuryItem(guildId, itemId, { operatorId } = {}) {
  return withCoinTransaction((api) => {
    ensureGuildSettings(api, guildId);
    const item = getLuxuryItemRow(api, guildId, itemId, { includeDeleted: false });

    if (!item) {
      throw new CoinServiceError('LUXURY_ITEM_NOT_FOUND', '找不到這個奢侈品商品。');
    }

    const timestamp = nowIso();
    api.run('UPDATE luxury_items SET enabled = 0, deleted = 1, updated_at = ? WHERE guild_id = ? AND id = ?', [
      timestamp,
      guildId,
      itemId,
    ]);
    insertAdminLog(api, {
      guildId,
      operatorId: operatorId || 'unknown',
      action: 'luxury_admin:delete',
      reason: '刪除奢侈品商品',
      details: { itemId },
      createdAt: timestamp,
    });

    return mapLuxuryItem(api.get('SELECT * FROM luxury_items WHERE guild_id = ? AND id = ?', [guildId, itemId]));
  });
}

async function listLuxuryItems(guildId, { page = 1, limit = DEFAULT_PAGE_SIZE, includeDisabled = false } = {}) {
  return withCoinTransaction((api) => {
    const settings = ensureGuildSettings(api, guildId);
    assertEconomyEnabled(settings);
    const normalizedPage = normalizePage(page);
    const normalizedLimit = normalizeLimit(limit);
    const offset = (normalizedPage - 1) * normalizedLimit;
    const rows = api.all(
      `SELECT *
       FROM luxury_items
       WHERE guild_id = ? AND deleted = 0 AND (? = 1 OR enabled = 1)
       ORDER BY id ASC
       LIMIT ? OFFSET ?`,
      [guildId, includeDisabled ? 1 : 0, normalizedLimit, offset]
    );

    return {
      page: normalizedPage,
      limit: normalizedLimit,
      items: rows.map(mapLuxuryItem),
    };
  });
}

async function getLuxuryItem(guildId, itemId, { includeDisabled = false, includeDeleted = false } = {}) {
  return withCoinDatabase((api) => {
    const item = api.get(
      `SELECT *
       FROM luxury_items
       WHERE guild_id = ?
         AND id = ?
         AND (? = 1 OR enabled = 1)
         AND (? = 1 OR deleted = 0)`,
      [guildId, itemId, includeDisabled ? 1 : 0, includeDeleted ? 1 : 0]
    );

    return item ? mapLuxuryItem(item) : null;
  });
}

async function purchaseLuxuryItem(guildId, userId, itemId, quantity = 1) {
  return withCoinTransaction((api) => {
    const settings = ensureGuildSettings(api, guildId);
    assertEconomyEnabled(settings);
    const normalizedQuantity = normalizePositiveInteger(quantity, '購買數量');
    const itemRow = getLuxuryItemRow(api, guildId, itemId, { includeDeleted: false });

    if (!itemRow) {
      throw new CoinServiceError('LUXURY_ITEM_NOT_FOUND', '找不到這個奢侈品商品。');
    }

    const item = mapLuxuryItem(itemRow);

    if (!item.enabled) {
      throw new CoinServiceError('LUXURY_ITEM_DISABLED', '這個奢侈品商品目前沒有上架。');
    }

    if (item.stock !== null && item.stock < normalizedQuantity) {
      throw new CoinServiceError('LUXURY_OUT_OF_STOCK', '奢侈品庫存不足。', { stock: item.stock });
    }

    const inventoryRow = api.get(
      'SELECT quantity FROM luxury_inventory WHERE guild_id = ? AND user_id = ? AND item_id = ?',
      [guildId, userId, item.id]
    );
    const currentQuantity = Number(inventoryRow?.quantity || 0);

    if (item.purchaseLimit !== null && currentQuantity + normalizedQuantity > item.purchaseLimit) {
      throw new CoinServiceError('LUXURY_PURCHASE_LIMIT', '你已達到這個奢侈品的購買上限。', {
        currentQuantity,
        purchaseLimit: item.purchaseLimit,
      });
    }

    const totalPrice = item.price * normalizedQuantity;
    const player = ensurePlayer(api, guildId, userId);

    if (player.balance < totalPrice) {
      throw new CoinServiceError('INSUFFICIENT_FUNDS', '吉幣不足，無法購買奢侈品。', {
        balance: player.balance,
        required: totalPrice,
      });
    }

    const timestamp = nowIso();
    const after = player.balance - totalPrice;

    api.run(
      `UPDATE coin_players
       SET balance = ?, total_spent = total_spent + ?, updated_at = ?
       WHERE guild_id = ? AND user_id = ?`,
      [after, totalPrice, timestamp, guildId, userId]
    );

    if (item.stock !== null) {
      api.run('UPDATE luxury_items SET stock = stock - ?, updated_at = ? WHERE guild_id = ? AND id = ?', [
        normalizedQuantity,
        timestamp,
        guildId,
        item.id,
      ]);
    }

    updateLuxuryInventory(api, guildId, userId, item, normalizedQuantity, timestamp);
    api.run(
      `INSERT INTO luxury_purchases
        (guild_id, user_id, item_id, item_name, quantity, unit_price, total_price, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [guildId, userId, item.id, item.name, normalizedQuantity, item.price, totalPrice, timestamp]
    );
    insertTransaction(api, {
      guildId,
      userId,
      type: TransactionType.LUXURY_PURCHASE,
      balanceBefore: player.balance,
      amount: -totalPrice,
      balanceAfter: after,
      operatorId: null,
      reason: `購買奢侈品：${item.name}`,
      metadata: { itemId: item.id, quantity: normalizedQuantity },
      createdAt: timestamp,
    });

    return {
      item: mapLuxuryItem(api.get('SELECT * FROM luxury_items WHERE guild_id = ? AND id = ?', [guildId, item.id])),
      quantity: normalizedQuantity,
      unitPrice: item.price,
      totalPrice,
      before: player.balance,
      after,
    };
  });
}

async function getLuxuryInventory(guildId, userId, { page = 1, limit = DEFAULT_PAGE_SIZE } = {}) {
  return withCoinTransaction((api) => {
    const settings = ensureGuildSettings(api, guildId);
    assertEconomyEnabled(settings);
    ensurePlayer(api, guildId, userId);
    const normalizedPage = normalizePage(page);
    const normalizedLimit = normalizeLimit(limit);
    const offset = (normalizedPage - 1) * normalizedLimit;

    return {
      page: normalizedPage,
      limit: normalizedLimit,
      items: api
        .all(
          `SELECT *
           FROM luxury_inventory
           WHERE guild_id = ? AND user_id = ? AND quantity > 0
           ORDER BY updated_at DESC, id DESC
           LIMIT ? OFFSET ?`,
          [guildId, userId, normalizedLimit, offset]
        )
        .map(mapLuxuryInventory),
    };
  });
}

async function getLuxuryPurchaseHistory(guildId, userId, { limit = DEFAULT_PAGE_SIZE } = {}) {
  return withCoinDatabase((api) => {
    return api
      .all(
        `SELECT *
         FROM luxury_purchases
         WHERE guild_id = ? AND user_id = ?
         ORDER BY created_at DESC, id DESC
         LIMIT ?`,
        [guildId, userId, normalizeLimit(limit)]
      )
      .map(mapLuxuryPurchase);
  });
}

async function quotePawnItem(guildId, userId, itemId, quantity = 1) {
  return withCoinTransaction((api) => {
    const settings = ensureGuildSettings(api, guildId);
    assertEconomyEnabled(settings);
    const normalizedQuantity = normalizePositiveInteger(quantity, '當鋪數量');
    const itemRow = getLuxuryItemRow(api, guildId, itemId, { includeDeleted: true });

    if (!itemRow) {
      throw new CoinServiceError('LUXURY_ITEM_NOT_FOUND', '找不到這個奢侈品商品。');
    }

    const item = mapLuxuryItem(itemRow);
    assertInventoryQuantity(api, guildId, userId, item.id, normalizedQuantity);
    const payoutAmount = Math.floor(item.price * normalizedQuantity * 0.8);

    return {
      item,
      quantity: normalizedQuantity,
      pawnUnitPrice: item.price,
      payoutAmount,
    };
  });
}

async function pawnLuxuryItem(guildId, userId, itemId, quantity = 1) {
  return withCoinTransaction((api) => {
    const settings = ensureGuildSettings(api, guildId);
    assertEconomyEnabled(settings);
    const normalizedQuantity = normalizePositiveInteger(quantity, '當鋪數量');
    const itemRow = getLuxuryItemRow(api, guildId, itemId, { includeDeleted: true });

    if (!itemRow) {
      throw new CoinServiceError('LUXURY_ITEM_NOT_FOUND', '找不到這個奢侈品商品。');
    }

    const item = mapLuxuryItem(itemRow);
    assertInventoryQuantity(api, guildId, userId, item.id, normalizedQuantity);
    const player = ensurePlayer(api, guildId, userId);
    const payoutAmount = Math.floor(item.price * normalizedQuantity * 0.8);
    const timestamp = nowIso();
    const after = player.balance + payoutAmount;

    decrementLuxuryInventory(api, guildId, userId, item.id, normalizedQuantity);
    api.run(
      `UPDATE coin_players
       SET balance = ?, total_earned = total_earned + ?, updated_at = ?
       WHERE guild_id = ? AND user_id = ?`,
      [after, payoutAmount, timestamp, guildId, userId]
    );
    api.run(
      `INSERT INTO luxury_pawn_records
        (guild_id, user_id, item_id, item_name, quantity, remaining_quantity, pawn_unit_price, payout_amount, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
      [
        guildId,
        userId,
        item.id,
        item.name,
        normalizedQuantity,
        normalizedQuantity,
        item.price,
        payoutAmount,
        timestamp,
        timestamp,
      ]
    );
    const pawnRecordId = Number(api.get('SELECT last_insert_rowid() AS id').id);
    insertTransaction(api, {
      guildId,
      userId,
      type: TransactionType.PAWN_PAYOUT,
      balanceBefore: player.balance,
      amount: payoutAmount,
      balanceAfter: after,
      operatorId: null,
      reason: `當掉奢侈品：${item.name}`,
      metadata: { itemId: item.id, quantity: normalizedQuantity, pawnRecordId },
      createdAt: timestamp,
    });

    return {
      record: mapPawnRecord(api.get('SELECT * FROM luxury_pawn_records WHERE id = ?', [pawnRecordId])),
      item,
      quantity: normalizedQuantity,
      payoutAmount,
      before: player.balance,
      after,
    };
  });
}

async function redeemPawnRecord(guildId, userId, pawnRecordId, quantity = 1) {
  return withCoinTransaction((api) => {
    const settings = ensureGuildSettings(api, guildId);
    assertEconomyEnabled(settings);
    const normalizedQuantity = normalizePositiveInteger(quantity, '贖回數量');
    const recordRow = api.get(
      `SELECT *
       FROM luxury_pawn_records
       WHERE guild_id = ? AND user_id = ? AND id = ?`,
      [guildId, userId, pawnRecordId]
    );

    if (!recordRow) {
      throw new CoinServiceError('PAWN_RECORD_NOT_FOUND', '找不到這筆當鋪紀錄。');
    }

    const record = mapPawnRecord(recordRow);

    if (record.remainingQuantity <= 0 || record.status !== 'active') {
      throw new CoinServiceError('PAWN_RECORD_CLOSED', '這筆當鋪紀錄已經沒有可贖回的商品。');
    }

    if (record.remainingQuantity < normalizedQuantity) {
      throw new CoinServiceError('PAWN_REDEEM_TOO_MANY', '贖回數量超過這筆紀錄剩餘數量。', {
        remainingQuantity: record.remainingQuantity,
      });
    }

    const itemRow = getLuxuryItemRow(api, guildId, record.itemId, { includeDeleted: true });

    if (!itemRow) {
      throw new CoinServiceError('LUXURY_ITEM_NOT_FOUND', '找不到這個奢侈品商品，暫時無法贖回。');
    }

    const item = mapLuxuryItem(itemRow);
    const redeemUnitPrice = getHistoricalHighPrice(api, guildId, item.id, item.price);
    const totalPrice = redeemUnitPrice * normalizedQuantity;
    const player = ensurePlayer(api, guildId, userId);

    if (player.balance < totalPrice) {
      throw new CoinServiceError('INSUFFICIENT_FUNDS', '吉幣不足，無法贖回商品。', {
        balance: player.balance,
        required: totalPrice,
      });
    }

    const timestamp = nowIso();
    const after = player.balance - totalPrice;
    const remainingQuantity = record.remainingQuantity - normalizedQuantity;
    const status = remainingQuantity === 0 ? 'redeemed' : 'active';

    api.run(
      `UPDATE coin_players
       SET balance = ?, total_spent = total_spent + ?, updated_at = ?
       WHERE guild_id = ? AND user_id = ?`,
      [after, totalPrice, timestamp, guildId, userId]
    );
    updateLuxuryInventory(api, guildId, userId, item, normalizedQuantity, timestamp);
    api.run(
      `UPDATE luxury_pawn_records
       SET remaining_quantity = ?,
           redeemed_quantity = redeemed_quantity + ?,
           redeemed_amount = redeemed_amount + ?,
           status = ?,
           updated_at = ?,
           redeemed_at = CASE WHEN ? = 0 THEN ? ELSE redeemed_at END
       WHERE id = ?`,
      [remainingQuantity, normalizedQuantity, totalPrice, status, timestamp, remainingQuantity, timestamp, record.id]
    );
    api.run(
      `INSERT INTO luxury_pawn_redemptions
        (guild_id, user_id, pawn_record_id, item_id, item_name, quantity, redeem_unit_price, total_price, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [guildId, userId, record.id, item.id, item.name, normalizedQuantity, redeemUnitPrice, totalPrice, timestamp]
    );
    insertTransaction(api, {
      guildId,
      userId,
      type: TransactionType.PAWN_REDEEM,
      balanceBefore: player.balance,
      amount: -totalPrice,
      balanceAfter: after,
      operatorId: null,
      reason: `贖回奢侈品：${item.name}`,
      metadata: { itemId: item.id, quantity: normalizedQuantity, pawnRecordId: record.id, redeemUnitPrice },
      createdAt: timestamp,
    });

    return {
      record: mapPawnRecord(api.get('SELECT * FROM luxury_pawn_records WHERE id = ?', [record.id])),
      item,
      quantity: normalizedQuantity,
      redeemUnitPrice,
      totalPrice,
      before: player.balance,
      after,
    };
  });
}

async function listPawnRecords(guildId, userId, { activeOnly = false, limit = DEFAULT_PAGE_SIZE } = {}) {
  return withCoinDatabase((api) => {
    const params = [guildId, userId];
    let where = 'WHERE guild_id = ? AND user_id = ?';

    if (activeOnly) {
      where += " AND status = 'active' AND remaining_quantity > 0";
    }

    params.push(normalizeLimit(limit));

    return api
      .all(
        `SELECT *
         FROM luxury_pawn_records
         ${where}
         ORDER BY created_at DESC, id DESC
         LIMIT ?`,
        params
      )
      .map(mapPawnRecord);
  });
}

async function listPawnRedemptions(guildId, userId, { limit = DEFAULT_PAGE_SIZE } = {}) {
  return withCoinDatabase((api) => {
    return api
      .all(
        `SELECT *
         FROM luxury_pawn_redemptions
         WHERE guild_id = ? AND user_id = ?
         ORDER BY created_at DESC, id DESC
         LIMIT ?`,
        [guildId, userId, normalizeLimit(limit)]
      )
      .map(mapPawnRedemption);
  });
}

module.exports = {
  createLuxuryItem,
  deleteLuxuryItem,
  editLuxuryItem,
  getHistoricalHighPrice,
  getLuxuryInventory,
  getLuxuryItem,
  getLuxuryPurchaseHistory,
  listLuxuryItems,
  listPawnRecords,
  listPawnRedemptions,
  pawnLuxuryItem,
  purchaseLuxuryItem,
  quotePawnItem,
  redeemPawnRecord,
  setLuxuryItemEnabled,
  // Exported for focused service tests.
  mapLuxuryItem,
  mapPawnRecord,
};
