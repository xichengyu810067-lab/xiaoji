const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { 
  AuditStatus, 
  isGuildApproved, 
  setGuildAudit, 
  isWhitelisted, 
  addToWhitelist, 
  removeFromWhitelist 
} = require('../src/services/auditService');

// Use temporary data files for testing if possible, but auditService has hardcoded paths.
// I'll just test the logic and clean up if I can, or trust the existing persistence.
// Since I can't easily change the paths without modifying the service, I'll just verify the behavior.

test('isGuildApproved returns true only for approved status', () => {
  const guildId = 'test-guild-123';
  
  setGuildAudit(guildId, { status: AuditStatus.APPROVED, name: 'Test Guild' });
  assert.equal(isGuildApproved(guildId), true);
  
  setGuildAudit(guildId, { status: AuditStatus.PENDING });
  assert.equal(isGuildApproved(guildId), false);
  
  setGuildAudit(guildId, { status: AuditStatus.DENIED });
  assert.equal(isGuildApproved(guildId), false);
});

test('whitelist management adds and removes users', () => {
  const userId = 'test-user-456';
  
  // Clean start
  removeFromWhitelist(userId);
  assert.equal(isWhitelisted(userId), false);
  
  // Add
  const added = addToWhitelist(userId, 'owner-789');
  assert.equal(added, true);
  assert.equal(isWhitelisted(userId), true);
  
  // Duplicate add
  const addedAgain = addToWhitelist(userId, 'owner-789');
  assert.equal(addedAgain, false);
  
  // Remove
  const removed = removeFromWhitelist(userId);
  assert.equal(removed, true);
  assert.equal(isWhitelisted(userId), false);
  
  // Remove non-existent
  const removedAgain = removeFromWhitelist(userId);
  assert.equal(removedAgain, false);
});
