// discord-bot.js
import { Client, Events, GatewayIntentBits, REST, Routes, SlashCommandBuilder, EmbedBuilder, MessageFlags, ChannelType, PermissionFlagsBits, ActionRowBuilder, StringSelectMenuBuilder, ComponentType } from 'discord.js';
import fetch from 'node-fetch';
import 'dotenv/config';
import { generateGuildAuthToken, isGuildEnabled, loadGuildConfig, saveGuildRequest } from './guild-manager.js';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DISCORD_DATA_DIR = path.join(__dirname, 'data');

const CONFIG = {
  API_BASE_URL: process.env.API_BASE_URL || 'http://localhost:3000',
  BOT_USER_ID: process.env.BOT_USER_ID || 'discord-bot',  // このサーバーのDB上のBotユーザーのID (Adminアカウントとして登録されている必要がある)
  DISCORD_BOT_TOKEN: process.env.DISCORD_BOT_TOKEN,
  DISCORD_APP_ID: process.env.DISCORD_APP_ID,
  OAUTH2_LOGIN_URL: `${process.env.API_BASE_URL || 'http://localhost:3000'}/auth/discord/login`,
  OAUTH2_CALLBACK_URL: `${process.env.API_BASE_URL || 'http://localhost:3000'}/auth/discord/callback`,
  BOT_DEFAULT_CREDIT: parseInt(process.env.BOT_DEFAULT_CREDIT || '10000000'),
  DEFAULT_MODEL: process.env.ORCHESTRATOR_MODEL || 'gpt-5-codex',
  MAX_MESSAGE_LENGTH: 2000,
  DEBUG: process.env.DEBUG || 'true',
  TEMP_CHANNELS_FILE: path.join(DISCORD_DATA_DIR, 'temp-channels.json'),
  ONE_SHOT_FILE: path.join(DISCORD_DATA_DIR, 'one-shot-conversations.json'),
  AUTO_REPLY_INTERVAL: 5 * 60 * 1000, // 5分
  AUTO_REPLY_MIN_IDLE_TIME: 10 * 60 * 1000, // 10分
  AUTO_REPLY_MIN_TIME_BEFORE_DELETE: 30 * 60 * 1000 // 30分
};

const Authority = { ADMIN: 'Admin', VIP: 'Vip', USER: 'User', PENDING: 'Pending', STOPPED: 'Stopped', BANNED: 'Banned' };

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds, 
    GatewayIntentBits.GuildMessages, 
    GatewayIntentBits.GuildMembers, 
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates
  ]
});

// JWTトークンキャッシュ（guildId別）
const tokenCache = new Map();

// 一時チャンネル管理
let tempChannels = {};

// 単発生成モード管理
// { messageId: { userId, guildId, model, systemPrompt, createdAt, parentMessageId } }
let oneShotConversations = {};

// 利用可能なモデル一覧（APIから取得）
let availableModels = [];
const TEMP_CHANNEL_SELECTION_TTL = 10 * 60 * 1000; // 10 minutes
const pendingChannelSelections = new Map();
const TEMP_CHANNEL_SELECT_CUSTOM_ID = 'temp-channel-select';

function truncateString(str = '', maxLength = 100) {
  if (!str) return '';
  return str.length > maxLength ? `${str.slice(0, maxLength - 1)}…` : str;
}

function buildTempChannelSelectRow(channels, requestId, placeholder = 'チャンネルを選択してください') {
  if (!channels.length) return null;
  const visibleChannels = channels.slice(0, 25); // Discordの選択肢は最大25件
  const selectMenu = new StringSelectMenuBuilder()
    .setCustomId(`${TEMP_CHANNEL_SELECT_CUSTOM_ID}:${requestId}`)
    .setPlaceholder(placeholder)
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(
      visibleChannels.map(channel => {
        const typeLabel = channel.type === 'voice' ? 'ボイス' : 'テキスト';
        const categoryLabel = channel.categoryName || 'カテゴリなし';
        return {
          label: truncateString(channel.name || '不明なチャンネル', 100),
          description: truncateString(`${categoryLabel} / ${typeLabel}`, 100),
          value: channel.channelId
        };
      })
    );

  return new ActionRowBuilder().addComponents(selectMenu);
}

/**
 * APIから利用可能なモデル一覧を取得
 */
async function fetchAvailableModels() {
  try {
    // まず、どれかのguildIdでBot用のJWTトークンを取得する必要あり
    // 起動時にはguildがない場合があるので、エラーハンドリングが必要
    
    // 公開エンドポイントがない場合は、デフォルトのモデル一覧を使用
    const defaultModels = [
      { name: 'GPT-5.1', value: 'gpt-5.1' },
      { name: 'GPT-5-mini', value: 'gpt-5-mini' },
      { name: 'GPT-5.1-codex', value: 'gpt-5.1-codex' },
      { name: 'o1', value: 'o1' },
      { name: 'o4-mini', value: 'o4-mini' }
    ];
    
    // 登録されているguildから1つ取得してトークンを使う
    const guildsConfig = loadGuildConfig();
    const registeredGuilds = Object.keys(guildsConfig);
    
    if (registeredGuilds.length === 0) {
      console.log('[Models] No guilds registered, using default model list');
      return defaultModels;
    }
    
    // 最初の登録guildを使用
    const firstGuildId = registeredGuilds[0];
    
    try {
      const token = await getBotJWTToken(firstGuildId);
      const response = await fetch(`${CONFIG.API_BASE_URL}/api/models`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      
      if (!response.ok) {
        console.log('[Models] Failed to fetch models from API, using default list');
        return defaultModels;
      }
      
      const data = await response.json();
      
      // availableModels配列から選択肢を生成
      if (data.availableModels && Array.isArray(data.availableModels)) {
        const modelChoices = data.availableModels.map(model => ({
          name: model,
          value: model
        }));
        
        console.log(`[Models] Loaded ${modelChoices.length} models from API`);
        return modelChoices;
      }
      
      return defaultModels;
    } catch (error) {
      console.error('[Models] Error fetching models:', error.message);
      return defaultModels;
    }
  } catch (error) {
    console.error('[Models] Error in fetchAvailableModels:', error);
    return [
      { name: 'GPT-5.1', value: 'gpt-5.1' },
      { name: 'GPT-5-mini', value: 'gpt-5-mini' },
      { name: 'GPT-5.1-codex', value: 'gpt-5.1-codex' },
      { name: 'o1', value: 'o1' },
      { name: 'o4-mini', value: 'o4-mini' }
    ];
  }
}

/**
 * 一時チャンネルデータを読み込む
 */
async function loadTempChannels() {
  try {
    const data = await fs.readFile(CONFIG.TEMP_CHANNELS_FILE, 'utf-8');
    tempChannels = JSON.parse(data);
    console.log(`[TempChannel] Loaded ${Object.keys(tempChannels).length} temporary channels`);
  } catch (error) {
    if (error.code === 'ENOENT') {
      console.log('[TempChannel] No existing temp channels file, starting fresh');
      tempChannels = {};
    } else {
      console.error('[TempChannel] Error loading temp channels:', error);
      tempChannels = {};
    }
  }
}

/**
 * 一時チャンネルデータを保存する
 */
async function saveTempChannels() {
  try {
    await fs.writeFile(CONFIG.TEMP_CHANNELS_FILE, JSON.stringify(tempChannels, null, 2), 'utf-8');
    if (CONFIG.DEBUG) {
      console.log(`[TempChannel] Saved ${Object.keys(tempChannels).length} temporary channels`);
    }
  } catch (error) {
    console.error('[TempChannel] Error saving temp channels:', error);
  }
}

/**
 * 単発生成モード会話データを読み込む
 */
async function loadOneShotConversations() {
  try {
    const data = await fs.readFile(CONFIG.ONE_SHOT_FILE, 'utf-8');
    oneShotConversations = JSON.parse(data);
    console.log(`[OneShot] Loaded ${Object.keys(oneShotConversations).length} conversations`);
  } catch (error) {
    if (error.code === 'ENOENT') {
      console.log('[OneShot] No existing one-shot conversations file, starting fresh');
      oneShotConversations = {};
    } else {
      console.error('[OneShot] Error loading one-shot conversations:', error);
      oneShotConversations = {};
    }
  }
}

/**
 * 単発生成モード会話データを保存する
 */
async function saveOneShotConversations() {
  try {
    await fs.writeFile(CONFIG.ONE_SHOT_FILE, JSON.stringify(oneShotConversations, null, 2), 'utf-8');
    if (CONFIG.DEBUG) {
      console.log(`[OneShot] Saved ${Object.keys(oneShotConversations).length} conversations`);
    }
  } catch (error) {
    console.error('[OneShot] Error saving one-shot conversations:', error);
  }
}

/**
 * 3日以上前の単発生成モード会話を削除
 */
async function cleanupOldOneShotConversations() {
  const now = Date.now();
  const threeDaysAgo = now - (3 * 24 * 60 * 60 * 1000);
  let cleaned = 0;

  for (const [messageId, data] of Object.entries(oneShotConversations)) {
    if (data.createdAt < threeDaysAgo) {
      delete oneShotConversations[messageId];
      cleaned++;
    }
  }

  if (cleaned > 0) {
    await saveOneShotConversations();
    console.log(`[OneShot] Cleaned up ${cleaned} old conversation(s) (older than 3 days)`);
  }

  return cleaned;
}

/**
 * 一時チャンネルを登録する
 */
async function registerTempChannel(guildId, guildName, channelId, channelData) {
  const key = `${guildId}-${channelId}`;

  // グループスレッドIDを取得
  const threadId = await getOrCreateGroupThread(CONFIG.BOT_USER_ID, guildId, channelId, channelData.name, guildName);

  tempChannels[key] = {
    ...channelData,
    threadId,
    guildName,
    createdAt: Date.now(),
    lastActivity: Date.now(),
    lastNonBotActivity: Date.now() // Bot以外の最終アクティビティ
  };
  await saveTempChannels();
}

/**
 * 一時チャンネルの最終アクティビティを更新する
 */
async function updateChannelActivity(guildId, channelId, isBot = false) {
  const key = `${guildId}-${channelId}`;
  if (tempChannels[key]) {
    tempChannels[key].lastActivity = Date.now();
    if (!isBot) {
      tempChannels[key].lastNonBotActivity = Date.now();
    }
    await saveTempChannels();
  }
}

/**
 * 一時チャンネルを削除する
 */
async function unregisterTempChannel(guildId, channelId) {
  const key = `${guildId}-${channelId}`;
  delete tempChannels[key];
  await saveTempChannels();
}

/**
 * 削除タイミングのミリ秒変換
 */
function getDeleteDelayMs(deleteAfter) {
  const delays = {
    '10min': 10 * 60 * 1000,
    '1hour': 60 * 60 * 1000,
    '1day': 24 * 60 * 60 * 1000,
    '3days': 3 * 24 * 60 * 60 * 1000,
    '14days': 14 * 24 * 60 * 60 * 1000
  };
  return delays[deleteAfter] || delays['1hour'];
}

/**
 * グループスレッドIDを生成（チャンネルIDベース、末尾に_gを追加）
 */
function getGroupThreadId(guildId, channelId) {
    return `thread-${guildId}_${channelId}_g`;
}

function getGuildTempChannels(guildId) {
  return Object.entries(tempChannels)
    .filter(([key]) => key.startsWith(`${guildId}-`))
    .map(([key, data]) => {
      const [, channelId] = key.split('-');
      return { channelId, ...data };
    });
}

function createPendingSelection(data) {
  const requestId = randomUUID();
  pendingChannelSelections.set(requestId, { ...data, createdAt: Date.now() });
  setTimeout(() => {
    const stored = pendingChannelSelections.get(requestId);
    if (stored && Date.now() - stored.createdAt >= TEMP_CHANNEL_SELECTION_TTL) {
      pendingChannelSelections.delete(requestId);
    }
  }, TEMP_CHANNEL_SELECTION_TTL).unref?.();
  return requestId;
}

/**
 * メンション形式を変換: ロールメンション<@&1234567890> または ニックネームありユーザーメンション<@!1234567890> または ニックネームなしユーザーメンション<@1234567890> → <message_for_user: username>
 */
async function convertMentionsToReadable(content, guild) {
  let convertedContent = content;
  
  // サーバーニックネームありユーザーメンションの変換: <message_for_user: 1234567890>
  const userMentionRegex = /<@!?(\d+)>/g;
  let match;
  while ((match = userMentionRegex.exec(content)) !== null) {
    const userId = match[1];
    try {
      const member = await guild.members.fetch(userId);
      if (member) {
        convertedContent = convertedContent.replace(match[0], `<message_for_user: ${member.user.username}>`);
      }
    } catch (error) {
      console.error(`[Mention] Failed to fetch user ${userId}:`, error.message);
    }
  }
  
  // ロールメンションの変換: <@&1234567890>
  const roleMentionRegex = /<@&(\d+)>/g;
  while ((match = roleMentionRegex.exec(content)) !== null) {
    const roleId = match[1];
    const role = guild.roles.cache.get(roleId);
    if (role) {
      convertedContent = convertedContent.replace(match[0], `<message_for_role: ${role.name}>`);
    }
  }
  
  // 残りのサーバーニックネームなしユーザーメンションの変換: <message_for_user: 1234567890>
  const nicknamelessUserMentionRegex = /<@?(\d+)>/g;
  while ((match = nicknamelessUserMentionRegex.exec(convertedContent)) !== null) {
    const userId = match[1];
    try {
      const member = await guild.members.fetch(userId);
      if (member) {
        convertedContent = convertedContent.replace(match[0], `<message_for_user: ${member.user.username}>`);
      }
    } catch (error) {
      console.error(`[Mention] Failed to fetch user ${userId}:`, error.message);
    }
  }
  
  return convertedContent;
}

/**
 * 一時チャンネルのチェックと削除、自動応答
 */
async function checkAndDeleteTempChannels() {
  const now = Date.now();
  const keysToDelete = [];

  for (const [key, channelData] of Object.entries(tempChannels)) {
    const [guildId, channelId] = key.split('-');
    const deleteDelay = getDeleteDelayMs(channelData.deleteAfter);
    const deleteTime = channelData.lastActivity + deleteDelay;
    const timeUntilDelete = deleteTime - now;

    // チャンネルの存在確認
    const guild = client.guilds.cache.get(guildId);
    if (!guild) {
      console.log(`[TempChannel] Guild ${guildId} not found, removing from tracking`);
      keysToDelete.push(key);
      continue;
    }

    const channel = guild.channels.cache.get(channelId);
    if (!channel) {
      console.log(`[TempChannel] Channel ${channelId} not found, removing from tracking`);
      keysToDelete.push(key);
      continue;
    }

    // チャンネル削除判定
    if (now >= deleteTime) {
      try {
        await channel.delete('Temporary channel expired');
        console.log(`[TempChannel] Deleted expired channel: ${channelData.name} (${channelId}) in guild ${guildId}`);
        keysToDelete.push(key);
      } catch (error) {
        console.error(`[TempChannel] Error deleting channel ${channelId}:`, error);
        keysToDelete.push(key);
      }
      continue;
    }

    // 自動応答の条件チェック（テキストチャンネルのみ）
    if (channel.type === ChannelType.GuildText) {
      const timeSinceLastNonBotActivity = now - (channelData.lastNonBotActivity || channelData.lastActivity);
      
      // 条件:
      // 1. チャンネル消滅まで30分以上の猶予がある
      // 2. 10分以上Bot以外が書き込み/入退室していない
      if (
        timeUntilDelete > CONFIG.AUTO_REPLY_MIN_TIME_BEFORE_DELETE &&
        timeSinceLastNonBotActivity > CONFIG.AUTO_REPLY_MIN_IDLE_TIME
      ) {
        try {
          // スレッドの最後のメッセージを確認
          const threadId = getGroupThreadId(guildId, channelId);
          const token = await getBotJWTToken(guildId);
          
          const threadResponse = await fetch(`${CONFIG.API_BASE_URL}/api/threads/${threadId}`, {
            headers: { 'Authorization': `Bearer ${token}` }
          });

          if (threadResponse.ok) {
            const thread = await threadResponse.json();
            
            // 最後のメッセージがBot以外のユーザーによるものか確認
            if (thread.messages && thread.messages.length > 0) {
              const lastMessage = thread.messages[thread.messages.length - 1];
              
              // 最後のメッセージがBotでない場合、自動応答を生成
              if (lastMessage.role === 'user' && !lastMessage.metadata?.isBot) {
                console.log(`[AutoReply] Generating response for channel ${channelId} (${channelData.name})`);
                
                // 応答を生成（通常のメッセージ送信APIを使用）
                const response = await sendMessage(CONFIG.BOT_USER_ID, guildId, threadId, '（会話を続けます）', false);

                // Discordチャンネルに送信
                await sendLongMessage(channel, response.assistantMessage.content);
                
                // 最終アクティビティを更新（Botの書き込みとして）
                await updateChannelActivity(guildId, channelId, true);
                
                console.log(`[AutoReply] Response sent to channel ${channelId}`);
              }
            }
          }
        } catch (error) {
          console.error(`[AutoReply] Error generating response for channel ${channelId}:`, error);
        }
      }
    }
  }

  // 削除されたチャンネルをトラッキングから除外
  for (const key of keysToDelete) {
    delete tempChannels[key];
  }

  if (keysToDelete.length > 0) {
    await saveTempChannels();
  }
}

/**
 * Bot用JWTトークンを取得（キャッシュあり）
 * @param {string} guildId - Discord Guild ID
 * @returns {Promise<string>} JWTトークン
 */
async function getBotJWTToken(guildId) {
  // キャッシュチェック
  const cached = tokenCache.get(guildId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.token;
  }

  // 新しいトークンを取得
  try {
    const guildToken = generateGuildAuthToken(guildId);
    
    const response = await fetch(`${CONFIG.API_BASE_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        botUserId: CONFIG.BOT_USER_ID,
        guildId: guildId,
        guildToken: guildToken
      })
    });
    console.log(`[Auth] response received for guild ${guildId}`, response.ok);
    console.log(`[Auth] response received for guild ${guildId}`, response.json);

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Bot authentication failed');
    }

    const data = await response.json();
    
    // キャッシュに保存（有効期限の90%で更新）
    const expiresIn = data.expiresIn || 86400; // デフォルト24時間
    const expiresAt = Date.now() + (expiresIn * 900); // 90% of expiry time
    tokenCache.set(guildId, {
      token: data.token,
      expiresAt: expiresAt
    });

    if (CONFIG.DEBUG) {
      console.log(`[Auth] Bot JWT token obtained for guild ${guildId}`);
    }

    return data.token;
  } catch (error) {
    console.error(`[Auth] Failed to get bot JWT token for guild ${guildId}:`, error.message);
    throw error;
  }
}

/**
 * ユーザー用JWTトークンを取得
 * @param {string} userId - Discord User ID
 * @param {string} guildId - Discord Guild ID
 * @returns {Promise<string>} JWTトークン
 */
async function getUserJWTToken(userId, guildId) {
  const cacheKey = `user:${userId}:${guildId}`;
  const cached = tokenCache.get(cacheKey);

  if (cached && cached.expiresAt > Date.now()) {
    return cached.token;
  }

  try {
    const response = await fetch(`${CONFIG.API_BASE_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId: userId,
        groupId: guildId
      })
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'User authentication failed');
    }

    const data = await response.json();
    
    // キャッシュに保存（有効期限の90%で更新）
    // デフォルトで7日間と仮定
    const expiresIn = data.expiresIn || (7 * 24 * 60 * 60); // 7日間
    const expiresAt = Date.now() + (expiresIn * 900); // 90% of expiry time
    tokenCache.set(cacheKey, {
      token: data.token,
      expiresAt: expiresAt
    });

    return data.token;
  } catch (error) {
    console.error(`[Auth] Failed to get user JWT token for ${userId}:`, error.message);
    throw error;
  }
}

async function verifyGuildMembership(userId, guildId) {
  try {
    const guild = client.guilds.cache.get(guildId);
    if (!guild) return false;
    const member = await guild.members.fetch(userId).catch(() => null);
    return !!member;
  } catch {
    return false;
  }
}

async function apiRequest(endpoint, options = {}) {
  const url = `${CONFIG.API_BASE_URL}${endpoint}`;
  if (CONFIG.DEBUG) console.log(`[API] ${options.method || 'GET'} ${url}`);
  const response = await fetch(url, { ...options, headers: { 'Content-Type': 'application/json', ...options.headers } });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'API request failed');
  return data;
}

async function authenticatedRequest(endpoint, usrId, guildId = null, options = {}) {
  let token;
  if (guildId !== null && typeof guildId === 'string') {
    // エンドユーザーからのリクエストとしてJWTトークンを取得
    const userId = usrId;
    token = await getUserJWTToken(userId, guildId);
  }
  return apiRequest(endpoint, { 
    ...options, 
    headers: { 
      'Authorization': `Bearer ${token}`, 
      ...options.headers 
    } 
  });
}

async function authenticatedBotRequest(endpoint, guildId, options = {}) {
  const token = await getBotJWTToken(guildId);
  return apiRequest(endpoint, {
    ...options,
    headers: {
      'Authorization': `Bearer ${token}`,
      ...options.headers
    }
  });
}

async function getUserInfo(userId, guildId) {
  if (!(await verifyGuildMembership(userId, guildId))) return null;
  try {
    const data = await authenticatedRequest('/api/auth/me', userId, guildId);
    return data.user;
  } catch {
    return null;
  }
}

async function hasAuthority(userId, guildId, requiredAuthority) {
  const user = await getUserInfo(userId, guildId);
  return user?.authority === requiredAuthority;
}

async function createUser(targetUserId, guildId, authority, credit = CONFIG.BOT_DEFAULT_CREDIT) {
  // 注: creditは無料クレジット(remainingCredit)として設定されます
  return authenticatedBotRequest('/api/admin/users', guildId, {
    method: 'POST',
    body: JSON.stringify({ userId: targetUserId, groupId: guildId, authority, remainingCredit: credit })
  });
}

async function getThreads(userId, guildId) {
  const data = await authenticatedRequest('/api/threads', userId, guildId);
  return data.threads || [];
}

async function getOrCreateThread(userId, guildId, channelId) {
  const threads = await getThreads(userId, guildId);
  const existing = threads.find(t => t.title?.includes(channelId));
  if (existing) return existing.id;
  const newThread = await authenticatedRequest('/api/threads', userId, guildId, {
    method: 'POST',
    body: JSON.stringify({ title: `Discord Channel: ${channelId}`, systemPrompt: 'You are a helpful Discord bot assistant.' })
  });
  return newThread.id;
}

async function getOrCreateGroupThread(userId, guildId, channelId, channelName, guildName) {
  const threadId = getGroupThreadId(guildId, channelId);
  const token = await getBotJWTToken(guildId);
  
  // 既存スレッドの確認
  try {
    const checkResponse = await fetch(`${CONFIG.API_BASE_URL}/api/threads/${threadId}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (checkResponse.ok) {
      return threadId;
    }
  } catch (error) {
    // スレッドが存在しない場合は作成
  }
  
  // 新規グループスレッド作成
  await authenticatedBotRequest('/api/threads', guildId, {
    method: 'POST',
    body: JSON.stringify({
      title: `Group: ${channelName}`,
      systemPrompt: `あなたはDiscordのグループチャンネル「${channelName}」（サーバー: ${guildName}）でのアシスタントです。複数のユーザーと会話します。ユーザーのメッセージにはmetadataとしてuserName, displayNameなどが含まれています。`,
      model: CONFIG.DEFAULT_MODEL,
      threadId: threadId
    })
  });
  
  return threadId;
}

async function sendMessage(userId, guildId, threadId, content, saveUserMessage = true, model = undefined) {
  if (userId == CONFIG.BOT_USER_ID) {
    // bot としてリクエスト
    return authenticatedBotRequest(`/api/threads/${threadId}/messages`, guildId, {
      method: 'POST',
      body: JSON.stringify({ content, model, saveUserMessage })
    });
  } else {
    // user としてリクエスト
    return authenticatedRequest(`/api/threads/${threadId}/messages`, userId, guildId, {
      method: 'POST',
      body: JSON.stringify({ content, model, saveUserMessage })
    });
  }
}

async function sendMessageWithMetadata(userId, guildId, threadId, content, metadata, saveUserMessage = true, model = undefined) {
  if (userId == CONFIG.BOT_USER_ID) {
    // bot としてリクエスト
    return authenticatedBotRequest(`/api/threads/${threadId}/messages`, guildId, {
      method: 'POST',
      body: JSON.stringify({ content, metadata, model, saveUserMessage })
    });
  } else {
    // user としてリクエスト
    return authenticatedRequest(`/api/threads/${threadId}/messages`, userId, guildId, {
      method: 'POST',
      body: JSON.stringify({ content, metadata, model, saveUserMessage })
    });
  }
}

async function appendMessage(userId, guildId, threadId, content, metadata) {
  return authenticatedBotRequest(`/api/threads/${threadId}/messages/append`, guildId, {
    method: 'POST',
    body: JSON.stringify({
      role: 'user',
      content,
      metadata
    })
  });
}

async function updateThreadModelRequest(guildId, threadId, model) {
  const token = await getBotJWTToken(guildId);
  const response = await fetch(`${CONFIG.API_BASE_URL}/api/threads/${threadId}/model`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    },
    body: JSON.stringify({ model })
  });

  if (!response.ok) {
    let error;
    try {
      error = await response.json();
    } catch {
      error = {};
    }
    throw new Error(error.error || 'モデルの更新に失敗しました');
  }
}

async function updateThreadSystemPromptRequest(guildId, threadId, systemPrompt) {
  const token = await getBotJWTToken(guildId);
  const response = await fetch(`${CONFIG.API_BASE_URL}/api/threads/${threadId}/system-prompt`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    },
    body: JSON.stringify({ systemPrompt })
  });

  if (!response.ok) {
    let error;
    try {
      error = await response.json();
    } catch {
      error = {};
    }
    throw new Error(error.error || 'システムプロンプトの更新に失敗しました');
  }
}
function createErrorEmbed(message) {
  return new EmbedBuilder().setColor(0xFF0000).setTitle('❌ エラー').setDescription(message).setTimestamp();
}

function createSuccessEmbed(title, message) {
  return new EmbedBuilder().setColor(0x00FF00).setTitle(`✅ ${title}`).setDescription(message).setTimestamp();
}

function createInfoEmbed(title, message) {
  return new EmbedBuilder().setColor(0x0099FF).setTitle(`ℹ️ ${title}`).setDescription(message).setTimestamp();
}

async function sendLongMessage(channel, content) {
  if (content.length <= CONFIG.MAX_MESSAGE_LENGTH) {
    await channel.send(content);
    return;
  }
  const chunks = [];
  let remaining = content;
  while (remaining.length > 0) {
    if (remaining.length <= CONFIG.MAX_MESSAGE_LENGTH) {
      chunks.push(remaining);
      break;
    }
    let splitIndex = remaining.lastIndexOf('\n', CONFIG.MAX_MESSAGE_LENGTH);
    if (splitIndex === -1 || splitIndex < CONFIG.MAX_MESSAGE_LENGTH / 2) {
      splitIndex = remaining.lastIndexOf(' ', CONFIG.MAX_MESSAGE_LENGTH);
      if (splitIndex === -1) splitIndex = CONFIG.MAX_MESSAGE_LENGTH;
    }
    chunks.push(remaining.substring(0, splitIndex));
    remaining = remaining.substring(splitIndex).trim();
  }
  for (const chunk of chunks) await channel.send(chunk);
}

/**
 * Slash commandsを動的に生成
 * @param {Array} modelChoices - モデルの選択肢配列
 */
function buildCommands(modelChoices) {
  return [
    new SlashCommandBuilder().setName('add-user').setDescription('新しいユーザーを追加（Admin専用）')
      .addUserOption(o => o.setName('user').setDescription('追加するユーザー').setRequired(true))
      .addStringOption(o => o.setName('authority').setDescription('権限レベル').setRequired(true).addChoices({ name: 'VIP', value: Authority.VIP }, { name: 'User', value: Authority.USER }))
      .addIntegerOption(o => o.setName('credit').setDescription('初期無料クレジット量').setRequired(false).setMinValue(0)).toJSON(),
    new SlashCommandBuilder().setName('request-access-user').setDescription('ユーザーからBotへのアクセス権限をリクエスト').toJSON(),
    new SlashCommandBuilder().setName('my-info').setDescription('自分のアカウント情報を表示').toJSON(),
    new SlashCommandBuilder().setName('request-access-guild').setDescription('このサーバーからBotへのアクセス権限をリクエスト（Admin専用）').toJSON(),
    new SlashCommandBuilder()
      .setName('create-temp-channel')
      .setDescription('一時的なチャンネルを作成します')
      .addStringOption(o => o.setName('category').setDescription('カテゴリ名').setRequired(true))
      .addStringOption(o => o.setName('channel-name').setDescription('チャンネル名').setRequired(true))
      .addStringOption(o => o.setName('channel-type').setDescription('チャンネルタイプ').setRequired(true)
        .addChoices(
          { name: 'テキストチャンネル', value: 'text' },
          { name: 'ボイスチャンネル', value: 'voice' }
        ))
      .addStringOption(o => o.setName('delete-after').setDescription('削除タイミング').setRequired(true)
        .addChoices(
          { name: '最終更新/入室から10分後', value: '10min' },
          { name: '最終更新/入室から1時間後', value: '1hour' },
          { name: '最終更新/入室から1日後', value: '1day' },
          { name: '最終更新/入室から3日後', value: '3days' },
          { name: '最終更新/入室から14日後', value: '14days' }
        ))
      .toJSON(),
    new SlashCommandBuilder()
      .setName('list-temp-channels')
      .setDescription('サーバー内の一時的なチャンネルの一覧を表示します')
      .toJSON(),
    new SlashCommandBuilder()
      .setName('update-channel-model')
      .setDescription('一時的なチャンネルのモデルを変更します')
      .addStringOption(o => {
        const option = o.setName('model').setDescription('使用するモデル').setRequired(true);
        // 最大25個までの選択肢を追加（Discordの制限）
        const choices = modelChoices.slice(0, 25);
        if (choices.length > 0) {
          option.addChoices(...choices);
        }
        return option;
      })
      .toJSON(),
    new SlashCommandBuilder()
      .setName('update-channel-system-prompt')
      .setDescription('一時的なチャンネルのシステムプロンプトを変更します')
      .addStringOption(o => o.setName('system_prompt').setDescription('新しいシステムプロンプト').setRequired(true))
      .toJSON(),
    new SlashCommandBuilder()
      .setName('one-shot')
      .setDescription('単発生成モードを開始します（リプライで会話・3日間有効）')
      .addStringOption(o => {
        const option = o.setName('model').setDescription('使用するモデル').setRequired(true);
        const choices = modelChoices.slice(0, 25);
        if (choices.length > 0) {
          option.addChoices(...choices);
        }
        return option;
      })
      .addStringOption(o => o.setName('system_prompt').setDescription('システムプロンプト（オプション）').setRequired(false))
      .toJSON()
  ];
}

async function handleAddUser(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const guildId = interaction.guildId;
    const adminUserId = interaction.user.id;
    const targetUser = interaction.options.getUser('user');
    const authority = interaction.options.getString('authority');
    const credit = interaction.options.getInteger('credit') || CONFIG.BOT_DEFAULT_CREDIT;
    if (!isGuildEnabled(guildId)) {
      await interaction.editReply({ embeds: [createErrorEmbed('このサーバーではBotが有効化されていません。\n`/request-access-guild` コマンドでアクセスをリクエストしてください。')] });
      return;
    }
    if (!(await hasAuthority(adminUserId, guildId, Authority.ADMIN))) {
      await interaction.editReply({ embeds: [createErrorEmbed('このコマンドを使用する権限がありません。')] });
      return;
    }
    if (!(await verifyGuildMembership(targetUser.id, guildId))) {
      await interaction.editReply({ embeds: [createErrorEmbed('指定されたユーザーはこのサーバーのメンバーではありません。')] });
      return;
    }
    if (await getUserInfo(targetUser.id, guildId)) {
      await interaction.editReply({ embeds: [createErrorEmbed('このユーザーは既に登録されています。')] });
      return;
    }
    await createUser(targetUser.id, guildId, authority, credit);
    await interaction.editReply({ embeds: [createSuccessEmbed('ユーザーを追加しました', `**ユーザー:** ${targetUser.tag}\n**権限:** ${authority}\n**無料クレジット:** ${credit.toLocaleString()} credits`)] });
    console.log(`[Command] User ${targetUser.id} added by ${adminUserId} with authority ${authority} in guild ${guildId}`);
  } catch (error) {
    console.error('[Command Error] /add-user:', error);
    await interaction.editReply({ embeds: [createErrorEmbed(`エラーが発生しました: ${error.message}`)] });
  }
}

async function handleRequestAccessUser(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const guildId = interaction.guild?.id;
    const userId = interaction.user.id;
    if (!isGuildEnabled(guildId)) {
      await interaction.editReply({ embeds: [createErrorEmbed('このサーバーではBotが有効化されていません。\n`/request-access-guild` コマンドでアクセスをリクエストしてください。')] });
      return;
    }
    const existingUser = await getUserInfo(userId, guildId);
    if (existingUser) {
      const messages = {
        [Authority.PENDING]: '既にアクセスリクエストを送信済みです。',
        [Authority.USER]: '既にアクセス権限を持っています。',
        [Authority.VIP]: '既にアクセス権限を持っています。',
        [Authority.ADMIN]: 'あなたは管理者権限を持っています。',
        [Authority.STOPPED]: 'アカウントが停止されています。',
        [Authority.BANNED]: 'アカウントがBANされています。'
      };
      await interaction.editReply({ embeds: [createInfoEmbed('アクセスリクエスト', messages[existingUser.authority] || '不明なステータスです。')] });
      return;
    }
    await createUser(userId, guildId, Authority.PENDING, 0);
    await interaction.editReply({ embeds: [createSuccessEmbed('アクセスリクエストを送信しました', '管理者が承認するまでお待ちください。')] });
    console.log(`[Command] User access request from user ${userId} in guild ${guildId}`);
  } catch (error) {
    console.error('[Command Error] /request-access-user:', error);
    await interaction.editReply({ embeds: [createErrorEmbed(`エラーが発生しました: ${error.message}`)] });
  }
}

async function handleRequestAccessGuild(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const guildId = interaction.guild?.id;
    const userId = interaction.user.id;
    
    // guildId がない場合はサーバーで実行されていないので拒否
    if (!guildId) {
      await interaction.editReply({ embeds: [createErrorEmbed('このコマンドはサーバーで実行してください。')] });
      return;
    }

    const guild = interaction.guild;

    // 有効化済みならメッセージのみ返信
    if (isGuildEnabled(guildId)) {
      await interaction.editReply({ embeds: [createInfoEmbed('有効化済', 'このサーバーではBotが有効化済です。')] });
      return;
    }
    
    // リクエストを保存
    const saved = saveGuildRequest(guild.id, guild.name, {
      memberCount: guild.memberCount,
      ownerId: guild.ownerId,
      addedAt: new Date().toISOString()
    });
    
    if (saved) {
      console.log(`   ✅ Guild request created from slash command and saved`);
      console.log(`   Use CLI to approve: node guild-manager-cli.js`);
    }
    console.log('');

    await interaction.editReply({ embeds: [createSuccessEmbed('アクセスリクエストを送信しました', '管理者が承認するまでお待ちください。')] });
    console.log(`[Command] Guild access request from user ${userId} in guild ${guildId}`);
  } catch (error) {
    console.error('[Command Error] /request-access-guild:', error);
    await interaction.editReply({ embeds: [createErrorEmbed(`エラーが発生しました: ${error.message}`)] });
  }
}

async function handleMyInfo(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const guildId = interaction.guild?.id;
    const userId = interaction.user.id;
    console.log(`[Command] User ${userId} requested my info in guild ${guildId}`);
    
    const user = await getUserInfo(userId, guildId);
    if (!user) {
      await interaction.editReply({ embeds: [createInfoEmbed('アカウント情報', 'まだアカウントが登録されていません。\n`/request-access-user` コマンドでアクセスをリクエストしてください。')] });
      return;
    }
    const statusEmoji = { [Authority.ADMIN]: '👑', [Authority.VIP]: '⭐', [Authority.USER]: '👤', [Authority.PENDING]: '⏳', [Authority.STOPPED]: '⏸️', [Authority.BANNED]: '🚫' };
    
    const paidCredit = user.paid_credit || 0;
    const freeCredit = user.remaining_credit || 0;
    const totalCredit = paidCredit + freeCredit;
    
    const embed = new EmbedBuilder().setColor(0x0099FF).setTitle('📊 アカウント情報')
      .addFields(
        { name: 'ユーザーID', value: user.user_id, inline: true },
        { name: '権限', value: `${statusEmoji[user.authority] || '❓'} ${user.authority}`, inline: true },
        { name: '状態', value: user.isActive ? '✅ 有効' : '❌ 無効', inline: true },
        { name: '💳 有料クレジット', value: `${paidCredit.toLocaleString()} credits`, inline: true },
        { name: '🎁 無料クレジット', value: `${freeCredit.toLocaleString()} credits`, inline: true },
        { name: '📊 合計クレジット', value: `${totalCredit.toLocaleString()} credits`, inline: true },
        { name: '使用クレジット', value: `${user.used_credit.toLocaleString()} credits`, inline: false },
        { name: '登録日', value: new Date(user.created_at).toLocaleString('ja-JP'), inline: false }
      ).setTimestamp();
    
    if (user.last_login) embed.addFields({ name: '最終ログイン', value: new Date(user.last_login).toLocaleString('ja-JP'), inline: false });
    
    // 負債状態の場合は警告を追加
    if (paidCredit === 0 && freeCredit < 0) {
      embed.setColor(0xFF0000);
      embed.setFooter({ text: '⚠️ クレジットが負債状態です。クレジットを購入してください。' });
    } else if (totalCredit < 100000) {
      embed.setColor(0xFFAA00);
      embed.setFooter({ text: '⚠️ クレジット残高が少なくなっています。' });
    }
    
    await interaction.editReply({ embeds: [embed] });
  } catch (error) {
    console.error('[Command Error] /my-info:', error);
    await interaction.editReply({ embeds: [createErrorEmbed(`エラーが発生しました: ${error.message}`)] });
  }
}

async function handleCreateTempChannel(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const guildId = interaction.guild?.id;
    const userId = interaction.user.id;
    
    if (!guildId) {
      await interaction.editReply({ embeds: [createErrorEmbed('このコマンドはサーバーで実行してください。')] });
      return;
    }

    const categoryName = interaction.options.getString('category');
    const channelName = interaction.options.getString('channel-name');
    const channelType = interaction.options.getString('channel-type');
    const deleteAfter = interaction.options.getString('delete-after');

    const guild = interaction.guild;

    // 権限チェック（チャンネル管理権限が必要）
    const member = await guild.members.fetch(userId);
    if (!member.permissions.has(PermissionFlagsBits.ManageChannels)) {
      await interaction.editReply({ embeds: [createErrorEmbed('このコマンドを使用するには「チャンネルの管理」権限が必要です。')] });
      return;
    }

    // カテゴリを探す、または作成
    let category = guild.channels.cache.find(
      c => c.type === ChannelType.GuildCategory && c.name === categoryName
    );

    if (!category) {
      try {
        category = await guild.channels.create({
          name: categoryName,
          type: ChannelType.GuildCategory
        });
        console.log(`[TempChannel] Created category: ${categoryName} (${category.id})`);
      } catch (error) {
        await interaction.editReply({ embeds: [createErrorEmbed(`カテゴリの作成に失敗しました: ${error.message}`)] });
        return;
      }
    }

    // 既存のチャンネルをチェック
    const existingChannel = guild.channels.cache.find(
      c => c.parentId === category.id && c.name === channelName
    );

    if (existingChannel) {
      await interaction.editReply({ embeds: [createErrorEmbed(`チャンネル「${channelName}」は既に存在します。`)] });
      return;
    }

    // チャンネルを作成
    const channelTypeMap = {
      'text': ChannelType.GuildText,
      'voice': ChannelType.GuildVoice
    };

    let newChannel;
    try {
      newChannel = await guild.channels.create({
        name: channelName,
        type: channelTypeMap[channelType],
        parent: category.id
      });
      console.log(`[TempChannel] Created ${channelType} channel: ${channelName} (${newChannel.id})`);
    } catch (error) {
      await interaction.editReply({ embeds: [createErrorEmbed(`チャンネルの作成に失敗しました: ${error.message}`)] });
      return;
    }

    // 一時チャンネルとして登録
    await registerTempChannel(guildId, guild.name, newChannel.id, {
      name: channelName,
      type: channelType,
      categoryId: category.id,
      categoryName: categoryName,
      deleteAfter: deleteAfter,
      createdBy: userId
    });

    const deleteTimeDesc = {
      '10min': '10分',
      '1hour': '1時間',
      '1day': '1日',
      '3days': '3日',
      '14days': '14日'
    };

    const embed = new EmbedBuilder()
      .setColor(0x00FF00)
      .setTitle('✅ 一時チャンネルを作成しました')
      .setDescription(`チャンネル: <#${newChannel.id}>`)
      .addFields(
        { name: 'カテゴリ', value: categoryName, inline: true },
        { name: 'チャンネル名', value: channelName, inline: true },
        { name: 'タイプ', value: channelType === 'text' ? 'テキスト' : 'ボイス', inline: true },
        { name: '削除タイミング', value: `最終アクティビティから${deleteTimeDesc[deleteAfter]}後`, inline: false }
      )
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  } catch (error) {
    console.error('[Command Error] /create-temp-channel:', error);
    await interaction.editReply({ embeds: [createErrorEmbed(`エラーが発生しました: ${error.message}`)] });
  }
}

async function handleListTempChannels(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const guildId = interaction.guild?.id;
    
    if (!guildId) {
      await interaction.editReply({ embeds: [createErrorEmbed('このコマンドはサーバーで実行してください。')] });
      return;
    }

    // このサーバーの一時チャンネルを取得
    const guildTempChannels = Object.entries(tempChannels)
      .filter(([key]) => key.startsWith(`${guildId}-`))
      .map(([key, data]) => {
        const channelId = key.split('-')[1];
        return { channelId, ...data };
      });

    if (guildTempChannels.length === 0) {
      await interaction.editReply({ 
        embeds: [createInfoEmbed('一時チャンネル一覧', 'このサーバーには一時チャンネルがありません。')] 
      });
      return;
    }

    const deleteTimeDesc = {
      '10min': '10分',
      '1hour': '1時間',
      '1day': '1日',
      '3days': '3日',
      '14days': '14日'
    };

    // 一覧を作成
    const embed = new EmbedBuilder()
      .setColor(0x0099FF)
      .setTitle('📋 一時チャンネル一覧')
      .setDescription(`このサーバーには ${guildTempChannels.length} 個の一時チャンネルがあります。`)
      .setTimestamp();

    for (const channel of guildTempChannels.slice(0, 25)) { // Discord Embedの制限: 25 fields
      const deleteDelay = getDeleteDelayMs(channel.deleteAfter);
      const deleteTime = channel.lastActivity + deleteDelay;
      const timeRemaining = deleteTime - Date.now();
      const minutesRemaining = Math.floor(timeRemaining / (60 * 1000));
      const hoursRemaining = Math.floor(minutesRemaining / 60);
      
      let timeRemainingStr;
      if (hoursRemaining > 24) {
        const daysRemaining = Math.floor(hoursRemaining / 24);
        timeRemainingStr = `約${daysRemaining}日`;
      } else if (hoursRemaining > 0) {
        timeRemainingStr = `約${hoursRemaining}時間`;
      } else {
        timeRemainingStr = `約${minutesRemaining}分`;
      }

      embed.addFields({
        name: `${channel.type === 'text' ? '💬' : '🔊'} ${channel.name}`,
        value: 
          `チャンネル: <#${channel.channelId}>\n` +
          `カテゴリ: ${channel.categoryName}\n` +
          `削除まで: ${timeRemainingStr}\n` +
          `スレッドID: \`${channel.threadId || 'N/A'}\``,
        inline: false
      });
    }

    if (guildTempChannels.length > 25) {
      embed.setFooter({ text: `他 ${guildTempChannels.length - 25} チャンネルは表示されていません` });
    }

    await interaction.editReply({ embeds: [embed] });
  } catch (error) {
    console.error('[Command Error] /list-temp-channels:', error);
    await interaction.editReply({ embeds: [createErrorEmbed(`エラーが発生しました: ${error.message}`)] });
  }
}

async function handleUpdateChannelModel(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const guildId = interaction.guild?.id;
    const userId = interaction.user.id;
    const model = interaction.options.getString('model');
    
    if (!guildId) {
      await interaction.editReply({ embeds: [createErrorEmbed('このコマンドはサーバーで実行してください。')] });
      return;
    }

    // 権限チェック（チャンネル管理権限が必要）
    const member = await interaction.guild.members.fetch(userId);
    if (!member.permissions.has(PermissionFlagsBits.ManageChannels)) {
      await interaction.editReply({ embeds: [createErrorEmbed('このコマンドを使用するには「チャンネルの管理」権限が必要です。')] });
      return;
    }

    // このサーバーの一時チャンネルを取得
    const guildTempChannels = getGuildTempChannels(guildId);
    
    if (guildTempChannels.length === 0) {
      await interaction.editReply({ embeds: [createErrorEmbed('このサーバーには一時チャンネルがありません。')] });
      return;
    }

    // セレクトメニューを作成
    const requestId = createPendingSelection({
      type: 'model',
      guildId,
      userId,
      value: model
    });

    const row = buildTempChannelSelectRow(guildTempChannels, requestId, 'モデルを変更するチャンネルを選択');
    
    if (!row) {
      await interaction.editReply({ embeds: [createErrorEmbed('チャンネル選択メニューの作成に失敗しました。')] });
      return;
    }

    const embed = new EmbedBuilder()
      .setColor(0x0099FF)
      .setTitle('🔧 チャンネルのモデルを変更')
      .setDescription(`モデルを変更する一時チャンネルを選択してください。\n新しいモデル: **${model}**`)
      .setFooter({ text: 'この選択は10分間有効です' })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed], components: [row] });
  } catch (error) {
    console.error('[Command Error] /update-channel-model:', error);
    await interaction.editReply({ embeds: [createErrorEmbed(`エラーが発生しました: ${error.message}`)] });
  }
}

async function handleUpdateChannelSystemPrompt(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const guildId = interaction.guild?.id;
    const userId = interaction.user.id;
    const systemPrompt = interaction.options.getString('system_prompt');
    
    if (!guildId) {
      await interaction.editReply({ embeds: [createErrorEmbed('このコマンドはサーバーで実行してください。')] });
      return;
    }

    // 権限チェック（チャンネル管理権限が必要）
    const member = await interaction.guild.members.fetch(userId);
    if (!member.permissions.has(PermissionFlagsBits.ManageChannels)) {
      await interaction.editReply({ embeds: [createErrorEmbed('このコマンドを使用するには「チャンネルの管理」権限が必要です。')] });
      return;
    }

    // このサーバーの一時チャンネルを取得
    const guildTempChannels = getGuildTempChannels(guildId);
    
    if (guildTempChannels.length === 0) {
      await interaction.editReply({ embeds: [createErrorEmbed('このサーバーには一時チャンネルがありません。')] });
      return;
    }

    // セレクトメニューを作成
    const requestId = createPendingSelection({
      type: 'system_prompt',
      guildId,
      userId,
      value: systemPrompt
    });

    const row = buildTempChannelSelectRow(guildTempChannels, requestId, 'システムプロンプトを変更するチャンネルを選択');
    
    if (!row) {
      await interaction.editReply({ embeds: [createErrorEmbed('チャンネル選択メニューの作成に失敗しました。')] });
      return;
    }

    const promptPreview = systemPrompt.length > 100 
      ? systemPrompt.substring(0, 100) + '...' 
      : systemPrompt;

    const embed = new EmbedBuilder()
      .setColor(0x0099FF)
      .setTitle('🔧 チャンネルのシステムプロンプトを変更')
      .setDescription(`システムプロンプトを変更する一時チャンネルを選択してください。\n新しいプロンプト: ${promptPreview}`)
      .setFooter({ text: 'この選択は10分間有効です' })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed], components: [row] });
  } catch (error) {
    console.error('[Command Error] /update-channel-system-prompt:', error);
    await interaction.editReply({ embeds: [createErrorEmbed(`エラーが発生しました: ${error.message}`)] });
  }
}

async function handleOneShot(interaction) {
  await interaction.deferReply();
  try {
    const guildId = interaction.guild?.id || 'dm';
    const userId = interaction.user.id;
    const model = interaction.options.getString('model');
    const systemPrompt = interaction.options.getString('system_prompt') || 'あなたは親切なアシスタントです。';
    
    if (guildId !== 'dm' && !isGuildEnabled(guildId)) {
      await interaction.editReply({ embeds: [createErrorEmbed('このサーバーではBotが有効化されていません。')] });
      return;
    }

    // ユーザー情報確認
    const user = await getUserInfo(userId, guildId);
    if (!user) {
      await interaction.editReply({ embeds: [createInfoEmbed('アカウント未登録', 'Botを使用するには、まず `/request-access-user` コマンドでアクセスをリクエストしてください。')] });
      return;
    }
    
    if (user.authority === Authority.PENDING) {
      await interaction.editReply({ embeds: [createInfoEmbed('承認待ち', 'アクセスリクエストは送信済みです。管理者の承認をお待ちください。')] });
      return;
    }
    
    if (user.authority === Authority.STOPPED || user.authority === Authority.BANNED) {
      await interaction.editReply({ embeds: [createErrorEmbed('アカウントが停止またはBANされています。')] });
      return;
    }

    // 定型文を返す
    const expiryDate = new Date(Date.now() + (3 * 24 * 60 * 60 * 1000));
    const embed = new EmbedBuilder()
      .setColor(0x0099FF)
      .setTitle('🤖 単発生成モード')
      .setDescription(
        'このメッセージにリプライして会話を開始してください。\n' +
        `⏰ **有効期限**: ${expiryDate.toLocaleString('ja-JP')} まで（3日間）`
      )
      .addFields(
        { name: 'モデル', value: model, inline: true },
        { name: 'システムプロンプト', value: systemPrompt.length > 100 ? systemPrompt.substring(0, 100) + '...' : systemPrompt, inline: false }
      )
      .setFooter({ text: 'リプライを続けることで会話履歴が保持されます（3日後に自動削除）' })
      .setTimestamp();

    const reply = await interaction.editReply({ embeds: [embed] });

    // 会話情報を保存
    oneShotConversations[reply.id] = {
      userId,
      guildId,
      model,
      systemPrompt,
      createdAt: Date.now(),
      parentMessageId: null // これは初回メッセージなので親はなし
    };
    await saveOneShotConversations();

    console.log(`[OneShot] Started conversation: ${reply.id} by user ${userId}`);
  } catch (error) {
    console.error('[Command Error] /one-shot:', error);
    await interaction.editReply({ embeds: [createErrorEmbed(`エラーが発生しました: ${error.message}`)] });
  }
}

// セレクトメニューのインタラクション処理を追加
client.on('interactionCreate', async interaction => {
  // セレクトメニューの処理
  if (interaction.isStringSelectMenu()) {
    const [customId, requestId] = interaction.customId.split(':');
    
    if (customId === TEMP_CHANNEL_SELECT_CUSTOM_ID) {
      await interaction.deferUpdate();
      
      try {
        const pendingSelection = pendingChannelSelections.get(requestId);
        
        if (!pendingSelection) {
          await interaction.followUp({ 
            embeds: [createErrorEmbed('この選択は期限切れです。コマンドを再度実行してください。')], 
            flags: MessageFlags.Ephemeral 
          });
          return;
        }

        // 権限確認
        if (pendingSelection.userId !== interaction.user.id) {
          await interaction.followUp({ 
            embeds: [createErrorEmbed('このメニューを操作する権限がありません。')], 
            flags: MessageFlags.Ephemeral 
          });
          return;
        }

        const selectedChannelId = interaction.values[0];
        const key = `${pendingSelection.guildId}-${selectedChannelId}`;
        const channelData = tempChannels[key];
        
        if (!channelData) {
          await interaction.followUp({ 
            embeds: [createErrorEmbed('選択されたチャンネルは一時チャンネルとして登録されていません。')], 
            flags: MessageFlags.Ephemeral 
          });
          return;
        }

        const threadId = channelData.threadId;
        if (!threadId) {
          await interaction.followUp({ 
            embeds: [createErrorEmbed('このチャンネルにはスレッドIDが設定されていません。')], 
            flags: MessageFlags.Ephemeral 
          });
          return;
        }

        // タイプに応じて処理
        if (pendingSelection.type === 'model') {
          await updateThreadModelRequest(pendingSelection.guildId, threadId, pendingSelection.value);
          
          await interaction.followUp({ 
            embeds: [createSuccessEmbed(
              'モデルを更新しました',
              `チャンネル: <#${selectedChannelId}>\n新しいモデル: **${pendingSelection.value}**`
            )], 
            flags: MessageFlags.Ephemeral 
          });

          console.log(`[Command] Updated model for channel ${selectedChannelId} to ${pendingSelection.value}`);
        } else if (pendingSelection.type === 'system_prompt') {
          await updateThreadSystemPromptRequest(pendingSelection.guildId, threadId, pendingSelection.value);
          
          const promptPreview = pendingSelection.value.length > 100 
            ? pendingSelection.value.substring(0, 100) + '...' 
            : pendingSelection.value;

          await interaction.followUp({ 
            embeds: [createSuccessEmbed(
              'システムプロンプトを更新しました',
              `チャンネル: <#${selectedChannelId}>\n新しいプロンプト: ${promptPreview}`
            )], 
            flags: MessageFlags.Ephemeral 
          });

          console.log(`[Command] Updated system prompt for channel ${selectedChannelId}`);
        }

        // 使用済みの選択を削除
        pendingChannelSelections.delete(requestId);

        // メッセージのコンポーネントを削除
        await interaction.editReply({ components: [] });

      } catch (error) {
        console.error('[SelectMenu Error]:', error);
        await interaction.followUp({ 
          embeds: [createErrorEmbed(`エラーが発生しました: ${error.message}`)], 
          flags: MessageFlags.Ephemeral 
        });
      }
    }
  }

  // スラッシュコマンドの処理
  if (!interaction.isChatInputCommand()) return;
  try {
    switch (interaction.commandName) {
      case 'add-user': await handleAddUser(interaction); break;
      case 'request-access-user': await handleRequestAccessUser(interaction); break;
      case 'my-info': await handleMyInfo(interaction); break;
      case 'request-access-guild': await handleRequestAccessGuild(interaction); break;
      case 'create-temp-channel': await handleCreateTempChannel(interaction); break;
      case 'list-temp-channels': await handleListTempChannels(interaction); break;
      case 'update-channel-model': await handleUpdateChannelModel(interaction); break;
      case 'update-channel-system-prompt': await handleUpdateChannelSystemPrompt(interaction); break;
      case 'one-shot': await handleOneShot(interaction); break;
      default: await interaction.reply({ content: '不明なコマンドです。', flags: MessageFlags.Ephemeral });
    }
  } catch (error) {
    console.error('[Interaction Error]:', error);
    const errorResponse = { embeds: [createErrorEmbed('コマンドの実行中にエラーが発生しました。')], flags: MessageFlags.Ephemeral };
    if (interaction.deferred) await interaction.editReply(errorResponse); else await interaction.reply(errorResponse);
  }
});

// メッセージイベント - テキストチャンネルのアクティビティを追跡とグループチャンネル処理
client.on('messageCreate', async (message) => {
  // 自分自身のbotのメッセージは無視（二重追加を防ぐ）
  if (message.author.id === client.user.id) return;
  
  // 単発生成モードのリプライ処理
  if (message.reference && message.reference.messageId) {
    const referencedMessageId = message.reference.messageId;
    
    // リプライ先が単発生成モードの会話の一部かチェック
    if (oneShotConversations[referencedMessageId]) {
      try {
        const conversationData = oneShotConversations[referencedMessageId];
        const userId = message.author.id;
        const guildId = message.guild?.id || 'dm';
        
        // ユーザー情報確認
        const user = await getUserInfo(userId, guildId);
        if (!user || user.authority === Authority.PENDING || user.authority === Authority.STOPPED || user.authority === Authority.BANNED) {
          return; // 権限がない場合は無視
        }
        
        // クレジットチェック
        if (user.authority !== Authority.ADMIN && user.authority !== Authority.VIP) {
          const totalCredit = (user.paid_credit || 0) + (user.remaining_credit || 0);
          if (totalCredit < 0) {
            await message.reply({ embeds: [createErrorEmbed('クレジット残高が不足しています。')] });
            return;
          }
        }
        
        // リプライチェーンを遡って会話履歴を構築
        const messages = [];
        let currentMessage = message;
        const visitedMessages = new Set(); // 無限ループ防止
        
        // 最新のユーザーメッセージを追加
        messages.unshift({
          role: 'user',
          content: message.content
        });
        
        // リプライチェーンを遡る
        while (currentMessage.reference && currentMessage.reference.messageId) {
          const refId = currentMessage.reference.messageId;
          
          if (visitedMessages.has(refId)) {
            break; // 無限ループ防止
          }
          visitedMessages.add(refId);
          
          try {
            const refMessage = await message.channel.messages.fetch(refId);
            
            // 初回の定型文メッセージはスキップ
            if (refMessage.embeds && refMessage.embeds.length > 0 && 
                refMessage.embeds[0].title === '🤖 単発生成モード') {
              break;
            }
            
            // メッセージをhistoryに追加（逆順なので先頭に追加）
            if (refMessage.author.id === client.user.id) {
              messages.unshift({
                role: 'assistant',
                content: refMessage.content
              });
            } else {
              messages.unshift({
                role: 'user',
                content: refMessage.content
              });
            }
            
            currentMessage = refMessage;
          } catch (error) {
            console.error(`[OneShot] Failed to fetch message ${refId}:`, error);
            break;
          }
        }
        
        // typing表示
        await message.channel.sendTyping();
        
        // AIにリクエスト送信（直接OpenAI APIを使用）
        console.log(`[OneShot] Processing conversation with ${messages.length} messages`);
        
        // ユーザーのJWTトークンを取得してAPIリクエスト
        const token = await getUserJWTToken(userId, guildId);
        
        // 一時的なスレッドを作成してメッセージを送信
        const tempThreadResponse = await fetch(`${CONFIG.API_BASE_URL}/api/threads`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
          },
          body: JSON.stringify({
            title: `OneShot-${Date.now()}`,
            systemPrompt: conversationData.systemPrompt,
            model: conversationData.model
          })
        });
        
        if (!tempThreadResponse.ok) {
          throw new Error('一時スレッドの作成に失敗しました');
        }
        
        const tempThread = await tempThreadResponse.json();
        const tempThreadId = tempThread.id;
        
        // メッセージ履歴を追加（最後のメッセージ以外）
        for (let i = 0; i < messages.length - 1; i++) {
          const msg = messages[i];
          await fetch(`${CONFIG.API_BASE_URL}/api/threads/${tempThreadId}/messages/append`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({
              role: msg.role,
              content: msg.content
            })
          });
        }
        
        // 最後のメッセージを送信してレスポンスを取得
        const finalMessageResponse = await fetch(`${CONFIG.API_BASE_URL}/api/threads/${tempThreadId}/messages`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
          },
          body: JSON.stringify({
            content: messages[messages.length - 1].content,
            model: conversationData.model
          })
        });
        
        if (!finalMessageResponse.ok) {
          const error = await finalMessageResponse.json();
          throw new Error(error.error || 'AI応答の生成に失敗しました');
        }
        
        const finalMessageData = await finalMessageResponse.json();
        const assistantMessage = finalMessageData.assistantMessage.content;
        
        // 応答を送信
        const reply = await message.reply(assistantMessage);
        
        // 新しいリプライを会話データに追加
        oneShotConversations[reply.id] = {
          userId: conversationData.userId, // 元の会話の開始者のID
          guildId: conversationData.guildId,
          model: conversationData.model,
          systemPrompt: conversationData.systemPrompt,
          createdAt: Date.now(),
          parentMessageId: referencedMessageId
        };
        await saveOneShotConversations();
        
        // クレジット残高警告
        if (finalMessageData.user) {
          const paidCredit = finalMessageData.user.paid_credit || 0;
          const freeCredit = finalMessageData.user.remaining_credit || 0;
          const totalCredit = paidCredit + freeCredit;
          
          if (totalCredit < 1000000) {
            const warningEmbed = new EmbedBuilder()
              .setColor(0xFFAA00)
              .setTitle('⚠️ クレジット残高警告')
              .setDescription(
                `クレジット残高が少なくなっています。\n\n` +
                `💳 **有料クレジット**: ${paidCredit.toLocaleString()} credits\n` +
                `🎁 **無料クレジット**: ${freeCredit.toLocaleString()} credits\n` +
                `📊 **合計**: ${totalCredit.toLocaleString()} credits`
              );
            
            await message.channel.send({ embeds: [warningEmbed] });
          }
        }
        
        console.log(`[OneShot] Generated response for conversation ${referencedMessageId}`);
        
        // 一時スレッドを削除（オプション）
        // await fetch(`${CONFIG.API_BASE_URL}/api/threads/${tempThreadId}`, {
        //   method: 'DELETE',
        //   headers: { 'Authorization': `Bearer ${token}` }
        // });
        
      } catch (error) {
        console.error('[OneShot Error]:', error);
        await message.reply({ embeds: [createErrorEmbed(`エラーが発生しました: ${error.message}`)] });
      }
      return; // 単発生成モードの処理が完了したので終了
    }
  }
  
  // 他のbotのメッセージの場合
  if (message.author.bot) {
    // tempChannelsに登録されているチャンネルの場合のみ処理
    if (message.guild && message.channel.type === ChannelType.GuildText) {
      const key = `${message.guild.id}-${message.channel.id}`;
      if (tempChannels[key]) {
        try {
          const guildId = message.guild.id;
          const channelId = message.channel.id;
          const threadId = getGroupThreadId(guildId, channelId);
          
          // メンション形式を変換
          const convertedContent = await convertMentionsToReadable(message.content, message.guild);
          
          // メタデータを構築
          const metadata = {
            authorId: message.author.id,
            authorName: message.author.username,
            authorBot: true,
            channelId: channelId,
            guildId: guildId,
            messageId: message.id,
            timestamp: message.createdAt.toISOString()
          };
          
          // メッセージをスレッドに追加（appendMessageのみ）
          await appendMessage(CONFIG.BOT_USER_ID, guildId, threadId, convertedContent, metadata);
          
          // アクティビティを更新（Botの書き込み）
          await updateChannelActivity(guildId, channelId, true);
          
          if (CONFIG.DEBUG) {
            console.log(`[BotMessage] Appended bot message to thread ${threadId}: ${convertedContent.substring(0, 50)}...`);
          }
        } catch (error) {
          console.error('[BotMessage Error]:', error);
        }
      }
    }
    return;
  }
  
  const guildId = message.guild?.id || 'dm';
  const channelId = message.channel.id;
  const key = `${guildId}-${channelId}`;
  
  // 一時チャンネルでのメッセージ処理
  if (message.guild && tempChannels[key]) {
    // 一時チャンネルのアクティビティを更新（Bot以外）
    await updateChannelActivity(guildId, channelId, false);
    
    // ギルドが有効化されていない場合は静かに無視
    if (!isGuildEnabled(guildId)) {
      return;
    }
    
    try {
      // メンション形式を変換
      const convertedContent = await convertMentionsToReadable(message.content, message.guild);
      
      // メタデータを準備
      const metadata = {
        userId: message.author.id,
        userName: message.author.username,
        displayName: message.member?.displayName || message.author.username,
        channelId: channelId,
        channelName: message.channel.name,
        categoryName: tempChannels[key].categoryName,
        guildId: guildId,
        guildName: message.guild.name,
        isBot: false
      };
      
      // グループスレッドIDを取得
      const threadId = await getOrCreateGroupThread(CONFIG.BOT_USER_ID, guildId, channelId, message.channel.name, message.guild.name);
      
      // @メンションがある場合は応答を生成
      if (message.mentions.has(client.user)) {
        console.log("message");
        console.log("message");
        console.log(message);
        await message.channel.sendTyping();
        
        // ユーザー情報を確認
        const user = await getUserInfo(message.author.id, guildId);
        console.log("user");
        console.log("user");
        console.log(user);
        if (!user) {
          await message.reply({ embeds: [createInfoEmbed('アカウント未登録', 'Botを使用するには、まず `/request-access-user` コマンドでアクセスをリクエストしてください。')] });
          return;
        }
        
        if (user.authority === Authority.PENDING) {
          await message.reply({ embeds: [createInfoEmbed('承認待ち', 'アクセスリクエストは送信済みです。管理者の承認をお待ちください。')] });
          return;
        }
        
        if (user.authority === Authority.STOPPED) {
          await message.reply({ embeds: [createErrorEmbed('アカウントが停止されています。')] });
          return;
        }
        
        if (user.authority === Authority.BANNED) {
          await message.reply({ embeds: [createErrorEmbed('アカウントがBANされています。')] });
          return;
        }
        
        // 新しいクレジットチェック: Admin/VIPはスキップ、一般ユーザーは有料+無料の合計をチェック
        if (user.authority !== Authority.ADMIN && user.authority !== Authority.VIP) {
          const paidCredit = user.paid_credit || 0;
          const freeCredit = user.remaining_credit || 0;
          const totalCredit = paidCredit + freeCredit;
          
          if (totalCredit < 0) {
            await message.reply({ 
              embeds: [createErrorEmbed(
                'クレジット残高が不足しています。\n' +
                `有料クレジット: ${paidCredit.toLocaleString()} credits\n` +
                `無料クレジット: ${freeCredit.toLocaleString()} credits\n` +
                `合計: ${totalCredit.toLocaleString()} credits\n\n` +
                'クレジットを購入してください。'
              )] 
            });
            return;
          }
        }
        
        // 応答を生成
        const response = await sendMessageWithMetadata(message.author.id, guildId, threadId, convertedContent, metadata);
        console.log("response");
        console.log("response");
        console.log(response);
        await sendLongMessage(message.channel, response.assistantMessage.content);
        
        // アクティビティを更新（Botの書き込み）
        await updateChannelActivity(guildId, channelId, true);
        
        // クレジット残高警告（新しい仕様）
        if (response.user) {
          const paidCredit = response.user.paid_credit || 0;
          const freeCredit = response.user.remaining_credit || 0;
          const totalCredit = paidCredit + freeCredit;
          
          // 合計クレジットが100万未満の場合に警告
          if (totalCredit < 1000000) {
            const warningEmbed = new EmbedBuilder()
              .setColor(0xFFAA00)
              .setTitle('⚠️ クレジット残高警告')
              .setDescription(
                `クレジット残高が少なくなっています。\n\n` +
                `💳 **有料クレジット**: ${paidCredit.toLocaleString()} credits\n` +
                `🎁 **無料クレジット**: ${freeCredit.toLocaleString()} credits\n` +
                `📊 **合計**: ${totalCredit.toLocaleString()} credits`
              );
            
            if (paidCredit === 0 && freeCredit < 0) {
              warningEmbed.addFields({
                name: '❗ 負債状態',
                value: 'クレジットを購入することをお勧めします。\n購入されたクレジットは負債の返済から優先的に使用されます。'
              });
            }
            
            await message.channel.send({ embeds: [warningEmbed] });
          }
        }
      } else {
        // @メンションがない場合は、メッセージをスレッドに追加するのみ
        await appendMessage(CONFIG.BOT_USER_ID, guildId, threadId, convertedContent, metadata);
        
        if (CONFIG.DEBUG) {
          console.log(`[Message] Appended to thread ${threadId}: ${convertedContent.substring(0, 50)}...`);
        }
      }
    } catch (error) {
      console.error('[Message Error]:', error);
      await message.reply({ embeds: [createErrorEmbed('エラーが発生しました。')] });
    }
    return;
  }
  
  // 通常チャンネルでの処理（元の実装を維持）
  if (message.guild && message.channel.type === ChannelType.GuildText) {
    const key = `${message.guild.id}-${message.channel.id}`;
    if (tempChannels[key]) {
      await updateChannelActivity(message.guild.id, message.channel.id, false);
    }
  }

  if (!message.mentions.has(client.user)) return;
  try {
    const userId = message.author.id;
    const guildId = message.guild?.id || 'dm';
    const channelId = message.channel.id;
    if (guildId !== 'dm' && !isGuildEnabled(guildId)) {
      await message.reply({ embeds: [createErrorEmbed('このサーバーではBotが有効化されていません。\n`/request-access-guild` コマンドでアクセスをリクエストしてください。')] });
      return;
    }
    const content = message.content.replace(/<@!?\d+>/g, '').trim();
    if (!content) { await message.reply('何か質問してください！'); return; }
    await message.channel.sendTyping();
    const user = await getUserInfo(userId, guildId);
    if (!user) {
      await message.reply({ embeds: [createInfoEmbed('アカウント未登録', 'Botを使用するには、まず `/request-access-user` コマンドでアクセスをリクエストしてください。')] });
      return;
    }
    if (user.authority === Authority.PENDING) {
      await message.reply({ embeds: [createInfoEmbed('承認待ち', 'アクセスリクエストは送信済みです。管理者の承認をお待ちください。')] });
      return;
    }
    if (user.authority === Authority.STOPPED) {
      await message.reply({ embeds: [createErrorEmbed('アカウントが停止されています。')] });
      return;
    }
    if (user.authority === Authority.BANNED) {
      await message.reply({ embeds: [createErrorEmbed('アカウントがBANされています。')] });
      return;
    }
    
    // 新しいクレジットチェック: Admin/VIPはスキップ、一般ユーザーは有料+無料の合計をチェック
    if (user.authority !== Authority.ADMIN && user.authority !== Authority.VIP) {
      const paidCredit = user.paid_credit || 0;
      const freeCredit = user.remaining_credit || 0;
      const totalCredit = paidCredit + freeCredit;
      
      if (totalCredit < 0) {
        await message.reply({ 
          embeds: [createErrorEmbed(
            'クレジット残高が不足しています。\n' +
            `有料クレジット: ${paidCredit.toLocaleString()} credits\n` +
            `無料クレジット: ${freeCredit.toLocaleString()} credits\n` +
            `合計: ${totalCredit.toLocaleString()} credits\n\n` +
            'クレジットを購入してください。'
          )] 
        });
        return;
      }
    }
    
    const threadId = await getOrCreateThread(userId, guildId, channelId);
    console.log("通常スレッドのメッセージ")

    const response = await sendMessage(userId, guildId, threadId, content);
    await sendLongMessage(message.channel, response.assistantMessage.content);
    
    // クレジット残高警告（新しい仕様）
    if (response.user) {
      const paidCredit = response.user.paid_credit || 0;
      const freeCredit = response.user.remaining_credit || 0;
      const totalCredit = paidCredit + freeCredit;
      
      // 合計クレジットが100万未満の場合に警告
      if (totalCredit < 1000000) {
        const warningEmbed = new EmbedBuilder()
          .setColor(0xFFAA00)
          .setTitle('⚠️ クレジット残高警告')
          .setDescription(
            `クレジット残高が少なくなっています。\n\n` +
            `💳 **有料クレジット**: ${paidCredit.toLocaleString()} credits\n` +
            `🎁 **無料クレジット**: ${freeCredit.toLocaleString()} credits\n` +
            `📊 **合計**: ${totalCredit.toLocaleString()} credits`
          );
        
        if (paidCredit === 0 && freeCredit < 0) {
          warningEmbed.addFields({
            name: '❗ 負債状態',
            value: 'クレジットを購入することをお勧めします。'
          });
        }
        
        await message.channel.send({ embeds: [warningEmbed] });
      }
    }
  } catch (error) {
    console.error('[Message Error]:', error);
    await message.reply({ embeds: [createErrorEmbed('エラーが発生しました。')] });
  }
});

// ボイス状態変更イベント - ボイスチャンネルのアクティビティを追跡
client.on('voiceStateUpdate', async (oldState, newState) => {
  // ユーザーがボイスチャンネルに参加または移動した場合
  if (newState.channel) {
    const key = `${newState.guild.id}-${newState.channel.id}`;
    if (tempChannels[key]) {
      // Botでないユーザーの場合
      await updateChannelActivity(newState.guild.id, newState.channel.id, newState.member.user.bot);
    }
  }
  
  // ユーザーがボイスチャンネルから退出した場合
  if (oldState.channel) {
    const key = `${oldState.guild.id}-${oldState.channel.id}`;
    if (tempChannels[key]) {
      // チャンネルが空になったかチェック
      if (oldState.channel.members.size === 0) {
        // 最終アクティビティを更新（誰もいなくなった時点を記録）
        await updateChannelActivity(oldState.guild.id, oldState.channel.id, false);
      } else {
        // Botでないユーザーの退出の場合
        await updateChannelActivity(oldState.guild.id, oldState.channel.id, oldState.member.user.bot);
      }
    }
  }
});

client.once(Events.ClientReady, async (readyClient) => {
  console.log('='.repeat(70));
  console.log(`Logged in as ${client.user.tag}`);
  console.log(`Bot ID: ${client.user.id}`);
  console.log(`API Base URL: ${CONFIG.API_BASE_URL}`);
  console.log('='.repeat(70));
  console.log('\n📋 OAuth2 Configuration:');
  console.log('='.repeat(70));
  console.log(`Application ID: ${CONFIG.DISCORD_APP_ID}`);
  console.log(`Redirect URI: ${CONFIG.OAUTH2_CALLBACK_URL}`);
  console.log(`OAuth2 Login URL for end users: ${CONFIG.OAUTH2_LOGIN_URL}`);
  console.log('\n⚠️  Add this Redirect URI in Discord Developer Portal:');
  console.log(`   https://discord.com/developers/applications/${CONFIG.DISCORD_APP_ID}/oauth2/general`);
  console.log('='.repeat(70));
  const guildsConfig = loadGuildConfig();
  const registeredGuilds = Object.keys(guildsConfig);
  console.log(`\n📊 Registered Guilds: ${registeredGuilds.length}`);
  console.log('='.repeat(70));
  if (registeredGuilds.length > 0) {
    registeredGuilds.forEach(guildId => {
      const guildInfo = guildsConfig[guildId];
      const statusIcon = guildInfo.enabled ? '✅' : '❌';
      console.log(`${statusIcon} ${guildInfo.name} (${guildId})`);
    });
  } else {
    console.log('No guilds registered. Use: node guild-manager-cli.js register <guildId> <guildName>');
  }
  console.log('='.repeat(70));
    
  // 一時チャンネルデータを読み込み
  await loadTempChannels();
  
  // 単発生成モード会話データを読み込み
  await loadOneShotConversations();
  
  // 古い単発生成モード会話をクリーンアップ
  await cleanupOldOneShotConversations();

  // トークンキャッシュのクリーンアップを定期実行（1時間ごと）
  setInterval(() => {
    const now = Date.now();
    let cleaned = 0;
    for (const [key, cache] of tokenCache.entries()) {
      if (cache.expiresAt <= now) {
        tokenCache.delete(key);
        cleaned++;
      }
    }
    if (cleaned > 0 && CONFIG.DEBUG) {
      console.log(`[Cache] Cleaned ${cleaned} expired token(s)`);
    }
  }, 60 * 60 * 1000);
  
  // 一時チャンネルのチェックと自動応答を定期実行（設定可能な間隔）
  setInterval(async () => {
    await checkAndDeleteTempChannels();
  }, CONFIG.AUTO_REPLY_INTERVAL);
  
  // 古い単発生成モード会話を定期的にクリーンアップ（1時間ごと）
  setInterval(async () => {
    await cleanupOldOneShotConversations();
  }, 60 * 60 * 1000);
  
  // 起動時にも一度チェック
  await checkAndDeleteTempChannels();
  
  try {
    console.log('\nFetching available models from API...');
    availableModels = await fetchAvailableModels();
    console.log(`✅ Loaded ${availableModels.length} models`);
    
    console.log('\nRegistering slash commands...');
    const commands = buildCommands(availableModels);
    const rest = new REST({ version: '10' }).setToken(CONFIG.DISCORD_BOT_TOKEN);
    await rest.put(Routes.applicationCommands(CONFIG.DISCORD_APP_ID), { body: commands });
    console.log('✅ Slash commands registered successfully');
  } catch (error) {
    console.error('❌ Failed to register slash commands:', error);
  }
  console.log('\n✅ Discord bot is ready!\n');
});

client.on('guildCreate', guild => {
  console.log(`\n➕ Bot joined new guild: ${guild.name} (${guild.id})`);
  console.log(`   Member count: ${guild.memberCount}`);
  console.log(`   Owner ID: ${guild.ownerId}`);
  
  // 自動的にリクエストを保存
  const saved = saveGuildRequest(guild.id, guild.name, {
    memberCount: guild.memberCount,
    ownerId: guild.ownerId,
    addedAt: new Date().toISOString()
  });
  
  if (saved) {
    console.log(`   ✅ Guild request created and saved`);
    console.log(`   Use CLI to approve: node guild-manager-cli.js`);
  }
  console.log('');
});

client.on('guildDelete', guild => {
  console.log(`\n➖ Bot left guild: ${guild.name} (${guild.id})\n`);
});

process.on('unhandledRejection', error => console.error('[Unhandled Rejection]:', error));
process.on('uncaughtException', error => { console.error('[Uncaught Exception]:', error); process.exit(1); });
process.on('SIGINT', () => { console.log('\nShutting down bot...'); client.destroy(); process.exit(0); });

if (!CONFIG.DISCORD_BOT_TOKEN || !CONFIG.DISCORD_APP_ID || !process.env.BOT_MASTER_SECRET) {
  console.error('Error: Required environment variables not set');
  process.exit(1);
}

client.login(CONFIG.DISCORD_BOT_TOKEN);
