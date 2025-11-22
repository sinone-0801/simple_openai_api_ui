// server.js
import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import { OpenAI } from 'openai';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { OAuth2Scopes, PermissionFlagsBits } from 'discord.js';
import * as auth from './auth.js';
import * as payment from './payment.js';
import * as configs from './utils/config.js';
import { getStateManager } from './utils/oauth-state-validation.js';
import * as helpers from './helpers.js';

const app = express();

// ====================
// JWT無効化機能: サーバー起動時刻を記録
// ====================
// サーバー起動時刻（Unix timestamp in seconds）
const SERVER_STARTUP_TIME = Math.floor(Date.now() / 1000);
console.log(`[JWT] Server startup time: ${new Date(SERVER_STARTUP_TIME * 1000).toISOString()}`);
console.log(`[JWT] Tokens issued before this time will be invalidated`);

// ====================
// 支払い・クレジット購入 API
// ====================

// 購入設定の取得
app.get('/api/payment/config', requireAuth, (req, res) => {
  try {
    const config = payment.getPaymentConfig();
    res.json(config);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Stripe Checkoutセッションの作成
app.post('/api/payment/create-checkout', requireAuth, async (req, res) => {
  try {
    const { amount, credits } = req.body;

    if (!amount || !credits) {
      return res.status(400).json({ error: 'Amount and credits are required' });
    }

    // 成功・キャンセルのURL
    const successUrl = `${configs.BASE_URL}/success.html`;
    const cancelUrl = `${configs.BASE_URL}/cancel.html`;

    // Checkoutセッション作成
    const session = await payment.createCheckoutSession({
      userId: req.user.user_id,
      amount,
      credits,
      successUrl,
      cancelUrl
    });

    res.json({ url: session.url, sessionId: session.id });
  } catch (error) {
    console.error('Create checkout error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Stripe Webhookエンドポイント（重要: express.json()の前に配置が必要）
// このエンドポイントは app.use(express.json()) より前に配置すること
app.post('/api/payment/webhook', 
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    try {
      const signature = req.headers['stripe-signature'];
      
      if (!signature) {
        return res.status(400).json({ error: 'Missing stripe-signature header' });
      }

      // Webhookの処理
      await payment.handleWebhook(req.body, signature);
      
      res.json({ received: true });
    } catch (error) {
      console.error('Webhook error:', error);
      res.status(400).json({ error: error.message });
    }
  }
);

// 購入履歴の取得（将来の実装用）
app.get('/api/payment/history', requireAuth, async (req, res) => {
  try {
    const history = await payment.getPurchaseHistory(req.user.user_id);
    res.json({ history });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ※ 購入関連の API は app.use(express.json()); より上に配置すること
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 静的ファイルの配信
app.use(express.static('public'));

// 環境変数の確認
configs.validateRequiredEnvVars();

// データベースベースのマネージャーを初期化
const stateManager = getStateManager('./data/auth.db');

// 定期的にクリーンアップ（1時間ごと）
setInterval(() => {
  stateManager.cleanupExpiredStates();
}, 60 * 60 * 1000);

// 起動時に1回クリーンアップ
stateManager.cleanupExpiredStates();

// upload 制限の設定
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: configs.MAX_FILE_SIZE,
    files: configs.MAX_FILES
  }
});

// 設定値のログ出力
configs.logConfiguration();

// OpenAIクライアントの初期化
const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  timeout: configs.OPENAI_API_TIMEOUT,
  maxRetries: configs.OPENAI_MAX_RETRIES
});

// ディレクトリの初期化
await fs.mkdir(configs.DATA_DIR, { recursive: true });
await fs.mkdir(configs.ARTIFACTS_DIR, { recursive: true });

// データベースの初期化
await auth.initDatabase();

// CSVログファイルの初期化
await helpers.initTokenLog();

await helpers.initSystemPrompts();

await helpers.initResponseFormats();

// ====================
// 認証ミドルウェア
// ====================

// 認証ミドルウェア（必須）
async function requireAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    console.log("authHeader")
    console.log("authHeader")
    console.log(authHeader)
    if (!authHeader) {
      return res.status(401).json({ error: 'Authorization header required' });
    }

    // Bearer トークン形式: "Bearer <JWT_TOKEN>"
    const token = authHeader.replace('Bearer ', '');
    
    if (!token) {
      return res.status(401).json({ error: 'Invalid token format' });
    }

    // JWTトークンを検証
    let decoded;
    try {
      decoded = jwt.verify(token, configs.JWT_SECRET);
    } catch (jwtError) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }

    // サーバー起動時刻より前に発行されたトークンを拒否
    if (decoded.iat && decoded.iat < SERVER_STARTUP_TIME) {
      console.log(`[JWT] Token rejected: issued at ${new Date(decoded.iat * 1000).toISOString()} (before server startup)`);
      return res.status(401).json({ 
        error: 'Token invalidated due to server restart',
        message: 'Please login again'
      });
    }

    // デコードされたトークンからユーザー情報を取得
    const user = await auth.getUser(decoded.sub);
    
    if (!user) {
      return res.status(401).json({ error: 'User not found' });
    }

    // リクエストにユーザー情報を添付
    req.user = user;
    next();
  } catch (error) {
    if (error.message.includes('stopped') || error.message.includes('banned')) {
      return res.status(403).json({ error: error.message });
    }
    return res.status(401).json({ error: 'Authentication failed' });
  }
}

// Admin権限チェックミドルウェア
async function requireAdmin(req, res, next) {
  if (!req.user || req.user.authority !== auth.Authority.ADMIN) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

// クレジット残高チェックミドルウェア
async function checkCredit(req, res, next) {
  const user = req.user;
  
  // Admin権限は常にスキップ
  if (user.authority === auth.Authority.ADMIN) {
    return next();
  }

  // VIP権限もスキップ
  if (user.authority === auth.Authority.VIP) {
    return next();
  }

  // 有料クレジットがある場合は無料クレジットやトークン制限を無視
  if ((user.paid_credit || 0) > 0) {
    return next();
  }

  // 有料クレジット + 無料クレジットの合計をチェック
  const totalCredit = (user.paid_credit || 0) + (user.remaining_credit || 0);
  if (totalCredit < 0) {
    return res.status(402).json({ 
      error: 'Insufficient credit',
      paidCredit: user.paid_credit || 0,
      freeCredit: user.remaining_credit || 0,
      totalCredit: totalCredit,
      message: 'クレジットが不足しています。クレジットを購入してください。（無料クレジットは開発者の気分で不定期に配布されます）'
    });
  }

  next();
}

// ログ圧縮の定期実行
setInterval(helpers.compressAndCleanLogs, 60 * 60 * 1000);
helpers.compressAndCleanLogs();

// ====================
// スレッド管理 API
// ====================

// スレッド一覧取得
app.get('/api/threads', requireAuth, async (req, res) => {
  try {
    const data = await helpers.readThreads();
    res.json({ threads: data.threads });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 特定スレッド取得
app.get('/api/threads/:threadId', requireAuth, async (req, res) => {
  try {
    const { threadId } = req.params;
    const thread = await helpers.readThread(threadId);
    if (!thread) return res.status(404).json({ error: 'Thread not found' });

    const { thread: refreshedThread, artifacts } = await helpers.refreshThreadDerivedState(thread, { persist: true });
    res.json({
      ...refreshedThread,
      artifactInventory: artifacts
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 新規スレッド作成
app.post('/api/threads', requireAuth, async (req, res) => {
  try {
    const { 
      title, 
      systemPrompt, 
      model, 
      responseFormat, 
      reasoningEffort,
      threadId: customThreadId,
      metadata 
    } = req.body;
    
    // threadIdが指定されている場合はそれを使用、なければ生成
    const threadId = customThreadId || helpers.generateId();
    const timestamp = new Date().toISOString();
    const userPrompt = (systemPrompt || configs.DEFAULT_SYSTEM_PROMPT).trim();

    // 既存のスレッドIDと重複していないか確認
    if (customThreadId) {
      const existingThread = await helpers.readThread(customThreadId);
      if (existingThread) {
        return res.status(409).json({ 
          error: 'Thread ID already exists',
          threadId: customThreadId 
        });
      }
    }

    const modelValidation = helpers.validateModel(model);
    if (!modelValidation.valid) {
      return res.status(400).json({ error: modelValidation.error });
    }

    // Response Formatを登録
    const responseFormatHash = responseFormat ? await helpers.registerResponseFormat(responseFormat) : null;

    const newThreadSummary = {
      id: threadId,
      title: title || 'New Thread',
      userId: req.user.user_id,
      createdAt: timestamp,
      updatedAt: timestamp,
      artifactIds: []
    };
    
    // メタデータがある場合は追加（グループスレッド対応）
    if (metadata) {
      newThreadSummary.metadata = metadata;
    }

    const threadData = {
      id: threadId,
      title: newThreadSummary.title,
      systemPromptUser: userPrompt,
      userId: req.user.user_id,
      systemPrompt: helpers.composeSystemPrompt(userPrompt, []),
      model: modelValidation.model,
      responseFormatHash,
      reasoningEffort: reasoningEffort || 'medium',
      messages: [],
      artifactIds: [],
      createdAt: timestamp,
      updatedAt: timestamp
    };
    
    // メタデータがある場合は追加
    if (metadata) {
      threadData.metadata = metadata;
    }

    const threads = await helpers.readThreads();
    threads.threads.push(newThreadSummary);
    await helpers.writeThreads(threads);
    await helpers.writeThread(threadId, threadData);

    res.status(201).json({
      ...threadData,
      artifactInventory: []
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// スレッド削除
app.delete('/api/threads/:threadId', requireAuth, async (req, res) => {
  try {
    const { threadId } = req.params;
    
    // スレッド一覧から削除
    const threads = await helpers.readThreads();
    threads.threads = threads.threads.filter(t => t.id !== threadId);
    await helpers.writeThreads(threads);
    
    // スレッドファイルを削除
    const threadFile = path.join(configs.DATA_DIR, `thread_${threadId}.json`);
    await fs.unlink(threadFile).catch(() => {});
    
    res.json({ message: 'Thread deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ====================
// システムプロンプト管理 API
// ====================

// システムプロンプト取得
app.get('/api/threads/:threadId/system-prompt', requireAuth, async (req, res) => {
  try {
    const thread = await helpers.readThread(req.params.threadId);
    if (!thread) return res.status(404).json({ error: 'Thread not found' });
    const { thread: refreshedThread, artifacts } = await helpers.refreshThreadDerivedState(thread, { persist: true });
    res.json({
      systemPromptUser: refreshedThread.systemPromptUser,
      systemPrompt: refreshedThread.systemPrompt,
      artifactInventory: artifacts
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// システムプロンプト更新
app.put('/api/threads/:threadId/system-prompt', requireAuth, async (req, res) => {
  try {
    const { systemPrompt } = req.body;
    const thread = await helpers.readThread(req.params.threadId);
    if (!thread) return res.status(404).json({ error: 'Thread not found' });

    thread.systemPromptUser = (systemPrompt || configs.DEFAULT_SYSTEM_PROMPT).trim();
    const { thread: refreshedThread, artifacts } = await helpers.refreshThreadDerivedState(thread, { persist: true });

    res.json({
      systemPromptUser: refreshedThread.systemPromptUser,
      systemPrompt: refreshedThread.systemPrompt,
      artifactInventory: artifacts
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Response Format取得API
app.get('/api/response-formats/:hash', requireAuth, async (req, res) => {
  try {
    const { hash } = req.params;
    const formats = await helpers.readResponseFormats();
    const format = formats[hash];

    if (!format) {
      return res.status(404).json({ error: 'Response format not found' });
    }

    res.json(format);
  } catch (error) {
    console.log(error);
    res.status(500).json({ error: error.message });
  }
});

// Response Format更新API
app.put('/api/threads/:threadId/response-format', requireAuth, async (req, res) => {
  try {
    const { threadId } = req.params;
    const { responseFormat } = req.body;
    const thread = await helpers.readThread(req.params.threadId);
    if (!thread) return res.status(404).json({ error: 'Thread not found' });

    // Response Formatを設定
    if (responseFormat) {
      const hash = await helpers.registerResponseFormat(responseFormat);
      thread.responseFormatHash = hash;
      thread.responseFormat = responseFormat;
    } else {
      // 空の場合は削除
      thread.responseFormatHash = null;
      thread.responseFormat = null;
    }

    await helpers.writeThread(threadId, thread);

    res.json({
      responseFormat: thread.responseFormat,
      responseFormatHash: thread.responseFormatHash
    });
  } catch (error) {
    console.log(error);
    res.status(500).json({ error: error.message });
  }
});

// Reasoning Effort更新API
app.put('/api/threads/:threadId/reasoning-effort', requireAuth, async (req, res) => {
  try {
    const { threadId } = req.params;
    const { reasoningEffort } = req.body;
    const thread = await helpers.readThread(req.params.threadId);
    if (!thread) return res.status(404).json({ error: 'Thread not found' });

    // Reasoning Effortを設定（デフォルトは medium）
    thread.reasoningEffort = reasoningEffort || 'medium';
    
    await helpers.writeThread(threadId, thread);

    res.json({
      reasoningEffort: thread.reasoningEffort
    });
  } catch (error) {
    console.log(error);
    res.status(500).json({ error: error.message });
  }
});

// ====================
// モデル管理 API
// ====================

// 利用可能なモデル一覧取得
app.get('/api/models', requireAuth, (req, res) => {
  res.json({
    defaultModel: configs.DEFAULT_MODEL,
    availableModels: configs.AVAILABLE_MODELS,
    highCostModels: configs.AVAILABLE_MODELS_HIGH_COST,
    lowCostModels: configs.AVAILABLE_MODELS_LOW_COST
  });
});

// スレッドのモデル取得
app.get('/api/threads/:threadId/model', requireAuth, async (req, res) => {
  try {
    const { threadId } = req.params;
    const thread = await helpers.readThread(threadId);
    
    if (!thread) {
      return res.status(404).json({ error: 'Thread not found' });
    }
    
    res.json({ model: thread.model || configs.DEFAULT_MODEL });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// スレッドのモデル更新
app.put('/api/threads/:threadId/model', requireAuth, async (req, res) => {
  try {
    const { threadId } = req.params;
    const { model } = req.body;
    
    // モデルのバリデーション
    const modelValidation = helpers.validateModel(model);
    if (!modelValidation.valid) {
      return res.status(400).json({ error: modelValidation.error });
    }
    
    const thread = await helpers.readThread(threadId);
    if (!thread) {
      return res.status(404).json({ error: 'Thread not found' });
    }
    
    thread.model = modelValidation.model;
    thread.updatedAt = new Date().toISOString();
    await helpers.writeThread(threadId, thread);
    
    res.json({ model: thread.model });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ====================
// トークン使用量 API
// ====================

// トークン使用量の統計を取得
app.get('/api/token-usage/stats', requireAuth, async (req, res) => {
  const summary = await helpers.getTokenUsageSummary();
  try {
    res.json({
      last24Hours: {
        highCost: {
          usage: summary.highCost.usage,
          limit: summary.highCost.limit,
          percentage: summary.highCost.percentage.toFixed(2)
        },
        lowCost: {
          usage: summary.lowCost.usage,
          limit: summary.lowCost.limit,
          percentage: summary.lowCost.percentage.toFixed(2)
        }
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ====================
// メッセージ処理 API
// ====================

// メッセージ送信と応答生成
app.post('/api/threads/:threadId/messages', requireAuth, checkCredit, async (req, res) => {
  try {
    const { threadId } = req.params;
    const { content, model, responseFormat, reasoningEffort, metadata } = req.body;
    const saveUserMessage = req.body.saveUserMessage || true;

    const thread = await helpers.readThread(threadId);
    if (!thread) return res.status(404).json({ error: 'Thread not found' });

    const { thread: hydratedThread } = await helpers.refreshThreadDerivedState(thread, { persist: false });
    const developerPrompt = hydratedThread.systemPrompt;

    // モデルの優先順位: リクエスト > スレッド > デフォルト
    let selectedModel = model || thread.model || configs.DEFAULT_MODEL;

    // モデルのバリデーション
    const modelValidation = helpers.validateModel(selectedModel);
    if (!modelValidation.valid) {
      return res.status(400).json({ error: modelValidation.error });
    }
    selectedModel = modelValidation.model;
    console.log(selectedModel)
    console.log(selectedModel)
    console.log(selectedModel)
    
    // 有料クレジットがある場合はトークン制限をスキップ
    const hasPaidCredit = (req.user.paid_credit || 0) > 0;
    if (!hasPaidCredit) {
      const usageSummary = await helpers.getTokenUsageSummary();
      const modelTier = configs.AVAILABLE_MODELS_HIGH_COST.includes(selectedModel) ? 'highCost' : 'lowCost';
      const tierUsage = usageSummary[modelTier];
      if (tierUsage.usage >= tierUsage.limit * configs.LIMIT_THRESHOLD_RATIO) {
        return res.status(429).json({
          error: 'TOKEN_LIMIT_APPROACHING',
          message: '24時間の無料利用枠がまもなく上限に達するため、しばらく待ってから再度お試しください。有料クレジットを購入すると、この制限なしでご利用いただけます。',
          usage: {
            modelTier,
            ...tierUsage
          }
        });
      }
    }
    
    // ユーザーメッセージを追加
    let userMessage = {
      id: helpers.generateId(),
      role: 'user',
      content,
      timestamp: new Date().toISOString()
    };
    if (metadata) {
      userMessage.metadata = metadata;
    }
    
    let assistantMessage;
    try {
     // ユーザーメッセージを会話ログとして保存する場合と、そうでない場合（グループ会話で会話の継続を促す場合など）で扱いを変える
     let conversationHistory = {};
     if (saveUserMessage === true) {
       // ユーザーメッセージをthread変数に追加
       thread.messages.push(userMessage);
       console.log("thread")
       console.log(thread)
 
       // 一旦ユーザーメッセージを保存
       thread.updatedAt = new Date().toISOString();
       await helpers.writeThread(threadId, thread);
 
       // Responses APIの形式に合わせる
       conversationHistory = thread.messages.map(m => ({
         role: m.role,
         content: m.content
       }));
     } else {
       console.log("thread")
       console.log(thread)
 
       // Responses APIの形式に合わせる
       conversationHistory = thread.messages.map(m => ({
         role: m.role,
         content: m.content
       }));
       conversationHistory.push({role: userMessage.role, content: userMessage.content});
     }
 
      console.log(`Sending request to ${selectedModel}...`);

      // カスタムツールの定義
      const tools = [
        {
          type: "function",
          name: "create_artifact",
          description: "Create a new artifact (file) with the given filename and content. Use this when the user asks to create a file or when you want to save code/content as an artifact.",
          parameters: {
            type: "object",
            properties: {
              filename: {
                type: "string",
                description: "The name of the file to create (e.g., script.js, style.css, document.md)"
              },
              content: {
                type: "string",
                description: "The complete content of the artifact"
              },
              description: {
                type: "string",
                description: "A brief description of what this artifact contains"
              }
            },
            required: ["filename", "content"]
          }
        },
        {
          type: "function",
          name: "replace_artifact",
          description: "Replace whole content of an existing artifact by providing its ID and the new content. Use this when the user asks to modify an existing artifact.",
          parameters: {
            type: "object",
            properties: {
              artifact_id: {
                type: "string",
                description: "The ID of the artifact to edit"
              },
              content: {
                type: "string",
                description: "The new complete content for the artifact"
              },
              description: {
                type: "string",
                description: "Updated description of what this artifact contains"
              }
            },
            required: ["artifact_id", "content"]
          }
        },
        {
          type: "function",
          name: "read_artifact",
          description: "Read the contents of an existing artifact. For large files, you can read specific portions (top/bottom lines) instead of the entire file.",
          parameters: {
            type: "object",
            properties: {
              artifact_id: {
                type: "string",
                description: "The ID of the artifact to read"
              },
              version: {
                type: "integer",
                description: "Specific version to read. Defaults to the latest version."
              },
              encoding: {
                type: "string",
                enum: ["utf-8", "base64"],
                description: "Encoding for the returned content. Defaults to utf-8; use base64 for binary files."
              },
              range: {
                type: "string",
                enum: ["all", "top", "bottom"],
                description: "Which part of the file to read. 'all' returns entire file, 'top' returns first N lines, 'bottom' returns last N lines. Defaults to 'all'."
              },
              line_count: {
                type: "integer",
                description: "Number of lines to read when range is 'top' or 'bottom'. Required when range is not 'all'. Must be positive.",
                minimum: 1
              }
            },
            required: ["artifact_id"]
          }
        },
        {
          type: "function",
          name: "patch_artifact",
          description: `Edit specific parts of an artifact using pattern matching. This is more efficient than reading the entire file.
Supports multiple edits in a single call.
edit_type options:
- "replace": Replace content between start_pattern and end_pattern
- "delete": Delete content between start_pattern and end_pattern
- "insert_before": Insert new_content before start_pattern
- "insert_after": Insert new_content after start_pattern

Patterns are matched with normalized whitespace (consecutive spaces/newlines treated as single space).
If start_pattern matches multiple locations, the operation is applied to all matches.`,
          parameters: {
            type: "object",
            properties: {
              artifact_id: {
                type: "string",
                description: "The ID of the artifact to edit"
              },
              edits: {
                type: "array",
                description: "Array of edit operations to apply",
                items: {
                  type: "object",
                  properties: {
                    edit_type: {
                      type: "string",
                      enum: ["replace", "delete", "insert_before", "insert_after"],
                      description: "Type of edit operation"
                    },
                    start_pattern: {
                      type: "string",
                      description: "Pattern to match the start position (whitespace normalized)"
                    },
                    end_pattern: {
                      type: "string",
                      description: "Pattern to match the end position (required for replace/delete)"
                    },
                    new_content: {
                      type: "string",
                      description: "New content to insert or replace with (required for replace/insert_*)"
                    }
                  },
                  required: ["edit_type", "start_pattern"]
                }
              }
            },
            required: ["artifact_id", "edits"]
          }
        },
        {
          type: "function",
          name: "search_in_artifact",
          description: "Search for patterns in an artifact and return matching sections with context lines. Useful for locating specific code or content in large files. Whitespace in patterns is normalized (consecutive spaces/tabs/newlines treated as single space).",
          parameters: {
            type: "object",
            properties: {
              artifact_id: {
                type: "string",
                description: "The ID of the artifact to search"
              },
              version: {
                type: "integer",
                description: "Specific version to search. Defaults to the latest version."
              },
              search_pattern: {
                type: "string",
                description: "Pattern to search for. Whitespace is normalized, so 'function\\n\\nfoo' will match 'function foo'."
              },
              context_before: {
                type: "integer",
                description: "Number of lines to include before each match",
                default: 2,
                minimum: 0
              },
              context_after: {
                type: "integer",
                description: "Number of lines to include after each match",
                default: 2,
                minimum: 0
              },
              max_matches: {
                type: "integer",
                description: "Maximum number of matches to return. Defaults to 10 to avoid overwhelming responses.",
                default: 10,
                minimum: 1
              }
            },
            required: ["artifact_id", "search_pattern"]
          }
        }
      ];

      let allToolCalls = [];
      let maxIterations = 10; // 無限ループ防止
      let iteration = 0;
      let finalResponse;

      // 処理時間の計測開始
      const startTime = Date.now();

      // ツール実行ループ
      while (iteration < maxIterations) {
        iteration++;
        console.log(`\n🔄 Iteration ${iteration}/${maxIterations}`);

        const requestParams = {
          model: selectedModel,
          input: [
            { role: 'developer', content: developerPrompt },
            ...conversationHistory
          ],
          tools: tools,
          tool_choice: "auto",
          parallel_tool_calls: true
        };

        // Reasoningモデルの場合のみreasoningパラメータを追加
        if (helpers.isReasoningModel(selectedModel)) {
          requestParams.reasoning = {
            effort: reasoningEffort || "medium",
            summary: "auto",
          };
        }

        // JSON Schema対応
        if (responseFormat && responseFormat.schema) {
          requestParams.text = {
            format: {
              name: responseFormat.name || "custom_response_schema",
              type: "json_schema",
              description: responseFormat.description || "Custom response schema",
              strict: responseFormat.strict !== undefined ? responseFormat.strict : false,
              schema: responseFormat.schema
            }
          };
        }
        console.log(responseFormat);

        const response = await client.responses.create(requestParams);
        console.log(requestParams);
        console.log(response);

        console.log(`Received response from ${selectedModel}`);
        
        // トークン使用量のログ記録
        if (response.usage) {
          console.log('\n--- トークン使用量 ---');
          console.log(`入力トークン: ${response.usage.input_tokens}`);
          console.log(`出力トークン: ${response.usage.output_tokens}`);
          console.log(`合計トークン: ${response.usage.total_tokens}`);
          console.log('---------------------\n');
          await helpers.logTokenUsage(selectedModel, response.usage, req.user.user_id);
        }

        // レスポンス構造の取得
        let toolCallsInThisIteration = [];
        let hasToolCalls = false;
        
        if (response.output && Array.isArray(response.output)) {
          console.log('\n--- レスポンス解析開始 ---');
          
          // outputから各タイプのアイテムを処理
          for (const item of response.output) {
            console.log(`\n📦 Output Item: Type=${item.type}, ID=${item.id}`);

            // OpenAI API の出力を会話履歴に追加
            conversationHistory.push(item)

            // Web検索の情報を抽出
            if (item.type === 'web_search_call') {
              console.log('🔍 Web検索検出');
              // Web検索は記録のみ（実行済み）
              allToolCalls.push({
                type: 'web_search',
                query: item.action?.query
              });
            }
            
            // ツール使用の検出 (tool_use または function_call)
            if (item.type === 'tool_use' || item.type === 'function_call') {
              hasToolCalls = true;
              console.log(`🔧 ツール使用検出: ${item.name}`);

              // argumentsをパース
              let toolInput;
              if (item.type === 'function_call') {
                console.log(`  Arguments (raw): ${item.arguments}`);
                try {
                  toolInput = JSON.parse(item.arguments);
                  console.log(`  Arguments (parsed):`, JSON.stringify(toolInput, null, 2));
                } catch (e) {
                  console.error(`  ❌ Failed to parse arguments:`, e);
                  continue;
                }
              } else {
                toolInput = item.input;
              }
              
              // ツール実行結果
              let toolResult = null;
              
              // Artifact作成ツール
              if (item.name === 'create_artifact') {
                try {
                  console.log('  📝 Creating artifact...');
                  const record = await helpers.createArtifactRecord({
                    filename: toolInput.filename,
                    content: toolInput.content,
                    metadata: { description: toolInput.description || '' },
                    threadId
                  });
                  console.log(`  ✅ Artifact created: ${record.artifactId} (${record.displayFilename})`);

                  toolResult = {
                    success: true,
                    artifactId: record.artifactId,
                    filename: record.displayFilename,
                    storageFilename: record.filename,
                    fileContent: toolInput.content,
                    version: record.version,
                    message: `Successfully created artifact: ${record.displayFilename}`
                  };
                  
                  allToolCalls.push({
                    type: 'create_artifact',
                    name: item.name,
                    input: toolInput,
                    result: toolResult
                  });
                } catch (error) {
                  console.error('  ❌ Failed to create artifact:', error);
                  toolResult = {
                    success: false,
                    error: error.message
                  };
                  
                  allToolCalls.push({
                    type: 'create_artifact',
                    name: item.name,
                    input: toolInput,
                    error: error.message
                  });
                }
              }
              
              // Artifact編集ツール
              if (item.name === 'replace_artifact') {
                try {
                  console.log('  ✏️ Editing artifact...');
                  const record = await helpers.appendArtifactVersion({
                    artifactId: toolInput.artifact_id,
                    content: toolInput.content,
                    metadata: { description: toolInput.description || '' }
                  });

                  console.log(`  ✅ Artifact edited: ${record.artifactId} (v${record.version})`);
                  
                  toolResult = {
                    success: true,
                    artifactId: record.artifactId,
                    filename: record.displayFilename,
                    storageFilename: record.filename,
                    version: record.version,
                    fileContent: toolInput.content,
                    message: `Successfully updated artifact to version ${record.version}`
                  };

                  allToolCalls.push({
                    type: 'replace_artifact',
                    name: item.name,
                    input: toolInput,
                    result: toolResult
                  });
                } catch (error) {
                  console.error('  ❌ Failed to edit artifact:', error);
                  toolResult = {
                    success: false,
                    error: error.message
                  };
                  
                  allToolCalls.push({
                    type: 'replace_artifact',
                    name: item.name,
                    input: toolInput,
                    error: error.message
                  });
                }
              }
              
              // Artifact読み取りツール
              if (item.name === 'read_artifact') {
                try {
                  console.log('  📖 Reading artifact...');
                  const artifactId = toolInput.artifact_id;
                  const requestedVersion = typeof toolInput.version === 'number' ? toolInput.version : null;
                  const encoding = toolInput.encoding === 'base64' ? 'base64' : 'utf-8';
                  const range = toolInput.range || 'all';
                  const lineCount = toolInput.line_count;

                  // バリデーション
                  if ((range === 'top' || range === 'bottom') && !lineCount) {
                    throw new Error('line_count is required when range is "top" or "bottom"');
                  }
                  
                  if (lineCount && lineCount < 1) {
                    throw new Error('line_count must be a positive integer');
                  }

                  const artifactDir = path.join(configs.ARTIFACTS_DIR, artifactId);
                  const metadataPath = path.join(artifactDir, 'metadata.json');
                  const metadataContent = await fs.readFile(metadataPath, 'utf-8');
                  const artifactMetadata = JSON.parse(metadataContent);

                  const versionData = requestedVersion
                    ? artifactMetadata.versions.find(v => v.version === requestedVersion)
                    : artifactMetadata.versions.at(-1);

                  if (!versionData) {
                    throw new Error(
                      requestedVersion
                        ? `Artifact version ${requestedVersion} not found`
                        : 'No versions found for artifact'
                    );
                  }

                  const filePath = path.join(artifactDir, versionData.filename);
                  const fileBuffer = await fs.readFile(filePath);
                  
                  let fileContent;
                  let totalLines = null;
                  let returnedLines = null;
                  let isTruncated = false;
                  
                  if (encoding === 'base64') {
                    // バイナリファイルの場合はrangeオプションは適用されない
                    fileContent = fileBuffer.toString('base64');
                    if (range !== 'all') {
                      console.warn('range option is ignored for base64 encoding');
                    }
                  } else {
                    const fullContent = fileBuffer.toString('utf-8');
                    const lines = fullContent.split('\n');
                    totalLines = lines.length;
                    
                    if (range === 'all') {
                      fileContent = fullContent;
                      returnedLines = totalLines;
                    } else if (range === 'top') {
                      const selectedLines = lines.slice(0, lineCount);
                      fileContent = selectedLines.join('\n');
                      returnedLines = selectedLines.length;
                      isTruncated = totalLines > lineCount;
                    } else if (range === 'bottom') {
                      const startIndex = Math.max(0, totalLines - lineCount);
                      const selectedLines = lines.slice(startIndex);
                      fileContent = selectedLines.join('\n');
                      returnedLines = selectedLines.length;
                      isTruncated = totalLines > lineCount;
                    }
                  }

                  toolResult = {
                    success: true,
                    artifactId,
                    filename: artifactMetadata.filename,
                    version: versionData.version,
                    encoding,
                    content: fileContent,
                    range,
                    totalLines,
                    returnedLines,
                    isTruncated,
                    metadata: versionData.metadata ?? {},
                    message: `Successfully read artifact ${artifactMetadata.filename} (v${versionData.version})${
                      range !== 'all' ? ` - ${range} ${returnedLines} of ${totalLines} lines` : ''
                    }`,
                  };

                  allToolCalls.push({
                    type: 'read_artifact',
                    name: item.name,
                    input: toolInput,
                    result: toolResult
                  });

                  console.log(`  ✅ Artifact read: ${artifactId} (v${versionData.version})`);
                } catch (error) {
                  console.error('  ❌ Failed to read artifact:', error);
                  toolResult = {
                    success: false,
                    error: error.message
                  };

                  allToolCalls.push({
                    type: 'read_artifact',
                    name: item.name,
                    input: toolInput,
                    error: error.message
                  });
                }
              }

              // patch_artifactツール
              if (item.name === 'patch_artifact') {
                try {
                  console.log('  🔧 Patching artifact...');
                  const artifactId = toolInput.artifact_id;
                  const edits = toolInput.edits;
                  
                  // 現在のアーティファクトを読み込む
                  const artifactDir = path.join(configs.ARTIFACTS_DIR, artifactId);
                  const metadataPath = path.join(artifactDir, 'metadata.json');
                  const metadataContent = await fs.readFile(metadataPath, 'utf-8');
                  const artifactMetadata = JSON.parse(metadataContent);
                  
                  const latestVersion = artifactMetadata.versions.at(-1);
                  if (!latestVersion) {
                    throw new Error('No versions found for artifact');
                  }
                  
                  const filePath = path.join(artifactDir, latestVersion.filename);
                  const originalContent = await fs.readFile(filePath, 'utf-8');
                  
                  // パッチを適用
                  const patchedContent = helpers.applyPatches(originalContent, edits);
                  
                  // 新しいバージョンとして保存
                  const record = await helpers.appendArtifactVersion({
                    artifactId,
                    content: patchedContent,
                    metadata: { 
                      description: `Patched with ${edits.length} edit(s)`,
                      patchSummary: edits.map(e => e.edit_type).join(', ')
                    }
                  });
                  
                  console.log(`  ✅ Artifact patched: ${record.artifactId} (v${record.version})`);
                  
                  toolResult = {
                    success: true,
                    artifactId: record.artifactId,
                    filename: record.displayFilename,
                    version: record.version,
                    editsApplied: edits.length,
                    stats: {
                      originalLines: originalContent.split('\n').length,
                      newLines: patchedContent.split('\n').length,
                      linesDiff: patchedContent.split('\n').length - originalContent.split('\n').length
                    },
                    message: `Successfully patched artifact with ${edits.length} edit(s). New version: ${record.version}`
                  };
                  
                  allToolCalls.push({
                    type: 'patch_artifact',
                    name: item.name,
                    input: toolInput,
                    result: toolResult
                  });
                } catch (error) {
                  console.error('  ❌ Failed to patch artifact:', error);
                  toolResult = {
                    success: false,
                    error: error.message
                  };
                  
                  allToolCalls.push({
                    type: 'patch_artifact',
                    name: item.name,
                    input: toolInput,
                    error: error.message
                  });
                }
              }

              if (item.name === 'search_in_artifact') {
                try{    
                  console.log('  🔍 Searching in artifact...');
                  const artifactId = toolInput.artifact_id;
                  const requestedVersion = typeof toolInput.version === 'number' ? toolInput.version : null;
                  const searchPattern = toolInput.search_pattern;
                  const contextBefore = toolInput.context_before ?? 2;
                  const contextAfter = toolInput.context_after ?? 2;
                  const maxMatches = toolInput.max_matches ?? 10;

                  if (!searchPattern || searchPattern.trim().length === 0) {
                    throw new Error('search_pattern must be a non-empty string');
                  }

                  const artifactDir = path.join(configs.ARTIFACTS_DIR, artifactId);
                  const metadataPath = path.join(artifactDir, 'metadata.json');
                  const metadataContent = await fs.readFile(metadataPath, 'utf-8');
                  const artifactMetadata = JSON.parse(metadataContent);

                  const versionData = requestedVersion
                    ? artifactMetadata.versions.find(v => v.version === requestedVersion)
                    : artifactMetadata.versions.at(-1);

                  if (!versionData) {
                    throw new Error(
                      requestedVersion
                        ? `Artifact version ${requestedVersion} not found`
                        : 'No versions found for artifact'
                    );
                  }

                  const filePath = path.join(artifactDir, versionData.filename);
                  const content = await fs.readFile(filePath, 'utf-8');
                  
                  // findAllMatchesを再利用（既存のpatch_artifact用関数）
                  const matches = helpers.findAllMatches(content, searchPattern);
                  
                  // 行単位の情報を構築
                  const lines = content.split('\n');
                  const results = [];
                  
                  for (let i = 0; i < Math.min(matches.length, maxMatches); i++) {
                    const match = matches[i];
                    
                    // マッチ位置を行番号に変換
                    const beforeMatch = content.slice(0, match.startOffset);
                    const matchStartLine = beforeMatch.split('\n').length - 1; // 0-indexed
                    const matchText = content.slice(match.startOffset, match.endOffset);
                    const matchLineCount = matchText.split('\n').length;
                    const matchEndLine = matchStartLine + matchLineCount - 1; // 0-indexed
                    
                    // コンテキスト行を含めた範囲を計算
                    const startLine = Math.max(0, matchStartLine - contextBefore);
                    const endLine = Math.min(lines.length - 1, matchEndLine + contextAfter);
                    
                    const contextLines = lines.slice(startLine, endLine + 1);
                    
                    results.push({
                      matchIndex: i + 1,
                      lineRange: {
                        start: startLine + 1, // 1-based line numbers for display
                        end: endLine + 1,
                        matchStart: matchStartLine + 1,
                        matchEnd: matchEndLine + 1
                      },
                      content: contextLines.join('\n'),
                      matchedText: match.text,
                      // マッチ位置を示すマーカー（オプション）
                      contextInfo: `Lines ${startLine + 1}-${endLine + 1} (match at ${matchStartLine + 1}-${matchEndLine + 1})`
                    });
                  }
                  
                  console.log(`  ✅ Searched in artifact: ${searchPattern} are found in ${artifactId} (v${versionData.version}) x${results.length}`);

                  toolResult = {
                    success: true,
                    artifactId,
                    filename: artifactMetadata.filename,
                    version: versionData.version,
                    searchPattern,
                    totalMatches: matches.length,
                    returnedMatches: results.length,
                    hasMoreMatches: matches.length > maxMatches,
                    matches: results,
                    message: `Found ${matches.length} match(es) for pattern in ${artifactMetadata.filename}${
                      matches.length > maxMatches ? ` (showing first ${maxMatches})` : ''
                    }`
                  };
                  
                  allToolCalls.push({
                    type: 'search_in_artifact',
                    name: item.name,
                    input: toolInput,
                    result: toolResult
                  });
                } catch (error) {
                  console.error('  ❌ Failed to search in artifact:', error);
                  toolResult = {
                    success: false,
                    error: error.message
                  };
                  
                  allToolCalls.push({
                    type: 'search_in_artifact',
                    name: item.name,
                    input: toolInput,
                    error: error.message
                  });
                }
              }

              // ツール結果を会話履歴に追加
              if (toolResult) {
                toolCallsInThisIteration.push({
                  call_id: item.call_id || item.id,
                  name: item.name,
                  result: toolResult
                });
              }
            }
          }
          
          console.log('\n--- レスポンス解析完了 ---');
        }

        // create/edit artifactツール呼び出しがあった場合、スレッドの派生状態を更新
        if (toolCallsInThisIteration.some(call => ['create_artifact', 'replace_artifact'].includes(call.name))) {
          await helpers.refreshThreadDerivedState(thread, { persist: true });
        }

        // ツール呼び出しがあった場合、結果を会話履歴に追加して再度呼び出し
        if (hasToolCalls && toolCallsInThisIteration.length > 0) {
          console.log(`\n🔁 ツール実行完了。結果をモデルに返します...`);

          // ツール結果を追加
          for (const toolCall of toolCallsInThisIteration) {
            conversationHistory.push({
              type: "function_call_output",
              call_id: toolCall.call_id,
              output: JSON.stringify(toolCall.result)
            });
          }
          
          // 次のイテレーションへ
          continue;
        }
        
        // ツール呼び出しがない場合、最終レスポンスを取得
        finalResponse = response;

        // 処理時間の計測終了
        console.log(`⏱️  Elapsed time: ${(Date.now() - startTime) / 1000}s`);
        break;
      }

      // 最終レスポンスからテキストを抽出
      let responseText = finalResponse?.output_text || '';
      
      if (!responseText || responseText.trim().length === 0) {
        // output配列からメッセージを探す
        if (finalResponse?.output && Array.isArray(finalResponse.output)) {
          for (const item of finalResponse.output) {
            if (item.type === 'message' && item.content) {
              for (const content of item.content) {
                if (content.type === 'text' && content.text) {
                  responseText += content.text;
                }
              }
            }
          }
        }
      }

      // レスポンステキストの最終確認
      if (!responseText || responseText.trim().length === 0) {
        if (allToolCalls.length > 0) {
          console.log('ℹ️ Info: No text response after tool execution');
          const toolNames = allToolCalls.map(tc => tc.name || tc.type).join(', ');
          responseText = `[Executed: ${toolNames}]`;
        } else {
          console.warn('⚠️ Warning: No response text found in output');
          responseText = 'No response text found';
        }
      }

      // システムプロンプトをバージョン管理システムに登録
      const systemPromptHash = await helpers.registerSystemPrompt(developerPrompt);

      // Response Formatをバージョン管理システムに登録
      if (responseFormat) {
        const responseFormatHash = await helpers.registerResponseFormat(responseFormat);
        thread.responseFormatHash = responseFormatHash;
      }

      // Reasoning Effortを保存
      if (reasoningEffort) {
        thread.reasoningEffort = reasoningEffort;
      }

      // Usage情報の拡張
      const rawUsage = finalResponse?.usage || {};
      const inputTokens = rawUsage.input_tokens || 0;
      const outputTokens = rawUsage.output_tokens || 0;
      const totalTokens = rawUsage.total_tokens || (inputTokens + outputTokens);
      const isHighCostModel = configs.AVAILABLE_MODELS_HIGH_COST.includes(selectedModel);
      const tokenCostRate = isHighCostModel ? configs.TOKEN_COST_HIGH : configs.TOKEN_COST_LOW;
      const creditsUsed = totalTokens * tokenCostRate;

      // アシスタントの応答を追加
      assistantMessage = {
        id: helpers.generateId(),
        role: 'assistant',
        content: responseText || 'No response',
        model: selectedModel,
        timestamp: new Date().toISOString(),
        toolCalls: allToolCalls.length > 0 ? allToolCalls : undefined,
        usage: {
          inputTokens,
          outputTokens,
          totalTokens,
          creditsUsed,
          isHighCost: isHighCostModel,
          tokenCostRate,
          systemPromptHash,
          raw: rawUsage  // 元のusage情報も保持
        }
      };
      
      console.log('📨 Final assistant message:', {
        contentLength: assistantMessage.content.length,
        hasToolCalls: !!assistantMessage.toolCalls,
        toolCallsCount: assistantMessage.toolCalls?.length || 0,
        iterations: iteration
      });
    } catch (apiError) {
      console.error(`${selectedModel} API Error:`, apiError);
      // エラーの場合でもエラーメッセージを返す
      assistantMessage = {
        id: helpers.generateId(),
        role: 'assistant',
        content: `エラーが発生しました: ${apiError.message}`,
        model: selectedModel,
        timestamp: new Date().toISOString()
      };
    }
    
    thread.messages.push(assistantMessage);
    
    // スレッドを更新
    thread.updatedAt = new Date().toISOString();
    await helpers.writeThread(threadId, thread);
    
    // スレッド一覧の更新時刻も更新
    const threads = await helpers.readThreads();
    const threadIndex = threads.threads.findIndex(t => t.id === threadId);
    if (threadIndex !== -1) {
      threads.threads[threadIndex].updatedAt = thread.updatedAt;
      await helpers.writeThreads(threads);
    }
    
    res.json({
      userMessage,
      assistantMessage,
      thread: {
        id: thread.id,
        messageCount: thread.messages.length,
        model: selectedModel
      }
    });
  } catch (error) {
    console.error('Error in message endpoint:', error);
    res.status(500).json({ 
      error: error.message,
      details: error.stack 
    });
  }
});

// メッセージ履歴取得
app.get('/api/threads/:threadId/messages', requireAuth, async (req, res) => {
  try {
    const { threadId } = req.params;
    const thread = await helpers.readThread(threadId);
    
    if (!thread) {
      return res.status(404).json({ error: 'Thread not found' });
    }
    
    res.json({ messages: thread.messages });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// メッセージ追加のみ（応答なし・グループスレッド用）
app.post('/api/threads/:threadId/messages/append', requireAuth, async (req, res) => {
  try {
    const { threadId } = req.params;
    const { role, content, metadata } = req.body;

    if (!content || !content.trim()) {
      return res.status(400).json({ error: 'Message content is required' });
    }

    if (!role || !['user', 'assistant'].includes(role)) {
      return res.status(400).json({ error: 'Valid role (user or assistant) is required' });
    }

    const thread = await helpers.readThread(threadId);
    if (!thread) {
      return res.status(404).json({ error: 'Thread not found' });
    }

    const newMessage = {
      id: helpers.generateId(),
      role,
      content: content.trim(),
      timestamp: new Date().toISOString()
    };

    // メタデータがある場合は追加（グループスレッド用）
    if (metadata) {
      newMessage.metadata = metadata;
    }

    thread.messages.push(newMessage);
    thread.updatedAt = new Date().toISOString();

    await helpers.writeThread(threadId, thread);

    res.json({
      message: newMessage,
      thread: {
        id: thread.id,
        messageCount: thread.messages.length,
        updatedAt: thread.updatedAt
      }
    });
  } catch (error) {
    console.error('[Append Message Error]:', error);
    res.status(500).json({ error: error.message });
  }
});

// ====================
// メッセージ使用統計 API
// ====================

// メッセージの使用統計を取得
app.get('/api/threads/:threadId/messages/:messageId/usage', requireAuth, async (req, res) => {
  try {
    const { threadId, messageId } = req.params;
    const thread = await helpers.readThread(threadId);
    
    if (!thread) {
      return res.status(404).json({ error: 'Thread not found' });
    }
    
    const message = thread.messages.find(m => m.id === messageId);
    
    if (!message) {
      return res.status(404).json({ error: 'Message not found' });
    }
    
    // assistantメッセージのみusage情報を持つ
    if (message.role !== 'assistant' || !message.usage) {
      return res.status(404).json({ error: 'Usage information not available for this message' });
    }
    
    res.json({
      messageId: message.id,
      timestamp: message.timestamp,
      model: message.model,
      usage: message.usage
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// システムプロンプトの取得
app.get('/api/system-prompts/:hash', requireAuth, async (req, res) => {
  try {
    const { hash } = req.params;
    const prompt = await helpers.getSystemPrompt(hash);
    
    if (!prompt) {
      return res.status(404).json({ error: 'System prompt not found' });
    }
    
    res.json(prompt);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ====================
// アーティファクト管理 API
// ====================

// アーティファクト作成
app.post('/api/artifacts', requireAuth, async (req, res) => {
  try {
    const { filename, content, metadata, threadId } = req.body;
    const result = await helpers.createArtifactRecord({
      filename,
      content,
      metadata: metadata || {},
      threadId: threadId || null
    });
    res.status(201).json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// アーティファクト取得(最新版)
app.get('/api/artifacts/:artifactId', requireAuth, async (req, res) => {
  try {
    const { artifactId } = req.params;
    const artifactDir = path.join(configs.ARTIFACTS_DIR, artifactId);
    const metadataPath = path.join(artifactDir, 'metadata.json');
    
    const metadataContent = await fs.readFile(metadataPath, 'utf-8');
    const metadata = JSON.parse(metadataContent);
    
    const latestVersion = metadata.versions[metadata.versions.length - 1];
    const filePath = path.join(artifactDir, latestVersion.filename);
    const content = await fs.readFile(filePath, 'utf-8');
    
    res.json({
      id: artifactId,
      filename: metadata.filename,
      version: latestVersion.version,
      content,
      metadata: latestVersion.metadata,
      createdAt: latestVersion.createdAt
    });
  } catch (error) {
    res.status(404).json({ error: 'Artifact not found' });
  }
});

// アーティファクト取得(特定バージョン)
app.get('/api/artifacts/:artifactId/v:version', requireAuth, async (req, res) => {
  try {
    const { artifactId, version } = req.params;
    const artifactDir = path.join(configs.ARTIFACTS_DIR, artifactId);
    const metadataPath = path.join(artifactDir, 'metadata.json');
    
    const metadataContent = await fs.readFile(metadataPath, 'utf-8');
    const metadata = JSON.parse(metadataContent);
    
    const versionData = metadata.versions.find(v => v.version === parseInt(version));
    if (!versionData) {
      return res.status(404).json({ error: 'Version not found' });
    }
    
    const filePath = path.join(artifactDir, versionData.filename);
    const content = await fs.readFile(filePath, 'utf-8');
    
    res.json({
      id: artifactId,
      filename: metadata.filename,
      version: versionData.version,
      content,
      metadata: versionData.metadata,
      createdAt: versionData.createdAt
    });
  } catch (error) {
    res.status(404).json({ error: 'Artifact or version not found' });
  }
});

// アーティファクト編集(新バージョン作成)
app.put('/api/artifacts/:artifactId', requireAuth, async (req, res) => {
  try {
    const { content, metadata } = req.body ?? {};

    if (typeof content === 'undefined') {
      return res.status(400).json({ error: 'content is required' });
    }

    const result = await helpers.appendArtifactVersion({
      artifactId: req.params.artifactId,
      content,
      metadata: metadata || {}
    });

    res.json(result);
  } catch (error) {
    console.error('[appendArtifactVersion] failed:', error);
    res.status(404).json({ error: 'Artifact not found', details: error.message });
  }
});

// アーティファクト削除
app.delete('/api/artifacts/:artifactId', requireAuth, async (req, res) => {
  try {
    const { artifactId } = req.params;
    const artifactDir = path.join(configs.ARTIFACTS_DIR, artifactId);
    const metadata = await helpers.readArtifactMetadata(req.params.artifactId).catch(() => null);

    // ディレクトリを削除
    await fs.rm(artifactDir, { recursive: true, force: true });
    await helpers.updateThreadAfterArtifactChange(metadata?.threadId);

    res.json({ message: 'Artifact deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// アーティファクト一覧取得
app.get('/api/artifacts', requireAuth, async (req, res) => {
  try {
    const { threadId } = req.query;
    const artifactDirs = await fs.readdir(configs.ARTIFACTS_DIR);
    const artifacts = [];
    
    // threadIdがクエリにないなら即座に空配列を返す
    if (!threadId) {
      return res.json({ artifacts: [] });
    }

    for (const dir of artifactDirs) {
      const metadataPath = path.join(configs.ARTIFACTS_DIR, dir, 'metadata.json');
      try {
        const metadataContent = await fs.readFile(metadataPath, 'utf-8');
        const metadata = JSON.parse(metadataContent);
        
        // threadIdが指定されている場合はフィルタリング
        if (threadId && metadata.threadId !== threadId) {
          continue;
        }
        
        artifacts.push({
          id: metadata.id,
          filename: metadata.filename,
          threadId: metadata.threadId,
          currentVersion: metadata.currentVersion,
          versionCount: metadata.versions.length,
          createdAt: metadata.createdAt,
          updatedAt: metadata.updatedAt
        });
      } catch (e) {
        continue;
      }
    }
    
    res.json({ artifacts });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 複数ファイルアップロード
app.post('/api/artifacts/upload', requireAuth, upload.array('files'), async (req, res) => {
  try {
    if (!req.files?.length) {
      return res.status(400).json({ error: 'ファイルが添付されていません。' });
    }

    const threadId = req.body.threadId || null;
    const metadataPayload = req.body.metadata ? JSON.parse(req.body.metadata) : {};

    const results = [];
    for (const file of req.files) {
      try {
        const decodedName = helpers.decodeMulterFilename(file.originalname);
        const safeFilename = helpers.sanitizeFilename(decodedName);
        const fileMetadata = metadataPayload[decodedName] ?? metadataPayload[file.originalname] ?? {};
        // const fileMetadata = metadataPayload[file.originalname] || {};
        const record = await helpers.createArtifactRecord({
          filename: safeFilename,
          // filename: file.originalname,
          content: file.buffer,
          metadata: fileMetadata,
          threadId
        });
        results.push({
          ...record,
          originalName: decodedName
        });
      } catch (fileError) {
        results.push({
          originalName: helpers.decodeMulterFilename(file.originalname),
          error: fileError.message
        });
      }
    }

    const hasError = results.some(result => result.error);
    res.status(hasError ? 207 : 201).json({ results });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ====================
// 認証・ユーザー管理 API
// ====================

// ユーザー情報取得
app.get('/api/auth/me', requireAuth, async (req, res) => {
  try {
    res.json({ 
      user: req.user,
      creditMaxDisplay: configs.CREDIT_MAX_DISPLAY
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ログイン（認証テスト）
app.post('/api/auth/login', async (req, res) => {
  try {
    const { userId, password, groupId, botUserId, guildId, guildToken } = req.body;
    
    let user = null;
    let authType = null;

    // Bot認証（Discord Bot専用）
    if (botUserId && guildId && guildToken) {
      authType = 'bot';
      
      // 環境変数から期待されるBOT_USER_IDを取得
      const expectedBotUserId = process.env.BOT_USER_ID || 'discord-bot';

      // 1. BOT_USER_IDの厳密一致チェック
      if (botUserId !== expectedBotUserId) {
        console.warn(`[Auth] Invalid bot user ID attempted: ${botUserId}`);
        return res.status(401).json({ error: 'Invalid bot credentials' });
      }

      // 2. guild-manager.jsの関数をインポートして使用
      const guildManager = await import('./discord-bot/guild-manager.js');
      
      // 3. guildTokenの検証（HMAC-SHA256）
      if (!guildManager.verifyGuildAuthToken(guildId, guildToken)) {
        console.warn(`[Auth] Invalid guild token for guild: ${guildId}`);
        return res.status(401).json({ error: 'Invalid guild credentials' });
      }

      // 4. guildIdがguilds.jsonに存在し、有効化されているか確認
      if (!guildManager.isGuildEnabled(guildId)) {
        console.warn(`[Auth] Guild not enabled: ${guildId}`);
        return res.status(403).json({ error: 'Guild not enabled' });
      }

      // 5. Botユーザーがデータベースに存在するか確認
      user = await auth.getUser(botUserId);
      
      if (!user) {
        console.error(`[Auth] Bot user ${botUserId} not found in database`);
        return res.status(401).json({ error: 'Bot user not configured' });
      }
      
      console.log(`[Auth] Bot authenticated for guild: ${guildId}`);
    }
    // グループID認証
    else if (userId && groupId) {
      authType = 'group';
      user = await auth.authenticateWithGroup(userId, groupId);
    }
    // パスワード認証
    else if (userId && password) {
      authType = 'password';
      user = await auth.authenticateWithPassword(userId, password);
    }
    else {
      return res.status(400).json({ 
        error: 'Invalid authentication parameters. Provide one of: (userId + password), (userId + groupId), or (botUserId + guildId + guildToken)' 
      });
    }

    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // JWTトークンを生成
    const token = helpers.createAccessToken(user);

    // Bot認証の場合は24時間の有効期限を明示
    const response = { 
      success: true,
      user,
      token
    };
    
    if (authType === 'bot') {
      response.expiresIn = 86400; // 24時間（秒）
      response.authType = 'bot';
      response.guildId = guildId;
    } else {
      response.authType = authType;
    }

    res.json(response);
  } catch (error) {
    if (error.message.includes('stopped') || error.message.includes('banned')) {
      return res.status(403).json({ error: error.message });
    }
    console.error('[Auth] Login error:', error);
    res.status(401).json({ error: 'Authentication failed' });
  }
});

// パスワード変更
app.post('/api/auth/change-password', requireAuth, async (req, res) => {
  try {
    const { oldPassword, newPassword } = req.body;
    
    if (!oldPassword || !newPassword) {
      return res.status(400).json({ error: 'Old and new passwords required' });
    }

    await auth.changePassword(req.user.user_id, oldPassword, newPassword);
    
    res.json({ 
      success: true,
      message: 'Password changed successfully'
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// クレジット情報取得
app.get('/api/auth/credit-info', requireAuth, async (req, res) => {
  try {
    const creditInfo = await auth.getCreditInfo(req.user.user_id);
    
    if (!creditInfo) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    res.json(creditInfo);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ====================
// Discord用 API
// ====================

// OAuth2フロー開始エンドポイント
app.get('/auth/discord/login', (req, res) => {
  try {
    const guildId = req.query.guildId;
    const returnUrl = req.query.returnUrl || '/';
    
    // stateを生成して保存（10分間有効）
    const state = stateManager.generateState(
      null, // この時点ではuserIdは不明
      { 
        guildId,
        returnUrl,
        timestamp: Date.now()
      },
      10 // 10分間有効
    );
    
    const params = new URLSearchParams({
      client_id: configs.DISCORD_CONFIG.CLIENT_ID,
      redirect_uri: configs.DISCORD_CONFIG.CALLBACK_URL,
      response_type: 'code',
      scope: 'identify email guilds bot openid',
      permissions: PermissionFlagsBits.Administrator,
      state: state
    });
    // permissions の設定方法は以下。力技ならAdministratorでいい。
    // console.log(PermissionFlagsBits.ManageChannels + PermissionFlagsBits.ViewChannel + PermissionFlagsBits.SendMessages + PermissionFlagsBits.EmbedLinks + PermissionFlagsBits.ReadMessageHistory + PermissionFlagsBits.AttachFiles);
    // console.log(PermissionFlagsBits.Administrator);

    // scope の 種類はここを参照 https://discord.com/developers/docs/topics/oauth2
    // console.log(OAuth2Scopes.ApplicationsCommands);
    // console.log(OAuth2Scopes.ApplicationsCommands + " " + OAuth2Scopes.Bot + " " + OAuth2Scopes.Voice);
    // identify - email 抜きでユーザーの情報を取得するスコープ
    // email - ユーザーの情報を取得する際に email も取得するスコープ
    // bot - Botをサーバーに追加するための基本スコープ
    // applications.commands - スラッシュコマンドを使用するためのスコープ
    // voice - Voice Channel への参加と VC にいるメンバーの取得のためのスコープ

    // オプション: 特定のギルドへの参加を促す
    if (guildId) {
      params.append('guild_id', guildId);
    }

    console.log(`[OAuth] Login initiated with state: ${state}`);
    res.redirect(`${configs.DISCORD_CONFIG.OAUTH_URL}?${params.toString()}`);
    
  } catch (error) {
    console.error('[OAuth] Login error:', error);
    res.status(500).send('ログインの開始に失敗しました');
  }
});

// OAuth2コールバックエンドポイント（State検証付き）
app.get('/auth/discord/callback', async (req, res) => {
  try {
    const { code, state, guild_id, error, error_description } = req.query;
    // エラーチェック
    if (error) {
      console.error('[OAuth] Authorization error:', error, error_description);
      return res.status(400).send(`
        <!DOCTYPE html>
        <html>
        <head>
          <title>認証エラー</title>
          <style>
            body {
              font-family: Arial, sans-serif;
              display: flex;
              justify-content: center;
              align-items: center;
              height: 100vh;
              margin: 0;
              background: #f44336;
            }
            .container {
              background: white;
              padding: 2rem;
              border-radius: 10px;
              text-align: center;
            }
            h1 { color: #f44336; }
            a {
              display: inline-block;
              margin-top: 1rem;
              padding: 0.5rem 1rem;
              background: #5865F2;
              color: white;
              text-decoration: none;
              border-radius: 5px;
            }
          </style>
        </head>
        <body>
          <div class="container">
            <h1>❌ 認証エラー</h1>
            <p>${error_description || 'ユーザーが認証をキャンセルしました'}</p>
            <a href="/auth/discord/login">再試行</a>
          </div>
        </body>
        </html>
      `);
    }

    if (!code) {
      return res.status(400).send('認証コードが見つかりません');
    }

    // ===== 重要: State検証 =====
    console.log(`[OAuth] Validating state: ${state}`);
    const stateData = stateManager.validateState(state);
    
    if (!stateData) {
      console.error('[OAuth] State validation failed:', state);
      return res.status(400).send(`
        <!DOCTYPE html>
        <html>
        <head>
          <title>認証エラー</title>
          <style>
            body {
              font-family: Arial, sans-serif;
              display: flex;
              justify-content: center;
              align-items: center;
              height: 100vh;
              margin: 0;
              background: #f44336;
            }
            .container {
              background: white;
              padding: 2rem;
              border-radius: 10px;
              text-align: center;
            }
            h1 { color: #f44336; }
            p { margin: 1rem 0; }
            a {
              display: inline-block;
              margin-top: 1rem;
              padding: 0.5rem 1rem;
              background: #5865F2;
              color: white;
              text-decoration: none;
              border-radius: 5px;
            }
          </style>
        </head>
        <body>
          <div class="container">
            <h1>🔒 セキュリティエラー</h1>
            <p>無効または期限切れの認証リクエストです。</p>
            <p>もう一度最初からやり直してください。</p>
            <a href="/auth/discord/login">ログインページへ</a>
          </div>
        </body>
        </html>
      `);
    }

    console.log('[OAuth] State validated successfully:', stateData);

    // メタデータから情報を取得
    const savedGuildId = stateData.metadata.guildId || guild_id;
    const returnUrl = stateData.metadata.returnUrl || '/';

    // 1. 認証コードをアクセストークンに交換
    console.log('[OAuth] Exchanging code for access token');
    const tokenResponse = await fetch(configs.DISCORD_CONFIG.TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({
        client_id: configs.DISCORD_CONFIG.CLIENT_ID,
        client_secret: configs.DISCORD_CONFIG.CLIENT_SECRET,
        grant_type: 'authorization_code',
        code: code,
        redirect_uri: configs.DISCORD_CONFIG.CALLBACK_URL
      })
    });

    if (!tokenResponse.ok) {
      const errorData = await tokenResponse.json().catch(() => ({}));
      console.error('[OAuth] Token exchange failed:', errorData);
      throw new Error('トークンの取得に失敗しました');
    }

    const tokenData = await tokenResponse.json();
    const { access_token, refresh_token, expires_in } = tokenData;

    // 2. アクセストークンを使ってユーザー情報を取得
    console.log('[OAuth] Fetching user information');
    const userResponse = await fetch(configs.DISCORD_CONFIG.USER_URL, {
      headers: {
        Authorization: `Bearer ${access_token}`
      }
    });

    if (!userResponse.ok) {
      throw new Error('ユーザー情報の取得に失敗しました');
    }

    const discordUser = await userResponse.json();
    const userId = discordUser.id;
    const username = discordUser.username;
    const discriminator = discordUser.discriminator;
    const avatar = discordUser.avatar;

    console.log(`[OAuth] User authenticated: ${username}#${discriminator} (${userId})`);

    // 3. ユーザーが所属するギルド情報を取得
    console.log('[OAuth] Fetching user guilds');
    const guildsResponse = await fetch(configs.DISCORD_CONFIG.GUILD_URL, {
      headers: {
        Authorization: `Bearer ${access_token}`
      }
    });

    let userGuilds = [];
    if (guildsResponse.ok) {
      userGuilds = await guildsResponse.json();
      console.log(`[OAuth] User is in ${userGuilds.length} guilds`);
    }

    // 4. 特定のギルドへの所属確認
    if (savedGuildId) {
      const isMember = userGuilds.some(guild => guild.id === savedGuildId);
      if (!isMember) {
        console.error(`[OAuth] User is not a member of guild ${savedGuildId}`);
        return res.status(403).send(`
          <!DOCTYPE html>
          <html>
          <head>
            <title>アクセス拒否</title>
            <style>
              body {
                font-family: Arial, sans-serif;
                display: flex;
                justify-content: center;
                align-items: center;
                height: 100vh;
                margin: 0;
                background: #f44336;
              }
              .container {
                background: white;
                padding: 2rem;
                border-radius: 10px;
                text-align: center;
              }
              h1 { color: #f44336; }
            </style>
          </head>
          <body>
            <div class="container">
              <h1>🚫 アクセス拒否</h1>
              <p>指定されたDiscordサーバーのメンバーである必要があります。</p>
            </div>
          </body>
          </html>
        `);
      }
    }

    // 5. ユーザーをシステムに登録または取得
    let user = await auth.getUser(userId);
    
    if (!user && savedGuildId) {
      // 新規ユーザーの場合、自動登録
      console.log(`[OAuth] Creating new user: ${userId}`);
      try {
        const result = await auth.createUser({
          userId: userId,
          password: null,
          groupId: savedGuildId,
          threadId: null,
          authority: auth.Authority.PENDING,
          remainingCredit: configs.BOT_DEFAULT_CREDIT
        });
        user = result.userId;
      } catch (error) {
        console.error('[OAuth] User creation error:', error);
        // ユーザーが既に存在する可能性がある
        user = await auth.getUser(userId);
      }
    }

    if (!user) {
      console.error('[OAuth] User not found and could not be created');
      return res.status(404).send('ユーザーが見つかりません');
    }

    // 6. JWTトークンを生成
    const jwtToken = helpers.createAccessToken(user);

    // 7. OAuth2トークンをデータベースに保存（オプション）
    // ここで必要に応じてaccess_tokenとrefresh_tokenを保存
    /*
    await saveDiscordTokens(userId, {
      accessToken: access_token,
      refreshToken: refresh_token,
      expiresAt: new Date(Date.now() + expires_in * 1000)
    });
    */

    console.log(`[OAuth] Authentication successful for user ${userId}`);

    // 8. フロントエンドにリダイレクト
    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>認証成功</title>
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
          * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
          }
          body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
            display: flex;
            justify-content: center;
            align-items: center;
            height: 100vh;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          }
          .container {
            background: white;
            padding: 3rem 2rem;
            border-radius: 15px;
            box-shadow: 0 15px 50px rgba(0,0,0,0.3);
            text-align: center;
            max-width: 400px;
            animation: slideUp 0.5s ease-out;
          }
          @keyframes slideUp {
            from {
              opacity: 0;
              transform: translateY(20px);
            }
            to {
              opacity: 1;
              transform: translateY(0);
            }
          }
          .success-icon {
            color: #43b581;
            font-size: 4rem;
            margin-bottom: 1rem;
            animation: checkmark 0.5s ease-in-out;
          }
          @keyframes checkmark {
            0% { transform: scale(0); }
            50% { transform: scale(1.2); }
            100% { transform: scale(1); }
          }
          h1 {
            color: #5865F2;
            margin-bottom: 0.5rem;
            font-size: 1.8rem;
          }
          .user-info {
            background: #f5f5f5;
            padding: 1rem;
            border-radius: 8px;
            margin: 1.5rem 0;
          }
          .user-info p {
            color: #333;
            margin: 0.5rem 0;
            font-size: 0.9rem;
          }
          .user-info strong {
            color: #5865F2;
          }
          #message {
            color: #666;
            margin-top: 1rem;
            font-size: 0.9rem;
          }
          .spinner {
            display: inline-block;
            width: 20px;
            height: 20px;
            border: 3px solid rgba(88, 101, 242, 0.3);
            border-top-color: #5865F2;
            border-radius: 50%;
            animation: spin 1s linear infinite;
            margin-left: 0.5rem;
          }
          @keyframes spin {
            to { transform: rotate(360deg); }
          }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="success-icon">✓</div>
          <h1>認証成功！</h1>
          <div class="user-info">
            <p><strong>ユーザー:</strong> ${username}#${discriminator}</p>
            <p><strong>権限:</strong> ${user.authority}</p>
          </div>
          <!-- <p id="message">リダイレクト中<span class="spinner"></span></p> -->
        </div>
        <script>
          // JWTトークンをlocalStorageに保存
          localStorage.setItem('auth_token', '${jwtToken}');
          localStorage.setItem('discord_user', JSON.stringify({
            id: '${userId}',
            username: '${username}',
            discriminator: '${discriminator}',
            avatar: '${avatar}',
            authority: '${user.authority}'
          }));
          
          console.log('[OAuth] Token saved to localStorage');
          
          // // メインページにリダイレクト
          // setTimeout(() => {
          //   window.location.href = '${returnUrl}';
          // }, 2000);
        </script>
      </body>
      </html>
    `);

  } catch (error) {
    console.error('[OAuth] Callback error:', error);
    res.status(500).send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>認証エラー</title>
        <style>
          body {
            font-family: Arial, sans-serif;
            display: flex;
            justify-content: center;
            align-items: center;
            height: 100vh;
            margin: 0;
            background: #f44336;
          }
          .container {
            background: white;
            padding: 2rem;
            border-radius: 10px;
            text-align: center;
          }
          h1 { color: #f44336; }
          a {
            display: inline-block;
            margin-top: 1rem;
            padding: 0.5rem 1rem;
            background: #5865F2;
            color: white;
            text-decoration: none;
            border-radius: 5px;
          }
        </style>
      </head>
      <body>
        <div class="container">
          <h1>❌ 認証エラー</h1>
          <p>${error.message}</p>
          <a href="/auth/discord/login">再試行</a>
        </div>
      </body>
      </html>
    `);
  }
});

// ==================================================
// リフレッシュトークンエンドポイント
// ==================================================
app.post('/auth/discord/refresh', requireAuth, async (req, res) => {
  try {
    const { refresh_token } = req.body;

    if (!refresh_token) {
      return res.status(400).json({ error: 'Refresh token required' });
    }

    const tokenResponse = await fetch(configs.DISCORD_CONFIG.TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({
        client_id: configs.DISCORD_CONFIG.CLIENT_ID,
        client_secret: configs.DISCORD_CONFIG.CLIENT_SECRET,
        grant_type: 'refresh_token',
        refresh_token: refresh_token
      })
    });

    if (!tokenResponse.ok) {
      throw new Error('トークンの更新に失敗しました');
    }

    const tokenData = await tokenResponse.json();
    
    res.json({
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token,
      expires_in: tokenData.expires_in
    });

  } catch (error) {
    console.error('[OAuth] Token refresh error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Discord連携解除エンドポイント
app.post('/auth/discord/revoke', requireAuth, async (req, res) => {
  try {
    const { access_token } = req.body;

    if (!access_token) {
      return res.status(400).json({ error: 'Access token required' });
    }

    await fetch('https://discord.com/api/oauth2/token/revoke', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({
        client_id: configs.DISCORD_CONFIG.CLIENT_ID,
        client_secret: configs.DISCORD_CONFIG.CLIENT_SECRET,
        token: access_token
      })
    });

    res.json({ success: true, message: 'Discord連携を解除しました' });

  } catch (error) {
    console.error('[OAuth] Token revoke error:', error);
    res.status(500).json({ error: error.message });
  }
});

console.log('[OAuth] Discord OAuth2 endpoints initialized');

// ====================
// Admin専用 API
// ====================

// 新規ユーザー作成（Admin専用）
app.post('/api/admin/users', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { userId, password, groupId, threadId, authority, remainingCredit } = req.body;
    const user = await auth.createUser({
      userId,
      password,
      groupId,
      threadId,
      authority,
      remainingCredit
    });

    res.status(201).json({ user });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// 全ユーザー取得（Admin専用）
app.get('/api/admin/users', requireAuth, requireAdmin, async (req, res) => {
  try {
    const users = await auth.getAllUsers();
    res.json({ users });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ユーザー情報取得（Admin専用）
app.get('/api/admin/users/:userId', requireAuth, requireAdmin, async (req, res) => {
  try {
    const user = await auth.getUser(req.params.userId);
    
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({ user });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ユーザー情報更新（Admin専用）
app.put('/api/admin/users/:userId', requireAuth, requireAdmin, async (req, res) => {
  try {
    const user = await auth.updateUser(req.params.userId, req.body);
    res.json({ user });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// アカウント停止（Admin専用）
app.post('/api/admin/users/:userId/stop', requireAuth, requireAdmin, async (req, res) => {
  try {
    const user = await auth.stopAccount(req.user.user_id, req.params.userId);
    res.json({ user, message: 'Account stopped successfully' });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// アカウントBAN（Admin専用）
app.post('/api/admin/users/:userId/ban', requireAuth, requireAdmin, async (req, res) => {
  try {
    const user = await auth.banAccount(req.user.user_id, req.params.userId);
    res.json({ user, message: 'Account banned successfully' });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// アカウント復活（Admin専用）
app.post('/api/admin/users/:userId/reactivate', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { authority } = req.body;
    const user = await auth.reactivateAccount(req.user.user_id, req.params.userId, authority);
    res.json({ user, message: 'Account reactivated successfully' });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// アカウント削除（Admin専用）
app.delete('/api/admin/users/:userId', requireAuth, requireAdmin, async (req, res) => {
  try {
    const result = await auth.deleteAccount(req.user.user_id, req.params.userId);
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// クレジット追加（Admin専用）
app.post('/api/admin/users/:userId/credit/add', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { amount } = req.body;
    
    if (!amount || amount <= 0) {
      return res.status(400).json({ error: 'Valid amount required' });
    }

    const user = await auth.addCredit(req.user.user_id, req.params.userId, amount);
    res.json({ user, message: 'Free credit added successfully' });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// 有料クレジット追加（Admin専用）
app.post('/api/admin/users/:userId/paid-credit/add', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { amount } = req.body;
    
    if (!amount || amount <= 0) {
      return res.status(400).json({ error: 'Valid amount required' });
    }

    const user = await auth.addPaidCredit(req.user.user_id, req.params.userId, amount);
    res.json({ user, message: 'Paid credit added successfully' });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// クレジットリセット（Admin専用）
app.post('/api/admin/users/:userId/credit/reset', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { amount } = req.body;
    
    if (typeof amount === 'undefined' || amount < 0) {
      return res.status(400).json({ error: 'Valid amount required' });
    }

    const user = await auth.resetCredit(req.user.user_id, req.params.userId, amount);
    res.json({ user, message: 'Credit reset successfully' });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// ====================
// サーバー起動
// ====================

app.listen(configs.PORT, () => {
  console.log(`GPT-5-Codex Backend API running on port ${configs.PORT}`);
  console.log(`Data directory: ${configs.DATA_DIR}`);
  console.log(`Artifacts directory: ${configs.ARTIFACTS_DIR}`);
});