// line-bot-example.js
// Line Messaging API Botの実装例

import express from 'express';
import { Client } from '@line/bot-sdk';
import fetch from 'node-fetch';
import 'dotenv/config';

const API_BASE_URL = process.env.API_BASE_URL || 'http://localhost:3000';
const BOT_USER_ID = process.env.BOT_USER_ID || 'line-bot';

// Line Bot設定
const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET
};

const lineClient = new Client(lineConfig);
const app = express();

// 認証トークンの生成
function getAuthToken(userId, groupId) {
  // Line用: UserID + GroupID/RoomID による認証
  return `${userId}:${groupId}:group`;
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
async function ensureUser(userId, groupId) {
  try {
    // 既存ユーザーの確認
    const authToken = getAuthToken(userId, groupId);
    await apiRequest('/api/auth/me', {
      headers: {
        'Authorization': `Bearer ${authToken}`
      }
    });
  } catch (error) {
    // ユーザーが存在しない場合、Bot（Admin）権限で作成
    const botToken = getAuthToken(BOT_USER_ID, groupId);
    
    await apiRequest('/api/admin/users', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${botToken}`
      },
      body: JSON.stringify({
        userId: userId,
        groupId: groupId,
        threadId: groupId, // LineではgroupId/roomIdをthreadIdとして使用
        authority: 'User',
        remainingCredit: 10000000 // 10M tokens
      })
    });
  }
}

// スレッドの取得または作成
async function getOrCreateThread(userId, groupId, sourceType) {
  const authToken = getAuthToken(userId, groupId);
  
  try {
    // 既存スレッド一覧を取得
    const { threads } = await apiRequest('/api/threads', {
      headers: {
        'Authorization': `Bearer ${authToken}`
      }
    });

    // グループ/ルーム用のスレッドを探す
    const existingThread = threads.find(t => 
      t.title.includes(groupId)
    );

    if (existingThread) {
      return existingThread.id;
    }

    // 新規スレッドを作成
    const threadTitle = sourceType === 'group' 
      ? `LINE Group: ${groupId}`
      : sourceType === 'room'
      ? `LINE Room: ${groupId}`
      : `LINE User: ${userId}`;

    const newThread = await apiRequest('/api/threads', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${authToken}`
      },
      body: JSON.stringify({
        title: threadTitle,
        systemPrompt: 'You are a helpful LINE bot assistant. Respond in Japanese.'
      })
    });

    return newThread.id;
  } catch (error) {
    console.error('Failed to get/create thread:', error);
    throw error;
  }
}

// メッセージの送信
async function sendMessage(userId, groupId, threadId, content, model = 'gpt-5-codex') {
  const authToken = getAuthToken(userId, groupId);
  
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

// Webhook エンドポイント
app.post('/webhook', express.json(), async (req, res) => {
  try {
    const events = req.body.events;

    // イベント処理
    await Promise.all(events.map(handleEvent));

    res.status(200).end();
  } catch (error) {
    console.error('Webhook error:', error);
    res.status(500).end();
  }
});

// イベントハンドラー
async function handleEvent(event) {
  // テキストメッセージのみ処理
  if (event.type !== 'message' || event.message.type !== 'text') {
    return null;
  }

  const userId = event.source.userId;
  const content = event.message.text;

  // グループID/ルームIDの取得
  let groupId;
  let sourceType;

  if (event.source.type === 'group') {
    groupId = event.source.groupId;
    sourceType = 'group';
  } else if (event.source.type === 'room') {
    groupId = event.source.roomId;
    sourceType = 'room';
  } else {
    // 1対1チャットの場合はuserIdをgroupIdとして使用
    groupId = userId;
    sourceType = 'user';
  }

  try {
    // ユーザーの確認・作成
    await ensureUser(userId, groupId);

    // スレッドの取得・作成
    const threadId = await getOrCreateThread(userId, groupId, sourceType);

    // メッセージ送信
    const response = await sendMessage(userId, groupId, threadId, content);

    // レスポンスを返信
    const assistantContent = response.assistantMessage.content;
    
    // LINEの文字数制限（5000文字）を考慮
    if (assistantContent.length <= 5000) {
      await lineClient.replyMessage(event.replyToken, {
        type: 'text',
        text: assistantContent
      });
    } else {
      // 長いメッセージは分割して送信
      const chunks = assistantContent.match(/[\s\S]{1,5000}/g);
      const messages = chunks.map(chunk => ({
        type: 'text',
        text: chunk
      }));
      
      // 最初のメッセージはreplyで送信
      await lineClient.replyMessage(event.replyToken, messages[0]);
      
      // 残りはpushで送信
      if (messages.length > 1) {
        for (let i = 1; i < messages.length; i++) {
          await lineClient.pushMessage(
            event.source.type === 'group' ? event.source.groupId : 
            event.source.type === 'room' ? event.source.roomId : 
            userId,
            messages[i]
          );
        }
      }
    }

    // クレジット残高警告（オプション）
    if (response.user && response.user.remaining_credit < 1000000) {
      await lineClient.pushMessage(
        event.source.type === 'group' ? event.source.groupId : 
        event.source.type === 'room' ? event.source.roomId : 
        userId,
        {
          type: 'text',
          text: `⚠️ クレジット残高: ${response.user.remaining_credit.toLocaleString()} tokens\n残りわずかです。管理者に連絡してください。`
        }
      );
    }

  } catch (error) {
    console.error('Error handling LINE event:', error);
    
    let errorMessage = 'エラーが発生しました。';
    
    if (error.message.includes('Insufficient credit')) {
      errorMessage = '❌ クレジット残高が不足しています。\n管理者に連絡してください。';
    } else if (error.message.includes('stopped') || error.message.includes('banned')) {
      errorMessage = '❌ アカウントが停止されています。\n管理者に連絡してください。';
    }
    
    await lineClient.replyMessage(event.replyToken, {
      type: 'text',
      text: errorMessage
    });
  }
}

// リッチメニューの設定例（オプション）
async function setupRichMenu() {
  // リッチメニューの作成
  const richMenu = {
    size: { width: 2500, height: 1686 },
    selected: true,
    name: 'AI Chat Menu',
    chatBarText: 'メニュー',
    areas: [
      {
        bounds: { x: 0, y: 0, width: 1250, height: 843 },
        action: {
          type: 'message',
          text: '/credit'
        }
      },
      {
        bounds: { x: 1250, y: 0, width: 1250, height: 843 },
        action: {
          type: 'message',
          text: '/help'
        }
      },
      {
        bounds: { x: 0, y: 843, width: 1250, height: 843 },
        action: {
          type: 'message',
          text: '/model gpt-5-mini'
        }
      },
      {
        bounds: { x: 1250, y: 843, width: 1250, height: 843 },
        action: {
          type: 'message',
          text: '/reset'
        }
      }
    ]
  };

  try {
    const richMenuId = await lineClient.createRichMenu(richMenu);
    console.log('Rich menu created:', richMenuId);
    
    // リッチメニュー画像のアップロード（画像は別途用意）
    // await lineClient.setRichMenuImage(richMenuId, imageBuffer);
    
    // デフォルトリッチメニューとして設定
    // await lineClient.setDefaultRichMenu(richMenuId);
    
  } catch (error) {
    console.error('Failed to setup rich menu:', error);
  }
}

// ヘルスチェック
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// サーバー起動
const PORT = process.env.LINE_BOT_PORT || 3001;
app.listen(PORT, () => {
  console.log(`LINE Bot server running on port ${PORT}`);
  console.log(`Webhook URL: http://your-domain.com:${PORT}/webhook`);
});

// オプション: リッチメニューのセットアップ
// setupRichMenu();
