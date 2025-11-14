// discord-bot-example.js
// Discord Botの実装例

import { Client, GatewayIntentBits } from 'discord.js';
import fetch from 'node-fetch';
import 'dotenv/config';

const API_BASE_URL = process.env.API_BASE_URL || 'http://localhost:3000';
const BOT_USER_ID = process.env.BOT_USER_ID || 'discord-bot';

// Discord クライアントの初期化
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

// 認証トークンの生成
function getAuthToken(userId, guildId) {
  // Discord用: UserID + GuildID による認証
  return `${userId}:${guildId}:group`;
}

// API リクエストヘルパー
async function apiRequest(endpoint, options = {}) {
  const response = await fetch(`${API_BASE_URL}${endpoint}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options.headers
    }
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'API request failed');
  }

  return response.json();
}

// ユーザー情報の取得または作成
async function ensureUser(userId, guildId) {
  try {
    // 既存ユーザーの確認
    const authToken = getAuthToken(userId, guildId);
    await apiRequest('/api/auth/me', {
      headers: {
        'Authorization': `Bearer ${authToken}`
      }
    });
  } catch (error) {
    // ユーザーが存在しない場合、Bot（Admin）権限で作成
    const botToken = getAuthToken(BOT_USER_ID, guildId);
    
    await apiRequest('/api/admin/users', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${botToken}`
      },
      body: JSON.stringify({
        userId: userId,
        groupId: guildId,
        authority: 'User',
        remainingCredit: 10000000 // 10M tokens
      })
    });
  }
}

// スレッドの取得または作成
async function getOrCreateThread(userId, guildId, channelId) {
  const authToken = getAuthToken(userId, guildId);
  
  try {
    // 既存スレッド一覧を取得
    const { threads } = await apiRequest('/api/threads', {
      headers: {
        'Authorization': `Bearer ${authToken}`
      }
    });

    // チャンネル用のスレッドを探す
    const existingThread = threads.find(t => 
      t.title.includes(channelId)
    );

    if (existingThread) {
      return existingThread.id;
    }

    // 新規スレッドを作成
    const newThread = await apiRequest('/api/threads', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${authToken}`
      },
      body: JSON.stringify({
        title: `Discord Channel: ${channelId}`,
        systemPrompt: 'You are a helpful Discord bot assistant.'
      })
    });

    return newThread.id;
  } catch (error) {
    console.error('Failed to get/create thread:', error);
    throw error;
  }
}

// メッセージの送信
async function sendMessage(userId, guildId, threadId, content, model = 'gpt-5-codex') {
  const authToken = getAuthToken(userId, guildId);
  
  return apiRequest(`/api/threads/${threadId}/messages`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${authToken}`
    },
    body: JSON.stringify({
      content,
      model
    })
  });
}

// Bot準備完了
client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
  console.log('Discord bot is ready!');
});

// メッセージ受信時の処理
client.on('messageCreate', async (message) => {
  // Bot自身のメッセージは無視
  if (message.author.bot) return;

  // Botがメンションされているか確認
  if (!message.mentions.has(client.user)) return;

  try {
    // メッセージからBotメンションを除去
    const content = message.content
      .replace(/<@!?\d+>/g, '')
      .trim();

    if (!content) {
      await message.reply('何か質問してください！');
      return;
    }

    // Typing indicator
    await message.channel.sendTyping();

    const userId = message.author.id;
    const guildId = message.guild?.id || 'dm';
    const channelId = message.channel.id;

    // ユーザーの確認・作成
    await ensureUser(userId, guildId);

    // スレッドの取得・作成
    const threadId = await getOrCreateThread(userId, guildId, channelId);

    // メッセージ送信
    const response = await sendMessage(userId, guildId, threadId, content);

    // レスポンスを返信
    const assistantContent = response.assistantMessage.content;
    
    // Discord の文字数制限（2000文字）を考慮
    if (assistantContent.length <= 2000) {
      await message.reply(assistantContent);
    } else {
      // 長いメッセージは分割して送信
      const chunks = assistantContent.match(/[\s\S]{1,2000}/g);
      for (const chunk of chunks) {
        await message.channel.send(chunk);
      }
    }

    // クレジット残高を通知（オプション）
    if (response.user && response.user.remaining_credit < 1000000) {
      await message.channel.send(
        `⚠️ クレジット残高が少なくなっています: ${response.user.remaining_credit.toLocaleString()} tokens`
      );
    }

  } catch (error) {
    console.error('Error handling message:', error);
    
    let errorMessage = 'エラーが発生しました。';
    
    if (error.message.includes('Insufficient credit')) {
      errorMessage = '❌ クレジット残高が不足しています。管理者に連絡してください。';
    } else if (error.message.includes('stopped') || error.message.includes('banned')) {
      errorMessage = '❌ アカウントが停止されています。管理者に連絡してください。';
    }
    
    await message.reply(errorMessage);
  }
});

// Slash Command の例（オプション）
// /credit - 残りクレジット確認
// /model - モデル変更
// など、必要に応じて実装

// Bot起動
client.login(process.env.DISCORD_BOT_TOKEN);
