// server.js
import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import { OpenAI } from 'openai';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 静的ファイルの配信
app.use(express.static('public'));

// 環境変数の確認
if (!process.env.OPENAI_API_KEY) {
  console.error('ERROR: OPENAI_API_KEY is not set in .env file');
  process.exit(1);
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 50 * 1024 * 1024, // 例: 50MB
    files: 20
  }
});

// デフォルトモデルの設定
const DEFAULT_MODEL = process.env.ORCHESTRATOR_MODEL || 'gpt-5-codex';

// 利用可能なモデルのリスト
const AVAILABLE_MODELS = [
  'gpt-5',
  'gpt-5-codex',
  'gpt-5-chat-latest',
  'gpt-4.1',
  'gpt-4o',
  'o1',
  'o3',
  'gpt-5-mini',
  'gpt-5-nano',
  'gpt-4.1-mini',
  'gpt-4.1-nano',
  'gpt-4o-mini',
  'o1-mini',
  'o3-mini',
  'o4-mini',
  'codex-mini-latest'
];

const AVAILABLE_MODELS_HIGH_COST = [
  'gpt-5',
  'gpt-5-codex',
  'gpt-5-chat-latest',
  'gpt-4.1',
  'gpt-4o',
  'o1',
  'o3'
];

const AVAILABLE_MODELS_LOW_COST = [
  'gpt-5-mini',
  'gpt-5-nano',
  'gpt-4.1-mini',
  'gpt-4.1-nano',
  'gpt-4o-mini',
  'o1-mini',
  'o3-mini',
  'o4-mini',
  'codex-mini-latest'
];

const REASONING_MODELS = [
  'gpt-5',
  'gpt-5-codex',
  'gpt-5-chat-latest',
  'o1',
  'o3',
  'gpt-5-mini',
  'gpt-5-nano',
  'o1-mini',
  'o3-mini',
  'o4-mini',
  'codex-mini-latest'
];

const NON_REASONING_MODELS = [
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
  timeout: 5 * 60 * 1000, // 5分 (300秒) = 300,000ms
  maxRetries: 2
});

// ディレクトリの初期化
const DATA_DIR = path.join(__dirname, 'data');
const ARTIFACTS_DIR = path.join(__dirname, 'artifacts');
const THREADS_FILE = path.join(DATA_DIR, 'threads.json');
const TOKEN_LOG_FILE = path.join(DATA_DIR, 'token_usage.csv');

await fs.mkdir(DATA_DIR, { recursive: true });
await fs.mkdir(ARTIFACTS_DIR, { recursive: true });

// CSVログファイルの初期化
async function initTokenLog() {
  try {
    await fs.access(TOKEN_LOG_FILE);
  } catch {
    await fs.writeFile(TOKEN_LOG_FILE, 'timestamp,model,input_tokens,output_tokens,total_tokens\n');
  }
}

await initTokenLog();

// トークン使用量をログに記録
async function logTokenUsage(model, usage) {
  if (!usage) return;
  const now = new Date();
  const timestamp = now.toISOString();
  const logEntry = `${timestamp},${model},${usage.input_tokens || 0},${usage.output_tokens || 0},${usage.total_tokens || 0}\n`;
  await fs.appendFile(TOKEN_LOG_FILE, logEntry);
}

// CSVログを読み込んで解析
async function readTokenLog() {
  try {
    const content = await fs.readFile(TOKEN_LOG_FILE, 'utf-8');
    const lines = content.trim().split('\n');
    if (lines.length <= 1) return [];
    const data = lines.slice(1).map(line => {
      const [timestamp, model, input_tokens, output_tokens, total_tokens] = line.split(',');
      return {
        timestamp: new Date(timestamp),
        model,
        input_tokens: parseInt(input_tokens) || 0,
        output_tokens: parseInt(output_tokens) || 0,
        total_tokens: parseInt(total_tokens) || 0
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
      const modelKey = `${dateKey}_${log.model}`;
      if (!dailyAggregated[modelKey]) {
        dailyAggregated[modelKey] = {
          timestamp: new Date(dateKey + 'T00:00:00Z'),
          model: log.model,
          input_tokens: 0,
          output_tokens: 0,
          total_tokens: 0
        };
      }
      dailyAggregated[modelKey].input_tokens += log.input_tokens;
      dailyAggregated[modelKey].output_tokens += log.output_tokens;
      dailyAggregated[modelKey].total_tokens += log.total_tokens;
    });
    const compressedLogs = [...Object.values(dailyAggregated), ...recentLogs]
      .sort((a, b) => a.timestamp - b.timestamp);
    let csvContent = 'timestamp,model,input_tokens,output_tokens,total_tokens\n';
    compressedLogs.forEach(log => {
      csvContent += `${log.timestamp.toISOString()},${log.model},${log.input_tokens},${log.output_tokens},${log.total_tokens}\n`;
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
async function getTokenUsageSummary(hours = 24) {
  const logs = await readTokenLog();
  const now = new Date();
  const boundary = new Date(now.getTime() - hours * 60 * 60 * 1000);

  const summary = {
    highCost: { usage: 0, limit: FREE_TIER_LIMITS.highCost },
    lowCost: { usage: 0, limit: FREE_TIER_LIMITS.lowCost }
  };

  for (const log of logs) {
    if (log.timestamp < boundary) continue;
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
  try {
    const threadFile = path.join(DATA_DIR, `thread_${threadId}.json`);
    const data = await fs.readFile(threadFile, 'utf-8');
    return ensureThreadDefaults(JSON.parse(data));
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
  const { name, ext } = path.parse(filename);
  return `${name}_v${version}${ext}`;
}

async function writeArtifactFile(filePath, content) {
  const data = Buffer.isBuffer(content) ? content : Buffer.from(content);
  await fs.writeFile(filePath, data);
}

async function createArtifactRecord({ filename, content, metadata = {}, threadId = null }) {
  const artifactId = generateId();
  const version = 1;
  const timestamp = new Date().toISOString();

  const artifactDir = await ensureArtifactDir(artifactId);
  const versionedFilename = buildVersionedFilename(filename, version);
  const filePath = path.join(artifactDir, versionedFilename);
  await writeArtifactFile(filePath, content);

  const artifactMetadata = {
    id: artifactId,
    filename,
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
    threadId: artifactMetadata.threadId,
    path: `/api/artifacts/${artifactId}/v${newVersion}`
  };
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
app.get('/api/threads', async (req, res) => {
  try {
    const data = await readThreads();
    res.json({ threads: data.threads });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 特定スレッド取得
app.get('/api/threads/:threadId', async (req, res) => {
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
app.post('/api/threads', async (req, res) => {
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
app.delete('/api/threads/:threadId', async (req, res) => {
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
app.get('/api/threads/:threadId/system-prompt', async (req, res) => {
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
app.put('/api/threads/:threadId/system-prompt', async (req, res) => {
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
app.get('/api/models', (req, res) => {
  res.json({
    defaultModel: DEFAULT_MODEL,
    availableModels: AVAILABLE_MODELS,
    highCostModels: AVAILABLE_MODELS_HIGH_COST,
    lowCostModels: AVAILABLE_MODELS_LOW_COST
  });
});

// スレッドのモデル取得
app.get('/api/threads/:threadId/model', async (req, res) => {
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
app.put('/api/threads/:threadId/model', async (req, res) => {
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
app.get('/api/token-usage/stats', async (req, res) => {
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
app.post('/api/threads/:threadId/messages', async (req, res) => {
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
          name: "edit_artifact",
          description: "Edit an existing artifact by providing its ID and the new content. Use this when the user asks to modify an existing artifact.",
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
          description: "Read the contents of an existing artifact so you can inspect or quote it in your response.",
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
              }
            },
            required: ["artifact_id"]
          }
        }
      ];

      let allToolCalls = [];
      let maxIterations = 5; // 無限ループ防止
      let iteration = 0;
      let finalResponse;

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
          await logTokenUsage(selectedModel, response.usage);
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
                  const artifactId = generateId();
                  const version = 1;
                  
                  const artifactDir = path.join(ARTIFACTS_DIR, artifactId);
                  await fs.mkdir(artifactDir, { recursive: true });
                  
                  const versionedFilename = `${toolInput.filename}_v${version}`;
                  const filePath = path.join(artifactDir, versionedFilename);
                  await fs.writeFile(filePath, toolInput.content, 'utf-8');
                  
                  const artifactMetadata = {
                    id: artifactId,
                    filename: toolInput.filename,
                    threadId: threadId,
                    currentVersion: version,
                    versions: [{
                      version,
                      filename: versionedFilename,
                      createdAt: new Date().toISOString(),
                      metadata: { description: toolInput.description || '' }
                    }],
                    createdAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString()
                  };
                  
                  const metadataPath = path.join(artifactDir, 'metadata.json');
                  await fs.writeFile(metadataPath, JSON.stringify(artifactMetadata, null, 2));
                  await updateThreadAfterArtifactChange(threadId);
                  
                  console.log(`  ✅ Artifact created: ${artifactId} (${toolInput.filename})`);

                  toolResult = {
                    success: true,
                    artifactId,
                    version,
                    filename: versionedFilename,
                    fileContent: toolInput.content,
                    message: `Successfully created artifact: ${toolInput.filename}`
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
              if (item.name === 'edit_artifact') {
                try {
                  console.log('  ✏️ Editing artifact...');
                  const artifactId = toolInput.artifact_id;
                  const artifactDir = path.join(ARTIFACTS_DIR, artifactId);
                  const metadataPath = path.join(artifactDir, 'metadata.json');
                  
                  const metadataContent = await fs.readFile(metadataPath, 'utf-8');
                  const artifactMetadata = JSON.parse(metadataContent);
                  
                  const newVersion = artifactMetadata.currentVersion + 1;
                  const versionedFilename = `${artifactMetadata.filename}_v${newVersion}`;
                  const filePath = path.join(artifactDir, versionedFilename);
                  
                  await fs.writeFile(filePath, toolInput.content, 'utf-8');
                  
                  artifactMetadata.currentVersion = newVersion;
                  artifactMetadata.versions.push({
                    version: newVersion,
                    filename: versionedFilename,
                    createdAt: new Date().toISOString(),
                    metadata: { description: toolInput.description || '' }
                  });
                  artifactMetadata.updatedAt = new Date().toISOString();
                  
                  await fs.writeFile(metadataPath, JSON.stringify(artifactMetadata, null, 2));
                  await updateThreadAfterArtifactChange(artifactMetadata.threadId);
                  
                  console.log(`  ✅ Artifact edited: ${artifactId} (v${newVersion})`);
                  
                  toolResult = {
                    success: true,
                    artifactId,
                    filename: versionedFilename,
                    fileContent: toolInput.content,
                    version: newVersion,
                    message: `Successfully updated artifact to version ${newVersion}`
                  };
                  
                  allToolCalls.push({
                    type: 'edit_artifact',
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
                    type: 'edit_artifact',
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
                  const fileContent = encoding === 'base64'
                    ? fileBuffer.toString('base64')
                    : fileBuffer.toString('utf-8');

                  toolResult = {
                    success: true,
                    artifactId,
                    filename: artifactMetadata.filename,
                    version: versionData.version,
                    encoding,
                    content: fileContent,
                    metadata: versionData.metadata ?? {},
                    message: `Successfully read artifact ${artifactMetadata.filename} (v${versionData.version})`
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
        if (toolCallsInThisIteration.some(call => ['create_artifact', 'edit_artifact'].includes(call.name))) {
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
app.get('/api/threads/:threadId/messages', async (req, res) => {
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
app.post('/api/artifacts', async (req, res) => {
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
app.get('/api/artifacts/:artifactId', async (req, res) => {
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
app.get('/api/artifacts/:artifactId/v:version', async (req, res) => {
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
app.put('/api/artifacts/:artifactId', async (req, res) => {
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
app.delete('/api/artifacts/:artifactId', async (req, res) => {
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
app.get('/api/artifacts', async (req, res) => {
  try {
    const { threadId } = req.query;
    const artifactDirs = await fs.readdir(ARTIFACTS_DIR);
    const artifacts = [];
    
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
app.post('/api/artifacts/upload', upload.array('files'), async (req, res) => {
  try {
    if (!req.files?.length) {
      return res.status(400).json({ error: 'ファイルが添付されていません。' });
    }

    const threadId = req.body.threadId || null;
    const metadataPayload = req.body.metadata ? JSON.parse(req.body.metadata) : {};

    const results = [];
    for (const file of req.files) {
      try {
        const fileMetadata = metadataPayload[file.originalname] || {};
        const record = await createArtifactRecord({
          filename: file.originalname,
          content: file.buffer,
          metadata: fileMetadata,
          threadId
        });
        results.push({ ...record, originalName: file.originalname });
      } catch (fileError) {
        results.push({
          originalName: file.originalname,
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
// サーバー起動
// ====================

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`GPT-5-Codex Backend API running on port ${PORT}`);
  console.log(`Data directory: ${DATA_DIR}`);
  console.log(`Artifacts directory: ${ARTIFACTS_DIR}`);
});