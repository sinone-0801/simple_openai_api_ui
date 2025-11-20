// discord-bot.js - Password Authentication Version
import { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, EmbedBuilder, MessageFlags } from 'discord.js';
import fetch from 'node-fetch';
import 'dotenv/config';
import { generateGuildAuthToken, isGuildEnabled, loadGuildConfig, saveGuildRequest } from './guild-manager.js';

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
  DEBUG: process.env.DEBUG || 'true'
};

const Authority = { ADMIN: 'Admin', VIP: 'Vip', USER: 'User', PENDING: 'Pending', STOPPED: 'Stopped', BANNED: 'Banned' };

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.GuildMembers, GatewayIntentBits.MessageContent]
});

// JWTトークンキャッシュ（guildId別）
const tokenCache = new Map();

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
    // JWTトークンを取得
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

async function sendMessage(userId, guildId, threadId, content, model = CONFIG.DEFAULT_MODEL) {
  return authenticatedRequest(`/api/threads/${threadId}/messages`, userId, guildId, {
    method: 'POST',
    body: JSON.stringify({ content, model })
  });
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

const commands = [
  new SlashCommandBuilder().setName('add-user').setDescription('新しいユーザーを追加（Admin専用）')
    .addUserOption(o => o.setName('user').setDescription('追加するユーザー').setRequired(true))
    .addStringOption(o => o.setName('authority').setDescription('権限レベル').setRequired(true).addChoices({ name: 'VIP', value: Authority.VIP }, { name: 'User', value: Authority.USER }))
    .addIntegerOption(o => o.setName('credit').setDescription('初期クレジット量').setRequired(false).setMinValue(0)).toJSON(),
  new SlashCommandBuilder().setName('request-access-user').setDescription('ユーザーからBotへのアクセス権限をリクエスト').toJSON(),
  new SlashCommandBuilder().setName('my-info').setDescription('自分のアカウント情報を表示').toJSON(),
  new SlashCommandBuilder().setName('request-access-guild').setDescription('このサーバーからBotへのアクセス権限をリクエスト（Admin専用）').toJSON()
];

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
    await interaction.editReply({ embeds: [createSuccessEmbed('ユーザーを追加しました', `**ユーザー:** ${targetUser.tag}\n**権限:** ${authority}\n**クレジット:** ${credit.toLocaleString()} tokens`)] });
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
    const embed = new EmbedBuilder().setColor(0x0099FF).setTitle('📊 アカウント情報')
      .addFields(
        { name: 'ユーザーID', value: user.user_id, inline: true },
        { name: '権限', value: `${statusEmoji[user.authority] || '❓'} ${user.authority}`, inline: true },
        { name: '状態', value: user.isActive ? '✅ 有効' : '❌ 無効', inline: true },
        { name: '残りクレジット', value: `${user.remaining_credit.toLocaleString()} tokens`, inline: true },
        { name: '使用クレジット', value: `${user.used_credit.toLocaleString()} tokens`, inline: true },
        { name: '登録日', value: new Date(user.created_at).toLocaleString('ja-JP'), inline: false }
      ).setTimestamp();
    if (user.last_login) embed.addFields({ name: '最終ログイン', value: new Date(user.last_login).toLocaleString('ja-JP'), inline: false });
    await interaction.editReply({ embeds: [embed] });
  } catch (error) {
    console.error('[Command Error] /my-info:', error);
    await interaction.editReply({ embeds: [createErrorEmbed(`エラーが発生しました: ${error.message}`)] });
  }
}

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;
  try {
    switch (interaction.commandName) {
      case 'add-user': await handleAddUser(interaction); break;
      case 'request-access-user': await handleRequestAccessUser(interaction); break;
      case 'my-info': await handleMyInfo(interaction); break;
      case 'request-access-guild': await handleRequestAccessGuild(interaction); break;
      default: await interaction.reply({ content: '不明なコマンドです。', flags: MessageFlags.Ephemeral });
    }
  } catch (error) {
    console.error('[Interaction Error]:', error);
    const errorResponse = { embeds: [createErrorEmbed('コマンドの実行中にエラーが発生しました。')], flags: MessageFlags.Ephemeral };
    if (interaction.deferred) await interaction.editReply(errorResponse); else await interaction.reply(errorResponse);
  }
});

client.on('messageCreate', async (message) => {
  if (message.author.bot || !message.mentions.has(client.user)) return;
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
    if (user.remaining_credit <= 0) {
      await message.reply({ embeds: [createErrorEmbed('クレジット残高が不足しています。')] });
      return;
    }
    const threadId = await getOrCreateThread(userId, guildId, channelId);
    const response = await sendMessage(userId, guildId, threadId, content);
    await sendLongMessage(message.channel, response.assistantMessage.content);
    if (response.user && response.user.remaining_credit < 1000000) {
      await message.channel.send({ embeds: [new EmbedBuilder().setColor(0xFFAA00).setTitle('⚠️ クレジット残高警告').setDescription(`クレジット残高が少なくなっています。\n残高: ${response.user.remaining_credit.toLocaleString()} tokens`)] });
    }
  } catch (error) {
    console.error('[Message Error]:', error);
    await message.reply({ embeds: [createErrorEmbed('エラーが発生しました。')] });
  }
});

client.once('ready', async () => {
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
  
  try {
    console.log('\nRegistering slash commands...');
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
