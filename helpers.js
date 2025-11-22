// helpers.js
// server.jsから抽出したヘルパー関数群
// auth.jsにもpayment.jsにも置くべきでない、共通のユーティリティ関数を格納

import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import * as configs from './utils/config.js';
import * as auth from './auth.js';

// ====================
// システムプロンプト管理
// ====================

/**
 * システムプロンプトのハッシュを生成
 */
export function generatePromptHash(content) {
  return crypto.createHash('sha256').update(content, 'utf-8').digest('hex').substring(0, 16);
}

/**
 * システムプロンプトファイルの初期化
 */
export async function initSystemPrompts() {
  try {
    await fs.access(configs.SYSTEM_PROMPTS_FILE);
  } catch {
    await fs.writeFile(configs.SYSTEM_PROMPTS_FILE, JSON.stringify({}, null, 2));
  }
}

/**
 * システムプロンプトを読み込み
 */
export async function readSystemPrompts() {
  try {
    const data = await fs.readFile(configs.SYSTEM_PROMPTS_FILE, 'utf-8');
    return JSON.parse(data);
  } catch {
    return {};
  }
}

/**
 * システムプロンプトを保存
 */
export async function writeSystemPrompts(prompts) {
  await fs.writeFile(configs.SYSTEM_PROMPTS_FILE, JSON.stringify(prompts, null, 2));
}

/**
 * システムプロンプトを登録（バージョン管理）
 */
export async function registerSystemPrompt(content) {
  if (!content || typeof content !== 'string') {
    return null;
  }

  const hash = generatePromptHash(content);
  const prompts = await readSystemPrompts();

  if (!prompts[hash]) {
    prompts[hash] = {
      hash,
      content,
      createdAt: new Date().toISOString(),
      usageCount: 0
    };
    await writeSystemPrompts(prompts);
  }

  // 使用回数をインクリメント
  prompts[hash].usageCount++;
  await writeSystemPrompts(prompts);

  return hash;
}

/**
 * システムプロンプトを取得
 */
export async function getSystemPrompt(hash) {
  const prompts = await readSystemPrompts();
  return prompts[hash] || null;
}

// ====================
// Response Format管理
// ====================

/**
 * Response Formatのハッシュを生成
 */
export function generateResponseFormatHash(content) {
  const contentStr = typeof content === 'string' ? content : JSON.stringify(content);
  return crypto.createHash('sha256').update(contentStr, 'utf-8').digest('hex').substring(0, 16);
}

/**
 * Response Formatファイルの初期化
 */
export async function initResponseFormats() {
  try {
    await fs.access(configs.RESPONSE_FORMATS_FILE);
  } catch {
    await fs.writeFile(configs.RESPONSE_FORMATS_FILE, JSON.stringify({}, null, 2));
  }
}

/**
 * Response Formatを読み込み
 */
export async function readResponseFormats() {
  try {
    const data = await fs.readFile(configs.RESPONSE_FORMATS_FILE, 'utf-8');
    return JSON.parse(data);
  } catch {
    return {};
  }
}

/**
 * Response Formatを保存
 */
export async function writeResponseFormats(formats) {
  await fs.writeFile(configs.RESPONSE_FORMATS_FILE, JSON.stringify(formats, null, 2));
}

/**
 * Response Formatを登録（バージョン管理）
 */
export async function registerResponseFormat(content) {
  if (!content) {
    return null;
  }

  const hash = generateResponseFormatHash(content);
  const formats = await readResponseFormats();

  if (formats[hash]) {
    formats[hash].usageCount += 1;
    formats[hash].lastUsedAt = new Date().toISOString();
  } else {
    formats[hash] = {
      content,
      hash,
      createdAt: new Date().toISOString(),
      lastUsedAt: new Date().toISOString(),
      usageCount: 1
    };
  }

  await writeResponseFormats(formats);
  return hash;
}

// ====================
// ログ管理
// ====================

/**
 * CSVログファイルの初期化
 */
export async function initTokenLog() {
  try {
    await fs.access(configs.TOKEN_LOG_FILE);
  } catch {
    await fs.writeFile(configs.TOKEN_LOG_FILE, 'timestamp,model,input_tokens,output_tokens,total_tokens,user_id\n');
  }
}

/**
 * トークン使用量をログに記録
 */
export async function logTokenUsage(model, usage, userId = null) {
  if (!usage) return;
  const now = new Date();
  const timestamp = now.toISOString();
  const logEntry = `${timestamp},${model},${usage.input_tokens || 0},${usage.output_tokens || 0},${usage.total_tokens || 0},${userId || 'anonymous'}\n`;
  await fs.appendFile(configs.TOKEN_LOG_FILE, logEntry);

  // ユーザーのクレジット使用量を記録
  if (userId && usage.total_tokens) {
    try {
      // モデルに応じたクレジット消費量を計算
      const isHighCostModel = configs.AVAILABLE_MODELS_HIGH_COST.includes(model);
      const tokenCostRate = isHighCostModel ? configs.TOKEN_COST_HIGH : configs.TOKEN_COST_LOW;
      const creditsToConsume = usage.total_tokens * tokenCostRate;

      console.log(`[Credit] User: ${userId}, Model: ${model} (${isHighCostModel ? 'High' : 'Low'} cost), Tokens: ${usage.total_tokens}, Rate: ${tokenCostRate}, Credits consumed: ${creditsToConsume}`);

      await auth.recordCreditUsage(userId, creditsToConsume);
    } catch (error) {
      console.error('Failed to record credit usage:', error);
    }
  }
}

/**
 * CSVログを読み込んで解析
 */
export async function readTokenLog() {
  try {
    const content = await fs.readFile(configs.TOKEN_LOG_FILE, 'utf-8');
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

/**
 * ログの圧縮と削除を実行
 */
export async function compressAndCleanLogs() {
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
    await fs.writeFile(configs.TOKEN_LOG_FILE, csvContent);
    console.log('Token logs compressed and cleaned');
  } catch (error) {
    console.error('Error compressing logs:', error);
  }
}

/**
 * トークン使用量のサマリーを取得
 */
export async function getTokenUsageSummary(hours = 24, userId = null) {
  const logs = await readTokenLog();
  const now = new Date();
  const boundary = new Date(now.getTime() - hours * 60 * 60 * 1000);

  const summary = {
    highCost: { usage: 0, limit: configs.FREE_TIER_LIMITS.highCost },
    lowCost: { usage: 0, limit: configs.FREE_TIER_LIMITS.lowCost }
  };

  for (const log of logs) {
    if (log.timestamp < boundary) continue;
    
    // ユーザーIDでフィルタリング（指定された場合）
    if (userId && log.user_id !== userId) continue;
    
    if (configs.AVAILABLE_MODELS_HIGH_COST.includes(log.model)) {
      summary.highCost.usage += log.total_tokens;
    } else if (configs.AVAILABLE_MODELS_LOW_COST.includes(log.model)) {
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

// ====================
// トークン管理（JWT）
// ====================

/**
 * アクセストークンを生成
 */
export function createAccessToken(user) {
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
    configs.JWT_SECRET,
    { expiresIn: configs.JWT_EXPIRES_IN }
  );
}

// ====================
// スレッド管理
// ====================

/**
 * スレッド一覧を読み込み
 */
export async function readThreads() {
  try {
    const data = await fs.readFile(configs.THREADS_FILE, 'utf-8');
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

/**
 * スレッド一覧を保存
 */
export async function writeThreads(data) {
  await fs.writeFile(configs.THREADS_FILE, JSON.stringify(data, null, 2));
}

/**
 * 特定のスレッドを読み込み
 */
export async function readThread(threadId) {
  const threadPath = path.join(configs.DATA_DIR, `thread_${threadId}.json`);
  try {
    const data = await fs.readFile(threadPath, 'utf-8');
    const thread = JSON.parse(data);
    thread.artifactIds = Array.isArray(thread.artifactIds) ? thread.artifactIds : [];
    return thread;
  } catch {
    return null;
  }
}

/**
 * スレッドを保存
 */
export async function writeThread(threadId, data) {
  ensureThreadDefaults(data);
  const threadFile = path.join(configs.DATA_DIR, `thread_${threadId}.json`);
  await fs.writeFile(threadFile, JSON.stringify(data, null, 2));
}

/**
 * ランダムなIDを生成
 */
export function generateId() {
  return crypto.randomUUID();
}

/**
 * スレッドのデフォルト値を保証
 */
export function ensureThreadDefaults(thread) {
  if (!thread) return thread;
  if (!thread.systemPromptUser) {
    thread.systemPromptUser = thread.systemPrompt || configs.DEFAULT_SYSTEM_PROMPT;
  }
  if (!Array.isArray(thread.artifactIds)) {
    thread.artifactIds = [];
  }
  return thread;
}

// ====================
// アーティファクト管理
// ====================

/**
 * アーティファクトのメタデータを読み込み
 */
export async function readArtifactMetadata(artifactId) {
  const metadataPath = path.join(configs.ARTIFACTS_DIR, artifactId, 'metadata.json');
  const content = await fs.readFile(metadataPath, 'utf-8');
  return JSON.parse(content);
}

/**
 * スレッドのアーティファクトサマリーを収集
 */
export async function collectThreadArtifactSummaries(threadId) {
  const artifactDirs = await fs.readdir(configs.ARTIFACTS_DIR);
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

/**
 * ファイル名をサニタイズ（安全な文字列に変換）
 */
export function sanitizeFilename(filename) {
  if (typeof filename !== 'string') {
    return configs.DEFAULT_ARTIFACT_BASENAME;
  }
  const trimmed = filename.trim();
  if (!trimmed) {
    return configs.DEFAULT_ARTIFACT_BASENAME;
  }
  const base = path.basename(trimmed);
  const sanitized = base.replace(configs.INVALID_FILENAME_CHARS_REGEX, '_');
  return sanitized || configs.DEFAULT_ARTIFACT_BASENAME;
}

/**
 * Multerのファイル名をデコード
 */
export function decodeMulterFilename(name) {
  if (typeof name !== 'string') {
    return configs.DEFAULT_ARTIFACT_BASENAME;
  }
  return Buffer.from(name, 'latin1').toString('utf8');
}

/**
 * システムプロンプトを構成（ユーザープロンプト + アーティファクト情報）
 */
export function composeSystemPrompt(userPrompt = configs.DEFAULT_SYSTEM_PROMPT, artifactSummaries = []) {
  const sanitized = userPrompt.trim() || configs.DEFAULT_SYSTEM_PROMPT;
  const inventoryJson = JSON.stringify(
    artifactSummaries.map(({ id, name, description }) => ({ id, name, description })),
    null,
    2
  );
  const autoBlock = [
    configs.AUTO_PROMPT_MARKER_START.trim(),
    inventoryJson,
    configs.AUTO_PROMPT_MARKER_END.trim()
  ].join('\n') + '\n';
  return `${sanitized}\n\n${autoBlock}`;
}

/**
 * 配列の等価性チェック
 */
export function arraysEqual(a = [], b = []) {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/**
 * スレッドサマリーのメタデータを更新
 */
export async function updateThreadSummaryMetadata(thread) {
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

/**
 * スレッドの派生状態をリフレッシュ（systemPrompt再構成など）
 */
export async function refreshThreadDerivedState(thread, { persist = true } = {}) {
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

/**
 * アーティファクト変更後にスレッドを更新
 */
export async function updateThreadAfterArtifactChange(threadId) {
  if (!threadId) return;
  const thread = await readThread(threadId);
  if (!thread) return;
  await refreshThreadDerivedState(thread, { persist: true });
}

/**
 * アーティファクトディレクトリを作成
 */
export async function ensureArtifactDir(artifactId) {
  const artifactDir = path.join(configs.ARTIFACTS_DIR, artifactId);
  await fs.mkdir(artifactDir, { recursive: true });
  return artifactDir;
}

/**
 * バージョン付きファイル名を生成
 */
export function buildVersionedFilename(filename, version) {
  const parsed = path.parse(filename);
  const safeName = parsed.name || configs.DEFAULT_ARTIFACT_BASENAME;
  const safeExt = parsed.ext || '';
  return `${safeName}_v${version}${safeExt}`;
}

/**
 * アーティファクトファイルを書き込み
 */
export async function writeArtifactFile(filePath, content) {
  const data = Buffer.isBuffer(content) ? content : Buffer.from(content);
  await fs.writeFile(filePath, data);
}

/**
 * アーティファクトレコードを作成
 */
export async function createArtifactRecord({ filename, content, metadata = {}, threadId = null }) {
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

/**
 * アーティファクトの新バージョンを追加
 */
export async function appendArtifactVersion({ artifactId, content, metadata = {} }) {
  const artifactDir = path.join(configs.ARTIFACTS_DIR, artifactId);
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

// ====================
// パッチ関数群（patch_artifact用）
// ====================

/**
 * 正規表現の特殊文字をエスケープ
 */
export function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * パターン内の連続空白を \s+ に変換した正規表現を生成
 */
export function buildFlexiblePattern(pattern) {
  const tokens = pattern.trim().split(/\s+/).map(escapeRegExp);
  if (tokens.length === 0) {
    throw new Error('Pattern must contain at least one non-whitespace character');
  }
  return new RegExp(tokens.join('\\s+'), 'g');
}

/**
 * マッチ範囲の先頭／末尾から余分な空白を取り除いたオフセットを返す
 */
export function trimWhitespaceAroundMatch(text, start, end) {
  while (start < end && /\s/.test(text[start])) start += 1;
  while (end > start && /\s/.test(text[end - 1])) end -= 1;
  return { start, end };
}

/**
 * 柔軟な空白マッチを考慮して全マッチを返す（オフセットベース）
 */
export function findAllMatches(content, pattern) {
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
export function pairStartEnd(startMatches, endMatches, startPattern, endPattern) {
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
export function applyPatches(content, edits) {
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

// ====================
// バリデーション
// ====================

/**
 * モデルのバリデーション
 */
export function validateModel(model) {
  if (!model) {
    return { valid: true, model: configs.DEFAULT_MODEL };
  }
  
  if (configs.AVAILABLE_MODELS.includes(model)) {
    return { valid: true, model };
  }
  
  return { 
    valid: false, 
    error: `Invalid model: ${model}. Available models: ${configs.AVAILABLE_MODELS.join(', ')}` 
  };
}

/**
 * Reasoningモデルかどうかを判定
 */
export function isReasoningModel(model) {
  return configs.REASONING_MODELS.includes(model);
}

// ====================
// グループスレッド管理
// ====================

/**
 * グループスレッドIDかどうかを判定
 * グループスレッドIDは末尾が "_g" で終わる
 */
export function isGroupThreadId(threadId) {
  return threadId && threadId.endsWith('_g');
}

/**
 * チャンネルIDからグループスレッドIDを生成
 */
export function getGroupThreadId(channelId) {
  return `thread-${channelId}_g`;
}

/**
 * グループスレッドを作成または取得
 */
export async function getOrCreateGroupThread(userId, guildId, channelId, channelName, guildName, options = {}) {
  const threadId = getGroupThreadId(channelId);
  
  // 既存のスレッドがあるか確認
  const existingThread = await readThread(threadId);
  if (existingThread) {
    return threadId;
  }
  
  // 新規作成
  const timestamp = new Date().toISOString();
  const {
    title = `Group: ${channelName}`,
    systemPrompt = configs.DEFAULT_SYSTEM_PROMPT,
    model = configs.DEFAULT_MODEL,
    responseFormat = null,
    reasoningEffort = 'medium'
  } = options;
  
  const userPrompt = (systemPrompt || configs.DEFAULT_SYSTEM_PROMPT).trim();
  
  // Response Formatを登録
  const responseFormatHash = responseFormat ? await registerResponseFormat(responseFormat) : null;
  
  const newThreadSummary = {
    id: threadId,
    title,
    userId,
    createdAt: timestamp,
    updatedAt: timestamp,
    artifactIds: [],
    metadata: {
      isGroupThread: true,
      guildId,
      guildName,
      channelId,
      channelName
    }
  };
  
  const threadData = {
    id: threadId,
    title: newThreadSummary.title,
    systemPromptUser: userPrompt,
    userId,
    systemPrompt: composeSystemPrompt(userPrompt, []),
    model,
    responseFormatHash,
    reasoningEffort,
    messages: [],
    artifactIds: [],
    createdAt: timestamp,
    updatedAt: timestamp,
    metadata: newThreadSummary.metadata
  };
  
  const threads = await readThreads();
  threads.threads.push(newThreadSummary);
  await writeThreads(threads);
  await writeThread(threadId, threadData);
  
  return threadId;
}
