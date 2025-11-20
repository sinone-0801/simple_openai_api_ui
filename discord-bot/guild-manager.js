// guild-manager.js
// =============================================================================
// Guild管理システム（リクエスト承認方式）
// =============================================================================
// 複数のDiscordサーバー（Guild）でBotを使用するための管理システム。
// Botがサーバーに追加されると自動的にリクエストが作成され、
// 管理者がCLIツールで承認・拒否する仕組みです。
//
// セキュリティ設計：
// - マスターシークレットとGuild IDからHMAC-SHA256で認証トークンを生成
// - 各Guildは異なる認証情報を持つが、環境変数は1つで済む
// - Botがサーバーに追加されても、管理者が承認するまで有効化されない
// - 攻撃者がGuild IDを知っていても、マスターシークレットがなければ認証不可
// =============================================================================

import 'dotenv/config';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// =============================================================================
// 設定
// =============================================================================

const GUILDS_CONFIG_PATH = path.join(__dirname, 'data', 'guilds.json');
const GUILD_REQUESTS_PATH = path.join(__dirname, 'data', 'guild-requests.json');

// マスターシークレット（環境変数から取得）
const MASTER_SECRET = process.env.BOT_MASTER_SECRET;

if (!MASTER_SECRET) {
  console.error('Error: BOT_MASTER_SECRET is not set in environment variables');
  console.error('Please set a strong master secret (at least 32 characters)');
  process.exit(1);
}

if (MASTER_SECRET.length < 32) {
  console.warn('Warning: BOT_MASTER_SECRET should be at least 32 characters long for security');
}

// =============================================================================
// Guild認証トークン生成
// =============================================================================

/**
 * Guild IDからHMAC-SHA256認証トークンを生成
 * この関数は、マスターシークレットとGuild IDを使用して、
 * そのGuild専用の認証トークンを生成します。
 * 
 * @param {string} guildId - Discord Guild ID
 * @returns {string} HMAC-SHA256認証トークン（Hex形式）
 */
export function generateGuildAuthToken(guildId) {
  if (!guildId || typeof guildId !== 'string') {
    throw new Error('Invalid guild ID');
  }

  const hmac = crypto.createHmac('sha256', MASTER_SECRET);
  hmac.update(guildId);
  return hmac.digest('hex');
}

/**
 * Guild認証トークンを検証
 * 
 * @param {string} guildId - Discord Guild ID
 * @param {string} token - 検証するトークン
 * @returns {boolean} トークンが正しい場合true
 */
export function verifyGuildAuthToken(guildId, token) {
  const expectedToken = generateGuildAuthToken(guildId);
  
  // タイミング攻撃を防ぐため、crypto.timingSafeEqualを使用
  try {
    const expectedBuffer = Buffer.from(expectedToken, 'hex');
    const tokenBuffer = Buffer.from(token, 'hex');
    
    if (expectedBuffer.length !== tokenBuffer.length) {
      return false;
    }
    
    return crypto.timingSafeEqual(expectedBuffer, tokenBuffer);
  } catch {
    return false;
  }
}

/**
 * API用の認証ヘッダー値を生成
 * 形式: botUserId:guildAuthToken:password
 * 
 * @param {string} botUserId - BotのユーザーID
 * @param {string} guildId - Discord Guild ID
 * @returns {string} 認証ヘッダー値
 */
export function generateBotAuthHeader(botUserId, guildId) {
  const guildToken = generateGuildAuthToken(guildId);
  return `${botUserId}:${guildToken}:password`;
}

// =============================================================================
// Guild設定管理
// =============================================================================

/**
 * Guild設定をファイルから読み込み
 * 
 * @returns {object} Guild設定オブジェクト
 */
export function loadGuildConfig() {
  try {
    if (!fs.existsSync(GUILDS_CONFIG_PATH)) {
      return {};
    }
    
    const data = fs.readFileSync(GUILDS_CONFIG_PATH, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    console.error('Error loading guild config:', error.message);
    return {};
  }
}

/**
 * Guild設定をファイルに保存
 * 
 * @param {object} config - Guild設定オブジェクト
 */
export function saveGuildConfig(config) {
  try {
    const dir = path.dirname(GUILDS_CONFIG_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    
    fs.writeFileSync(GUILDS_CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
  } catch (error) {
    console.error('Error saving guild config:', error.message);
    throw error;
  }
}

// =============================================================================
// Guildリクエスト管理
// =============================================================================

/**
 * Guildリクエストをファイルから読み込み
 * 
 * @returns {object} Guildリクエストオブジェクト
 */
export function loadGuildRequests() {
  try {
    if (!fs.existsSync(GUILD_REQUESTS_PATH)) {
      return {};
    }
    
    const data = fs.readFileSync(GUILD_REQUESTS_PATH, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    console.error('Error loading guild requests:', error.message);
    return {};
  }
}

/**
 * Guildリクエストをファイルに保存
 * 
 * @param {object} requests - Guildリクエストオブジェクト
 */
export function saveGuildRequests(requests) {
  try {
    const dir = path.dirname(GUILD_REQUESTS_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    
    fs.writeFileSync(GUILD_REQUESTS_PATH, JSON.stringify(requests, null, 2), 'utf8');
  } catch (error) {
    console.error('Error saving guild requests:', error.message);
    throw error;
  }
}

/**
 * Guildリクエストを保存
 * Botが新しいサーバーに追加された際に呼び出される
 * 
 * @param {string} guildId - Discord Guild ID
 * @param {string} guildName - Guild名
 * @param {object} metadata - 追加のメタデータ（オプション）
 */
export function saveGuildRequest(guildId, guildName, metadata = {}) {
  const requests = loadGuildRequests();
  const config = loadGuildConfig();
  
  // 既に登録済みの場合はスキップ
  if (config[guildId]) {
    console.log(`Guild ${guildId} is already registered. Skipping request.`);
    return false;
  }
  
  // 既にリクエストが存在する場合はスキップ
  if (requests[guildId]) {
    console.log(`Guild ${guildId} already has a pending request.`);
    return false;
  }
  
  requests[guildId] = {
    name: guildName,
    requestedAt: new Date().toISOString(),
    status: 'pending',
    ...metadata
  };
  
  saveGuildRequests(requests);
  console.log(`📬 New guild request: ${guildName} (${guildId})`);
  return true;
}

/**
 * 承認待ちのGuildリクエストを取得
 * 
 * @returns {array} 承認待ちリクエストの配列
 */
export function getPendingGuildRequests() {
  const requests = loadGuildRequests();
  
  return Object.entries(requests)
    .filter(([_, req]) => req.status === 'pending')
    .map(([guildId, req]) => ({
      guildId,
      ...req
    }));
}

/**
 * Guildリクエストを承認して登録
 * 
 * @param {string} guildId - Discord Guild ID
 * @param {object} options - オプション設定
 */
export function approveGuildRequest(guildId, options = {}) {
  const requests = loadGuildRequests();
  const request = requests[guildId];
  
  if (!request) {
    throw new Error(`Guild request ${guildId} not found`);
  }
  
  if (request.status !== 'pending') {
    throw new Error(`Guild request ${guildId} is not pending (status: ${request.status})`);
  }
  
  // Guildを登録
  const config = loadGuildConfig();
  config[guildId] = {
    name: request.name,
    registeredAt: new Date().toISOString(),
    requestedAt: request.requestedAt,
    enabled: true,
    ...options
  };
  saveGuildConfig(config);
  
  // リクエストを承認済みに更新
  request.status = 'approved';
  request.approvedAt = new Date().toISOString();
  saveGuildRequests(requests);
  
  console.log(`✅ Guild approved and registered: ${request.name} (${guildId})`);
  return config[guildId];
}

/**
 * Guildリクエストを拒否
 * 
 * @param {string} guildId - Discord Guild ID
 * @param {string} reason - 拒否理由（オプション）
 */
export function rejectGuildRequest(guildId, reason = '') {
  const requests = loadGuildRequests();
  const request = requests[guildId];
  
  if (!request) {
    throw new Error(`Guild request ${guildId} not found`);
  }
  
  if (request.status !== 'pending') {
    throw new Error(`Guild request ${guildId} is not pending (status: ${request.status})`);
  }
  
  // リクエストを拒否済みに更新
  request.status = 'rejected';
  request.rejectedAt = new Date().toISOString();
  if (reason) {
    request.rejectionReason = reason;
  }
  saveGuildRequests(requests);
  
  console.log(`❌ Guild request rejected: ${request.name} (${guildId})`);
  if (reason) {
    console.log(`   Reason: ${reason}`);
  }
}

/**
 * 処理済みリクエストをクリーンアップ
 * 
 * @param {number} daysOld - 何日前までのリクエストを保持するか
 */
export function cleanupOldRequests(daysOld = 30) {
  const requests = loadGuildRequests();
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - daysOld);
  
  let cleaned = 0;
  
  Object.entries(requests).forEach(([guildId, req]) => {
    if (req.status !== 'pending') {
      const reqDate = new Date(req.approvedAt || req.rejectedAt || req.requestedAt);
      if (reqDate < cutoffDate) {
        delete requests[guildId];
        cleaned++;
      }
    }
  });
  
  if (cleaned > 0) {
    saveGuildRequests(requests);
    console.log(`🧹 Cleaned up ${cleaned} old request(s)`);
  } else {
    console.log('No old requests to clean up');
  }
}

// =============================================================================
// Guild管理（既存機能）
// =============================================================================

/**
 * Guildを手動登録（リクエストなしで直接登録）
 * 
 * @param {string} guildId - Discord Guild ID
 * @param {string} guildName - Guild名（表示用）
 * @param {object} options - オプション設定
 */
export function registerGuild(guildId, guildName, options = {}) {
  const config = loadGuildConfig();
  
  if (config[guildId]) {
    throw new Error(`Guild ${guildId} is already registered`);
  }
  
  config[guildId] = {
    name: guildName,
    registeredAt: new Date().toISOString(),
    enabled: true,
    ...options
  };
  
  saveGuildConfig(config);
  
  console.log(`✅ Guild registered: ${guildName} (${guildId})`);
  console.log(`   Auth Token: ${generateGuildAuthToken(guildId).substring(0, 16)}...`);
}

/**
 * Guildを無効化
 * 
 * @param {string} guildId - Discord Guild ID
 */
export function disableGuild(guildId) {
  const config = loadGuildConfig();
  
  if (!config[guildId]) {
    throw new Error(`Guild ${guildId} not found`);
  }
  
  config[guildId].enabled = false;
  saveGuildConfig(config);
  
  console.log(`⏸️  Guild disabled: ${config[guildId].name} (${guildId})`);
}

/**
 * Guildを有効化
 * 
 * @param {string} guildId - Discord Guild ID
 */
export function enableGuild(guildId) {
  const config = loadGuildConfig();
  
  if (!config[guildId]) {
    throw new Error(`Guild ${guildId} not found`);
  }
  
  config[guildId].enabled = true;
  saveGuildConfig(config);
  
  console.log(`▶️  Guild enabled: ${config[guildId].name} (${guildId})`);
}

/**
 * Guildが有効かチェック
 * 
 * @param {string} guildId - Discord Guild ID
 * @returns {boolean} 有効な場合true
 */
export function isGuildEnabled(guildId) {
  const config = loadGuildConfig();
  return config[guildId]?.enabled === true;
}

/**
 * 登録されている全Guildを取得
 * 
 * @returns {array} Guild情報の配列
 */
export function getAllGuilds() {
  const config = loadGuildConfig();
  
  return Object.entries(config).map(([guildId, info]) => ({
    guildId,
    ...info,
    authToken: generateGuildAuthToken(guildId)
  }));
}

/**
 * Guild認証情報を表示（セットアップ用）
 * 
 * @param {string} guildId - Discord Guild ID
 */
export function displayGuildAuthInfo(guildId) {
  const config = loadGuildConfig();
  const guildInfo = config[guildId];
  
  if (!guildInfo) {
    console.error(`\n❌ Guild ${guildId} is not registered.`);
    console.log('Register it first or approve its request.\n');
    return;
  }
  
  const authToken = generateGuildAuthToken(guildId);
  const botUserId = process.env.BOT_USER_ID || 'discord-bot';
  
  console.log('\n' + '='.repeat(70));
  console.log(`Guild Authentication Information`);
  console.log('='.repeat(70));
  console.log(`Guild Name: ${guildInfo.name}`);
  console.log(`Guild ID: ${guildId}`);
  console.log(`Status: ${guildInfo.enabled ? '✅ Enabled' : '❌ Disabled'}`);
  console.log('='.repeat(70));
  console.log('\nFor API authentication (userId:password format):');
  console.log(`User ID: ${botUserId}`);
  console.log(`Password: ${authToken}`);
  console.log('\nCombined format:');
  console.log(`${botUserId}:${authToken}`);
  console.log('='.repeat(70));
  console.log('\n⚠️  Keep this information secure!\n');
}
