/**
 * Redis-backed token storage for Zoom OAuth tokens
 * This is needed because session cookies don't work in Zoom iframe apps
 *
 * Tokens are stored per-user in Redis with key "oauth:tokens:{userId}"
 */

const redisClient = require('./redis-client');

const tokenKey = (userId) => `oauth:tokens:${userId}`;
const ACTIVE_USER_KEY = 'oauth:active_user';

/**
 * Store tokens in Redis for a specific user
 * @param {string} userId - Zoom user ID
 * @param {Object} tokens - Token object with accessToken, refreshToken, expiresAt
 */
async function setTokens(userId, { accessToken, refreshToken, expiresAt }) {
  try {
    await redisClient.set(tokenKey(userId), JSON.stringify({
      accessToken,
      refreshToken,
      expiresAt
    }));
    console.log(`Tokens stored in Redis for user ${userId}`);
  } catch (error) {
    console.error('Failed to store tokens in Redis:', error);
    throw error;
  }
}

/**
 * Get tokens from Redis for a specific user
 * @param {string} userId - Zoom user ID
 * @returns {Object} Token object with accessToken, refreshToken, expiresAt
 */
async function getTokens(userId) {
  try {
    const data = await redisClient.get(tokenKey(userId));
    if (!data) {
      return { accessToken: null, refreshToken: null, expiresAt: null };
    }
    return JSON.parse(data);
  } catch (error) {
    console.error('Failed to get tokens from Redis:', error);
    return { accessToken: null, refreshToken: null, expiresAt: null };
  }
}

/**
 * Clear tokens from Redis for a specific user
 * @param {string} userId - Zoom user ID
 */
async function clearTokens(userId) {
  try {
    await redisClient.del(tokenKey(userId));
    console.log(`Tokens cleared from Redis for user ${userId}`);
  } catch (error) {
    console.error('Failed to clear tokens from Redis:', error);
  }
}

/**
 * Check if a valid token exists for a specific user
 * @param {string} userId - Zoom user ID
 * @returns {Promise<boolean>}
 */
async function hasValidToken(userId) {
  const tokens = await getTokens(userId);
  return !!tokens.accessToken && (!tokens.expiresAt || tokens.expiresAt > Date.now());
}

/**
 * Persist the most recently authenticated user ID
 * @param {string} userId - Zoom user ID
 */
async function setActiveUserId(userId) {
  await redisClient.set(ACTIVE_USER_KEY, userId);
}

/**
 * Get the most recently authenticated user ID
 * @returns {Promise<string|null>}
 */
async function getActiveUserId() {
  return redisClient.get(ACTIVE_USER_KEY);
}

module.exports = {
  setTokens,
  getTokens,
  clearTokens,
  hasValidToken,
  setActiveUserId,
  getActiveUserId
};
