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
import * as auth from './auth.js';
import * as payment from './payment.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

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
    const baseUrl = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
    const successUrl = `${baseUrl}/success.html`;
    const cancelUrl = `${baseUrl}/cancel.html`;

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
if (!process.env.OPENAI_API_KEY) {
  console.error('ERROR: OPENAI_API_KEY is not set in .env file');
  console.error('Please set OPENAI_API_KEY before starting the server.');
  process.exit(1);
}

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('ERROR: JWT_SECRET is not set in environment variables');
  console.error('Please set JWT_SECRET before starting the server.');
  process.exit(1);
}

// 認証関係（JWT有効期限の設定）
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '12h';

// UI表示設定
const CREDIT_MAX_DISPLAY = parseInt(process.env.CREDIT_MAX_DISPLAY) || 100000;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 50 * 1024 * 1024, // 例: 50MB
    files: 20
  }
});

// デフォルトモデルの設定
const DEFAULT_MODEL = process.env.ORCHESTRATOR_MODEL || 'gpt-5-codex';

// トークンコストの設定（.envから読み込み）
const TOKEN_COST_HIGH = parseInt(process.env.TOKEN_COST_HIGH) || 10;
const TOKEN_COST_LOW = parseInt(process.env.TOKEN_COST_LOW) || 1;

// 利用可能なモデルのリスト
const AVAILABLE_MODELS = [
  'gpt-5.1',
  'gpt-5.1-codex',
  'gpt-5',
  'gpt-5-codex',
  'gpt-5-chat-latest',
  'gpt-4.1',
  'gpt-4o',
  'o1',
  'o3',
  'gpt-5.1-codex-mini',
  'gpt-5-mini',
  'gpt-5-nano',
  'gpt-4.1-mini',
  'gpt-4.1-nano',
  'gpt-4o-mini',
  'o1-mini',
  'o3-mini',
  'o4-mini',
];

const AVAILABLE_MODELS_HIGH_COST = [
  'gpt-5.1',
  'gpt-5.1-codex',
  'gpt-5',
  'gpt-5-codex',
  'gpt-5-chat-latest',
  'gpt-4.1',
  'gpt-4o',
  'o1',
  'o3'
];

const AVAILABLE_MODELS_LOW_COST = [
  'gpt-5.1-codex-mini',
  'gpt-5-mini',
  'gpt-5-nano',
  'gpt-4.1-mini',
  'gpt-4.1-nano',
  'gpt-4o-mini',
  'o1-mini',
  'o3-mini',
  'o4-mini',
];

const REASONING_MODELS = [
  'gpt-5.1',
  'gpt-5.1-codex',
  'gpt-5.1-codex-mini',
  'gpt-5',
  'gpt-5-codex',
  'o1',
  'o3',
  'gpt-5-mini',
  'gpt-5-nano',
  'o1-mini',
  'o3-mini',
  'o4-mini',
];

const NON_REASONING_MODELS = [
  'gpt-5-chat-latest',
  'gpt-4.1',
  'gpt-4o',
  'gpt-4.1-mini',
  'gpt-4.1-nano',
  'gpt-4o-mini'
];

const FREE_TIER_LIMITS = { highCost: 1_000_000, lowCost: 10_000_000 };
const LIMIT_THRESHOLD_RATIO = 0.8;

console.log(`Default model: ${DEFAULT_MODEL}`);
console.log(`Available models: ${AVAILABLE_MODELS.join(', ')}`);
console.log(`High cost models (free 1 million tokens / day): ${AVAILABLE_MODELS_HIGH_COST.join(', ')}`);
console.log(`Low cost models (free 10 million tokens / day): ${AVAILABLE_MODELS_LOW_COST.join(', ')}`);

// システムプロンプトのデフォルト値
const DEFAULT_SYSTEM_PROMPT = 'You are a helpful assistant.';
const AUTO_PROMPT_MARKER_START = '-----\n[auto] thread_artifact_inventory\n';
const AUTO_PROMPT_MARKER_END = '-----';

// OpenAIクライアントの初期化
const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  timeout: 30 * 60 * 1000, // 30分 (1,800秒) = 1,800,000ms
  maxRetries: 2
});

// ディレクトリの初期化
const DATA_DIR = path.join(__dirname, 'data');
const ARTIFACTS_DIR = path.join(__dirname, 'artifacts');
const THREADS_FILE = path.join(DATA_DIR, 'threads.json');
const TOKEN_LOG_FILE = path.join(DATA_DIR, 'token_usage.csv');

await fs.mkdir(DATA_DIR, { recursive: true });
await fs.mkdir(ARTIFACTS_DIR, { recursive: true });

// データベースの初期化
await auth.initDatabase();

const INVALID_FILENAME_CHARS_REGEX = /[\\/:*?"<>|]/g;
const DEFAULT_ARTIFACT_BASENAME = 'artifact';

// CSVログファイルの初期化
async function initTokenLog() {
  try {
    await fs.access(TOKEN_LOG_FILE);
  } catch {
    await fs.writeFile(TOKEN_LOG_FILE, 'timestamp,model,input_tokens,output_tokens,total_tokens,user_id\n');
  }
}

await initTokenLog();

// トークン使用量をログに記録
async function logTokenUsage(model, usage, userId = null) {
  if (!usage) return;
  const now = new Date();
  const timestamp = now.toISOString();
  const logEntry = `${timestamp},${model},${usage.input_tokens || 0},${usage.output_tokens || 0},${usage.total_tokens || 0},${userId || 'anonymous'}\n`;
  await fs.appendFile(TOKEN_LOG_FILE, logEntry);

  // ユーザーのクレジット使用量を記録
  if (userId && usage.total_tokens) {
    try {
      // モデルに応じたクレジット消費量を計算
      const isHighCostModel = AVAILABLE_MODELS_HIGH_COST.includes(model);
      const tokenCostRate = isHighCostModel ? TOKEN_COST_HIGH : TOKEN_COST_LOW;
      const creditsToConsume = usage.total_tokens * tokenCostRate;

      console.log(`[Credit] User: ${userId}, Model: ${model} (${isHighCostModel ? 'High' : 'Low'} cost), Tokens: ${usage.total_tokens}, Rate: ${tokenCostRate}, Credits consumed: ${creditsToConsume}`);

      await auth.recordCreditUsage(userId, creditsToConsume);
    } catch (error) {
      console.error('Failed to record credit usage:', error);
    }
  }
}

function createAccessToken(user) {
  if (!user || !user.user_id) {
    throw new Error('Invalid user payload for token generation');
  }

  return jwt.sign(
    {
      sub: user.user_id,
      authority: user.authority,
      remaining_credit: user.remaining_credit,
      is_active: user.isActive
    },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );
}

// ====================
// 認証ミドルウェア
// ====================

// 認証ミドルウェア（必須）
async function requireAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    
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
      decoded = jwt.verify(token, JWT_SECRET);
    } catch (jwtError) {
      return res.status(401).json({ error: 'Invalid or expired token' });
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
  
  if (user.authority === auth.Authority.ADMIN || user.authority === auth.Authority.VIP) {
    // AdminとVIPはクレジットチェックをスキップ
    return next();
  }

  if (user.remaining_credit <= 0) {
    return res.status(402).json({ 
      error: 'Insufficient credit',
      remaining_credit: user.remaining_credit
    });
  }

  next();
}

// ====================
// 主要機能のAPIエンドポイント
// ====================

// CSVログを読み込んで解析
async function readTokenLog() {
  try {
    const content = await fs.readFile(TOKEN_LOG_FILE, 'utf-8');
    const lines = content.trim().split('\n');
    if (lines.length <= 1) return [];
    const data = lines.slice(1).map(line => {
      const [timestamp, model, input_tokens, output_tokens, total_tokens, user_id] = line.split(',');
      return {
        timestamp: new Date(timestamp),
        model,
        input_tokens: parseInt(input_tokens) || 0,
        output_tokens: parseInt(output_tokens) || 0,
        total_tokens: parseInt(total_tokens) || 0,
        user_id: user_id || 'anonymous'
      };
    });
    return data;
  } catch (error) {
    console.error('Error reading token log:', error);
    return [];
  }
}

// ログの圧縮と削除を実行
async function compressAndCleanLogs() {
  try {
    const logs = await readTokenLog();
    if (logs.length === 0) return;
    const now = new Date();
    const threeDaysAgo = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);
    const threeMonthsAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
    const toJSTDateString = (date) => {
      const jstDate = new Date(date.getTime() + 9 * 60 * 60 * 1000);
      return jstDate.toISOString().split('T')[0];
    };
    const validLogs = logs.filter(log => log.timestamp >= threeMonthsAgo);
    const recentLogs = validLogs.filter(log => log.timestamp >= threeDaysAgo);
    const oldLogs = validLogs.filter(log => log.timestamp < threeDaysAgo);
    const dailyAggregated = {};
    oldLogs.forEach(log => {
      const dateKey = toJSTDateString(log.timestamp);
      const modelKey = `${dateKey}_${log.model}_${log.user_id}`;
      if (!dailyAggregated[modelKey]) {
        dailyAggregated[modelKey] = {
          timestamp: new Date(dateKey + 'T00:00:00Z'),
          model: log.model,
          input_tokens: 0,
          output_tokens: 0,
          total_tokens: 0,
          user_id: log.user_id
        };
      }
      dailyAggregated[modelKey].input_tokens += log.input_tokens;
      dailyAggregated[modelKey].output_tokens += log.output_tokens;
      dailyAggregated[modelKey].total_tokens += log.total_tokens;
    });
    const compressedLogs = [...Object.values(dailyAggregated), ...recentLogs]
      .sort((a, b) => a.timestamp - b.timestamp);
    let csvContent = 'timestamp,model,input_tokens,output_tokens,total_tokens,user_id\n';
    compressedLogs.forEach(log => {
      csvContent += `${log.timestamp.toISOString()},${log.model},${log.input_tokens},${log.output_tokens},${log.total_tokens},${log.user_id}\n`;
    });
    await fs.writeFile(TOKEN_LOG_FILE, csvContent);
    console.log('Token logs compressed and cleaned');
  } catch (error) {
    console.error('Error compressing logs:', error);
  }
}

setInterval(compressAndCleanLogs, 60 * 60 * 1000);
compressAndCleanLogs();

// ユーティリティ関数
async function getTokenUsageSummary(hours = 24, userId = null) {
  const logs = await readTokenLog();
  const now = new Date();
  const boundary = new Date(now.getTime() - hours * 60 * 60 * 1000);

  const summary = {
    highCost: { usage: 0, limit: FREE_TIER_LIMITS.highCost },
    lowCost: { usage: 0, limit: FREE_TIER_LIMITS.lowCost }
  };

  for (const log of logs) {
    if (log.timestamp < boundary) continue;
    
    // ユーザーIDでフィルタリング（指定された場合）
    if (userId && log.user_id !== userId) continue;
    
    if (AVAILABLE_MODELS_HIGH_COST.includes(log.model)) {
      summary.highCost.usage += log.total_tokens;
    } else if (AVAILABLE_MODELS_LOW_COST.includes(log.model)) {
      summary.lowCost.usage += log.total_tokens;
    }
  }

  summary.highCost.percentage = summary.highCost.limit
    ? (summary.highCost.usage / summary.highCost.limit) * 100
    : 0;
  summary.lowCost.percentage = summary.lowCost.limit
    ? (summary.lowCost.usage / summary.lowCost.limit) * 100
    : 0;

  return summary;
}

async function readThreads() {
  try {
    const data = await fs.readFile(THREADS_FILE, 'utf-8');
    const parsed = JSON.parse(data);
    parsed.threads = parsed.threads.map(summary => ({
      ...summary,
      artifactIds: Array.isArray(summary.artifactIds) ? summary.artifactIds : []
    }));
    return parsed;
  } catch {
    return { threads: [] };
  }
}

async function writeThreads(data) {
  await fs.writeFile(THREADS_FILE, JSON.stringify(data, null, 2));
}

async function readThread(threadId) {
  const threadPath = path.join(DATA_DIR, `thread_${threadId}.json`);
  try {
    const data = await fs.readFile(threadPath, 'utf-8');
    const thread = JSON.parse(data);
    thread.artifactIds = Array.isArray(thread.artifactIds) ? thread.artifactIds : [];
    return thread;
  } catch {
    return null;
  }
}

async function writeThread(threadId, data) {
  ensureThreadDefaults(data);
  const threadFile = path.join(DATA_DIR, `thread_${threadId}.json`);
  await fs.writeFile(threadFile, JSON.stringify(data, null, 2));
}

function generateId() {
  return crypto.randomUUID();
}

function ensureThreadDefaults(thread) {
  if (!thread) return thread;
  if (!thread.systemPromptUser) {
    thread.systemPromptUser = thread.systemPrompt || DEFAULT_SYSTEM_PROMPT;
  }
  if (!Array.isArray(thread.artifactIds)) {
    thread.artifactIds = [];
  }
  return thread;
}

async function readArtifactMetadata(artifactId) {
  const metadataPath = path.join(ARTIFACTS_DIR, artifactId, 'metadata.json');
  const content = await fs.readFile(metadataPath, 'utf-8');
  return JSON.parse(content);
}

async function collectThreadArtifactSummaries(threadId) {
  const artifactDirs = await fs.readdir(ARTIFACTS_DIR);
  const summaries = [];
  for (const dir of artifactDirs) {
    try {
      const metadata = await readArtifactMetadata(dir);
      if (threadId && metadata.threadId !== threadId) continue;
      const latest = metadata.versions.at(-1) || {};
      summaries.push({
        id: metadata.id,
        name: metadata.filename,
        description: latest.metadata?.description || '',
        updatedAt: metadata.updatedAt
      });
    } catch {
      continue;
    }
  }
  return summaries.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
}

function sanitizeFilename(filename) {
  if (typeof filename !== 'string') {
    return DEFAULT_ARTIFACT_BASENAME;
  }
  const trimmed = filename.trim();
  if (!trimmed) {
    return DEFAULT_ARTIFACT_BASENAME;
  }
  const base = path.basename(trimmed);
  const sanitized = base.replace(INVALID_FILENAME_CHARS_REGEX, '_');
  return sanitized || DEFAULT_ARTIFACT_BASENAME;
}

function decodeMulterFilename(name) {
  if (typeof name !== 'string') {
    return DEFAULT_ARTIFACT_BASENAME;
  }
  return Buffer.from(name, 'latin1').toString('utf8');
}

function composeSystemPrompt(userPrompt = DEFAULT_SYSTEM_PROMPT, artifactSummaries = []) {
  const sanitized = userPrompt.trim() || DEFAULT_SYSTEM_PROMPT;
  const inventoryJson = JSON.stringify(
    artifactSummaries.map(({ id, name, description }) => ({ id, name, description })),
    null,
    2
  );
  const autoBlock = [
    AUTO_PROMPT_MARKER_START.trim(),
    inventoryJson,
    AUTO_PROMPT_MARKER_END.trim()
  ].join('\n') + '\n';
  return `${sanitized}\n\n${autoBlock}`;
}

function arraysEqual(a = [], b = []) {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

async function updateThreadSummaryMetadata(thread) {
  const threads = await readThreads();
  let changed = false;
  threads.threads = threads.threads.map(summary => {
    if (summary.id !== thread.id) return summary;
    changed = true;
    return {
      ...summary,
      updatedAt: thread.updatedAt,
      artifactIds: thread.artifactIds
    };
  });
  if (!changed) return;
  await writeThreads(threads);
}

async function refreshThreadDerivedState(thread, { persist = true } = {}) {
  if (!thread) return { thread: null, artifacts: [] };
  ensureThreadDefaults(thread);
  const artifacts = await collectThreadArtifactSummaries(thread.id);
  const artifactIds = artifacts.map(a => a.id);
  const effectivePrompt = composeSystemPrompt(thread.systemPromptUser, artifacts);

  let changed = false;
  if (!arraysEqual(thread.artifactIds, artifactIds)) {
    thread.artifactIds = artifactIds;
    changed = true;
  }
  if (thread.systemPrompt !== effectivePrompt) {
    thread.systemPrompt = effectivePrompt;
    changed = true;
  }

  if (changed && persist) {
    thread.updatedAt = new Date().toISOString();
    await writeThread(thread.id, thread);
    await updateThreadSummaryMetadata(thread);
  }

  return { thread, artifacts, changed };
}

async function updateThreadAfterArtifactChange(threadId) {
  if (!threadId) return;
  const thread = await readThread(threadId);
  if (!thread) return;
  await refreshThreadDerivedState(thread, { persist: true });
}

async function ensureArtifactDir(artifactId) {
  const artifactDir = path.join(ARTIFACTS_DIR, artifactId);
  await fs.mkdir(artifactDir, { recursive: true });
  return artifactDir;
}

function buildVersionedFilename(filename, version) {
  const parsed = path.parse(filename);
  const safeName = parsed.name || DEFAULT_ARTIFACT_BASENAME;
  const safeExt = parsed.ext || '';
  return `${safeName}_v${version}${safeExt}`;
}

async function writeArtifactFile(filePath, content) {
  const data = Buffer.isBuffer(content) ? content : Buffer.from(content);
  await fs.writeFile(filePath, data);
}

async function createArtifactRecord({ filename, content, metadata = {}, threadId = null }) {
  const artifactId = generateId();
  const version = 1;
  const timestamp = new Date().toISOString();
  const safeFilename = sanitizeFilename(filename);

  const artifactDir = await ensureArtifactDir(artifactId);
  const versionedFilename = buildVersionedFilename(safeFilename, version);
  const filePath = path.join(artifactDir, versionedFilename);
  await writeArtifactFile(filePath, content);

  const artifactMetadata = {
    id: artifactId,
    filename: safeFilename,
    threadId,
    currentVersion: version,
    versions: [{
      version,
      filename: versionedFilename,
      createdAt: timestamp,
      metadata
    }],
    createdAt: timestamp,
    updatedAt: timestamp
  };

  const metadataPath = path.join(artifactDir, 'metadata.json');
  await fs.writeFile(metadataPath, JSON.stringify(artifactMetadata, null, 2));
  await updateThreadAfterArtifactChange(threadId);

  return {
    artifactId,
    version,
    filename: versionedFilename,
    displayFilename: safeFilename,
    threadId,
    path: `/api/artifacts/${artifactId}/v${version}`
  };
}

async function appendArtifactVersion({ artifactId, content, metadata = {} }) {
  const artifactDir = path.join(ARTIFACTS_DIR, artifactId);
  const metadataPath = path.join(artifactDir, 'metadata.json');

  const metadataContent = await fs.readFile(metadataPath, 'utf-8');
  const artifactMetadata = JSON.parse(metadataContent);

  const newVersion = artifactMetadata.currentVersion + 1;
  const timestamp = new Date().toISOString();
  const versionedFilename = buildVersionedFilename(artifactMetadata.filename, newVersion);
  const filePath = path.join(artifactDir, versionedFilename);

  await writeArtifactFile(filePath, content);

  artifactMetadata.currentVersion = newVersion;
  artifactMetadata.versions.push({
    version: newVersion,
    filename: versionedFilename,
    createdAt: timestamp,
    metadata
  });
  artifactMetadata.updatedAt = timestamp;

  await fs.writeFile(metadataPath, JSON.stringify(artifactMetadata, null, 2));
  await updateThreadAfterArtifactChange(artifactMetadata.threadId);

  return {
    artifactId,
    version: newVersion,
    filename: versionedFilename,
    displayFilename: artifactMetadata.filename,
    threadId: artifactMetadata.threadId,
    path: `/api/artifacts/${artifactId}/v${newVersion}`
  };
}

// ==========================================
// patch_artifact ツール用ヘルパー関数
// ==========================================

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * パターン内の連続空白を \s+ に変換した正規表現を生成
 */
function buildFlexiblePattern(pattern) {
  const tokens = pattern.trim().split(/\s+/).map(escapeRegExp);
  if (tokens.length === 0) {
    throw new Error('Pattern must contain at least one non-whitespace character');
  }
  return new RegExp(tokens.join('\\s+'), 'g');
}

/**
 * マッチ範囲の先頭／末尾から余分な空白を取り除いたオフセットを返す
 */
function trimWhitespaceAroundMatch(text, start, end) {
  while (start < end && /\s/.test(text[start])) start += 1;
  while (end > start && /\s/.test(text[end - 1])) end -= 1;
  return { start, end };
}

/**
 * 柔軟な空白マッチを考慮して全マッチを返す（オフセットベース）
 */
function findAllMatches(content, pattern) {
  const matches = [];
  const regex = buildFlexiblePattern(pattern);
  let match;

  while ((match = regex.exec(content)) !== null) {
    const rawStart = match.index;
    const rawEnd = regex.lastIndex;
    const { start, end } = trimWhitespaceAroundMatch(content, rawStart, rawEnd);

    if (start === end) {
      continue; // 空白しかなかった場合はスキップ
    }

    matches.push({
      startOffset: start,
      endOffset: end,
      text: content.slice(start, end)
    });

    // 無限ループ防止（ゼロ幅マッチ対策）
    if (regex.lastIndex === match.index) {
      regex.lastIndex += 1;
    }
  }

  return matches;
}

/**
 * start/endパターンのマッチ同士をペアリング
 */
function pairStartEnd(startMatches, endMatches, startPattern, endPattern) {
  // start と end が同じ文字列なら同一マッチを利用
  if (startPattern && endPattern && startPattern === endPattern) {
    return startMatches.map(match => ({ startMatch: match, endMatch: match }));
  }

  const pairs = [];
  const usedEnd = new Set();

  for (const startMatch of startMatches) {
    let candidate = null;
    let candidateIndex = -1;

    for (let i = 0; i < endMatches.length; i++) {
      if (usedEnd.has(i)) continue;
      const endMatch = endMatches[i];

      if (endMatch.startOffset >= startMatch.endOffset) {
        if (!candidate || endMatch.startOffset < candidate.startOffset) {
          candidate = endMatch;
          candidateIndex = i;
        }
      }
    }

    if (candidate) {
      pairs.push({ startMatch, endMatch: candidate });
      usedEnd.add(candidateIndex);
    }
  }

  return pairs;
}

/**
 * パッチを適用（オフセットベース）
 */
function applyPatches(content, edits) {
  if (!Array.isArray(edits) || edits.length === 0) {
    throw new Error('edits must be a non-empty array');
  }

  const appliedEdits = [];

  for (const edit of edits) {
    const { edit_type, start_pattern, end_pattern, new_content } = edit;

    if (!edit_type || !start_pattern) {
      throw new Error('Each edit must have edit_type and start_pattern');
    }

    const startMatches = findAllMatches(content, start_pattern);
    if (startMatches.length === 0) {
      throw new Error(`start_pattern not found: "${start_pattern.substring(0, 50)}..."`);
    }

    if (edit_type === 'replace' || edit_type === 'delete') {
      if (!end_pattern) {
        throw new Error(`edit_type "${edit_type}" requires end_pattern`);
      }

      const endMatches = findAllMatches(content, end_pattern);
      if (endMatches.length === 0) {
        throw new Error(`end_pattern not found: "${end_pattern.substring(0, 50)}..."`);
      }

      const pairs = pairStartEnd(startMatches, endMatches, start_pattern, end_pattern);
      if (pairs.length === 0) {
        throw new Error('No valid start-end pairs found');
      }

      for (const { startMatch, endMatch } of pairs) {
        appliedEdits.push({
          type: edit_type,
          startOffset: startMatch.startOffset,
          endOffset: endMatch.endOffset,
          newContent: edit_type === 'replace' ? (new_content ?? '') : ''
        });
      }
    } else if (edit_type === 'insert_before' || edit_type === 'insert_after') {
      for (const match of startMatches) {
        appliedEdits.push({
          type: edit_type,
          startOffset: match.startOffset,
          endOffset: match.endOffset,
          newContent: new_content ?? ''
        });
      }
    } else {
      throw new Error(`Unknown edit_type: ${edit_type}`);
    }
  }

  // オフセットの大きい順に適用
  appliedEdits.sort((a, b) => b.startOffset - a.startOffset);

  let updatedContent = content;
  for (const edit of appliedEdits) {
    switch (edit.type) {
      case 'replace': {
        updatedContent =
          updatedContent.slice(0, edit.startOffset) +
          edit.newContent +
          updatedContent.slice(edit.endOffset);
        break;
      }
      case 'delete': {
        updatedContent =
          updatedContent.slice(0, edit.startOffset) +
          updatedContent.slice(edit.endOffset);
        break;
      }
      case 'insert_before': {
        updatedContent =
          updatedContent.slice(0, edit.startOffset) +
          edit.newContent +
          updatedContent.slice(edit.startOffset);
        break;
      }
      case 'insert_after': {
        updatedContent =
          updatedContent.slice(0, edit.endOffset) +
          edit.newContent +
          updatedContent.slice(edit.endOffset);
        break;
      }
    }
  }

  return updatedContent;
}

// モデルのバリデーション
function validateModel(model) {
  if (!model) {
    return { valid: true, model: DEFAULT_MODEL };
  }
  
  if (AVAILABLE_MODELS.includes(model)) {
    return { valid: true, model };
  }
  
  return { 
    valid: false, 
    error: `Invalid model: ${model}. Available models: ${AVAILABLE_MODELS.join(', ')}` 
  };
}

function isReasoningModel(model) {
  return REASONING_MODELS.includes(model);
}

// ====================
// スレッド管理 API
// ====================

// スレッド一覧取得
app.get('/api/threads', requireAuth, async (req, res) => {
  try {
    const data = await readThreads();
    res.json({ threads: data.threads });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 特定スレッド取得
app.get('/api/threads/:threadId', requireAuth, async (req, res) => {
  try {
    const { threadId } = req.params;
    const thread = await readThread(threadId);
    if (!thread) return res.status(404).json({ error: 'Thread not found' });

    const { thread: refreshedThread, artifacts } = await refreshThreadDerivedState(thread, { persist: true });
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
    const { title, systemPrompt, model } = req.body;
    const threadId = generateId();
    const timestamp = new Date().toISOString();
    const userPrompt = (systemPrompt || DEFAULT_SYSTEM_PROMPT).trim();

    const modelValidation = validateModel(model);
    if (!modelValidation.valid) {
      return res.status(400).json({ error: modelValidation.error });
    }

    const newThreadSummary = {
      id: threadId,
      title: title || 'New Thread',
      createdAt: timestamp,
      updatedAt: timestamp,
      artifactIds: []
    };

    const threadData = {
      id: threadId,
      title: newThreadSummary.title,
      systemPromptUser: userPrompt,
      systemPrompt: composeSystemPrompt(userPrompt, []),
      model: modelValidation.model,
      messages: [],
      artifactIds: [],
      createdAt: timestamp,
      updatedAt: timestamp
    };

    const threads = await readThreads();
    threads.threads.push(newThreadSummary);
    await writeThreads(threads);
    await writeThread(threadId, threadData);

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
    const threads = await readThreads();
    threads.threads = threads.threads.filter(t => t.id !== threadId);
    await writeThreads(threads);
    
    // スレッドファイルを削除
    const threadFile = path.join(DATA_DIR, `thread_${threadId}.json`);
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
    const thread = await readThread(req.params.threadId);
    if (!thread) return res.status(404).json({ error: 'Thread not found' });
    const { thread: refreshedThread, artifacts } = await refreshThreadDerivedState(thread, { persist: true });
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
    const thread = await readThread(req.params.threadId);
    if (!thread) return res.status(404).json({ error: 'Thread not found' });

    thread.systemPromptUser = (systemPrompt || DEFAULT_SYSTEM_PROMPT).trim();
    const { thread: refreshedThread, artifacts } = await refreshThreadDerivedState(thread, { persist: true });

    res.json({
      systemPromptUser: refreshedThread.systemPromptUser,
      systemPrompt: refreshedThread.systemPrompt,
      artifactInventory: artifacts
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ====================
// モデル管理 API
// ====================

// 利用可能なモデル一覧取得
app.get('/api/models', requireAuth, (req, res) => {
  res.json({
    defaultModel: DEFAULT_MODEL,
    availableModels: AVAILABLE_MODELS,
    highCostModels: AVAILABLE_MODELS_HIGH_COST,
    lowCostModels: AVAILABLE_MODELS_LOW_COST
  });
});

// スレッドのモデル取得
app.get('/api/threads/:threadId/model', requireAuth, async (req, res) => {
  try {
    const { threadId } = req.params;
    const thread = await readThread(threadId);
    
    if (!thread) {
      return res.status(404).json({ error: 'Thread not found' });
    }
    
    res.json({ model: thread.model || DEFAULT_MODEL });
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
    const modelValidation = validateModel(model);
    if (!modelValidation.valid) {
      return res.status(400).json({ error: modelValidation.error });
    }
    
    const thread = await readThread(threadId);
    if (!thread) {
      return res.status(404).json({ error: 'Thread not found' });
    }
    
    thread.model = modelValidation.model;
    thread.updatedAt = new Date().toISOString();
    await writeThread(threadId, thread);
    
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
  const summary = await getTokenUsageSummary();
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
    const { content, model } = req.body;
    
    const thread = await readThread(threadId);
    if (!thread) return res.status(404).json({ error: 'Thread not found' });

    const { thread: hydratedThread } = await refreshThreadDerivedState(thread, { persist: false });
    const developerPrompt = hydratedThread.systemPrompt;

    let conversationHistory = hydratedThread.messages.map(m => ({ role: m.role, content: m.content }));

    // モデルの優先順位: リクエスト > スレッド > デフォルト
    let selectedModel = model || thread.model || DEFAULT_MODEL;

    // モデルのバリデーション
    const modelValidation = validateModel(selectedModel);
    if (!modelValidation.valid) {
      return res.status(400).json({ error: modelValidation.error });
    }
    selectedModel = modelValidation.model;

    const usageSummary = await getTokenUsageSummary();
    const modelTier = AVAILABLE_MODELS_HIGH_COST.includes(selectedModel) ? 'highCost' : 'lowCost';
    const tierUsage = usageSummary[modelTier];
    if (tierUsage.usage >= tierUsage.limit * LIMIT_THRESHOLD_RATIO) {
      return res.status(429).json({
        error: 'TOKEN_LIMIT_APPROACHING',
        message: '24時間の無料利用枠がまもなく上限に達するため、しばらく待ってから再度お試しください。',
        usage: {
          modelTier,
          ...tierUsage
        }
      });
    }
    
    // ユーザーメッセージを追加
    const userMessage = {
      id: generateId(),
      role: 'user',
      content,
      timestamp: new Date().toISOString()
    };
    thread.messages.push(userMessage);
    
    // 一旦ユーザーメッセージを保存
    thread.updatedAt = new Date().toISOString();
    await writeThread(threadId, thread);
    
    let assistantMessage;
    try {
      // Responses APIの形式に合わせる
      let conversationHistory = thread.messages.map(m => ({
        role: m.role,
        content: m.content
      }));
      
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
        if (isReasoningModel(selectedModel)) {
          requestParams.reasoning = {
            effort: "medium",
            summary: "auto",
          };
        }

        const response = await client.responses.create(requestParams);

        console.log(`Received response from ${selectedModel}`);
        
        // トークン使用量のログ記録
        if (response.usage) {
          console.log('\n--- トークン使用量 ---');
          console.log(`入力トークン: ${response.usage.input_tokens}`);
          console.log(`出力トークン: ${response.usage.output_tokens}`);
          console.log(`合計トークン: ${response.usage.total_tokens}`);
          console.log('---------------------\n');
          await logTokenUsage(selectedModel, response.usage, req.user.user_id);
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
                  const record = await createArtifactRecord({
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
                  const record = await appendArtifactVersion({
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

                  const artifactDir = path.join(ARTIFACTS_DIR, artifactId);
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
                  const artifactDir = path.join(ARTIFACTS_DIR, artifactId);
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
                  const patchedContent = applyPatches(originalContent, edits);
                  
                  // 新しいバージョンとして保存
                  const record = await appendArtifactVersion({
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

                  const artifactDir = path.join(ARTIFACTS_DIR, artifactId);
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
                  const matches = findAllMatches(content, searchPattern);
                  
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
          await refreshThreadDerivedState(thread, { persist: true });
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

      // アシスタントの応答を追加
      assistantMessage = {
        id: generateId(),
        role: 'assistant',
        content: responseText || 'No response',
        model: selectedModel,
        timestamp: new Date().toISOString(),
        toolCalls: allToolCalls.length > 0 ? allToolCalls : undefined,
        usage: finalResponse?.usage || undefined
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
        id: generateId(),
        role: 'assistant',
        content: `エラーが発生しました: ${apiError.message}`,
        model: selectedModel,
        timestamp: new Date().toISOString()
      };
    }
    
    thread.messages.push(assistantMessage);
    
    // スレッドを更新
    thread.updatedAt = new Date().toISOString();
    await writeThread(threadId, thread);
    
    // スレッド一覧の更新時刻も更新
    const threads = await readThreads();
    const threadIndex = threads.threads.findIndex(t => t.id === threadId);
    if (threadIndex !== -1) {
      threads.threads[threadIndex].updatedAt = thread.updatedAt;
      await writeThreads(threads);
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
    const thread = await readThread(threadId);
    
    if (!thread) {
      return res.status(404).json({ error: 'Thread not found' });
    }
    
    res.json({ messages: thread.messages });
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
    const result = await createArtifactRecord({
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
    const artifactDir = path.join(ARTIFACTS_DIR, artifactId);
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
    const artifactDir = path.join(ARTIFACTS_DIR, artifactId);
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

    const result = await appendArtifactVersion({
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
    const artifactDir = path.join(ARTIFACTS_DIR, artifactId);
    const metadata = await readArtifactMetadata(req.params.artifactId).catch(() => null);

    // ディレクトリを削除
    await fs.rm(artifactDir, { recursive: true, force: true });
    await updateThreadAfterArtifactChange(metadata?.threadId);

    res.json({ message: 'Artifact deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// アーティファクト一覧取得
app.get('/api/artifacts', requireAuth, async (req, res) => {
  try {
    const { threadId } = req.query;
    const artifactDirs = await fs.readdir(ARTIFACTS_DIR);
    const artifacts = [];
    
    // threadIdがクエリにないなら即座に空配列を返す
    if (!threadId) {
      return res.json({ artifacts: [] });
    }

    for (const dir of artifactDirs) {
      const metadataPath = path.join(ARTIFACTS_DIR, dir, 'metadata.json');
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
        const decodedName = decodeMulterFilename(file.originalname);
        const safeFilename = sanitizeFilename(decodedName);
        const fileMetadata = metadataPayload[decodedName] ?? metadataPayload[file.originalname] ?? {};
        // const fileMetadata = metadataPayload[file.originalname] || {};
        const record = await createArtifactRecord({
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
          originalName: decodeMulterFilename(file.originalname),
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
      creditMaxDisplay: CREDIT_MAX_DISPLAY
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ログイン（認証テスト）
app.post('/api/auth/login', async (req, res) => {
  try {
    const { userId, password, groupId } = req.body;
    
    let user = null;
    
    if (groupId) {
      user = await auth.authenticateWithGroup(userId, groupId);
    } else if (password) {
      user = await auth.authenticateWithPassword(userId, password);
    } else {
      return res.status(400).json({ error: 'Password or groupId required' });
    }

    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // JWTトークンを生成
    const token = createAccessToken(user);

    res.json({ 
      success: true,
      user,
      token
    });
  } catch (error) {
    if (error.message.includes('stopped') || error.message.includes('banned')) {
      return res.status(403).json({ error: error.message });
    }
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
    res.json({ user, message: 'Credit added successfully' });
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

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`GPT-5-Codex Backend API running on port ${PORT}`);
  console.log(`Data directory: ${DATA_DIR}`);
  console.log(`Artifacts directory: ${ARTIFACTS_DIR}`);
});