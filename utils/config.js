// utils/config.js
// アプリケーション全体の設定値と定数を管理

import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ====================
// 環境変数のバリデーション
// ====================

/**
 * 必須の環境変数をチェック
 * @throws {Error} 必須の環境変数が設定されていない場合
 */
export function validateRequiredEnvVars() {
  if (!process.env.OPENAI_API_KEY) {
    console.error('ERROR: OPENAI_API_KEY is not set in .env file');
    console.error('Please set OPENAI_API_KEY before starting the server.');
    process.exit(1);
  }

  if (!process.env.JWT_SECRET) {
    console.error('ERROR: JWT_SECRET is not set in environment variables');
    console.error('Please set JWT_SECRET before starting the server.');
    process.exit(1);
  }
}

// ====================
// JWT関連の設定
// ====================

/**
 * JWT署名用のシークレットキー
 * @type {string}
 */
export const JWT_SECRET = process.env.JWT_SECRET;

/**
 * JWTトークンの有効期限
 * @type {string}
 * @default '12h'
 */
export const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '12h';

// ====================
// UI表示設定
// ====================

/**
 * クレジット残高の最大表示値
 * @type {number}
 * @default 100000
 */
export const CREDIT_MAX_DISPLAY = parseInt(process.env.CREDIT_MAX_DISPLAY) || 100000;

// ====================
// ファイルアップロード設定
// ====================

/**
 * アップロード可能な最大ファイルサイズ (バイト)
 * @type {number}
 * @default 50MB
 */
export const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB

/**
 * 同時にアップロード可能な最大ファイル数
 * @type {number}
 * @default 20
 */
export const MAX_FILES = 20;

// ====================
// モデル関連の設定
// ====================

/**
 * デフォルトのAIモデル
 * @type {string}
 * @default 'gpt-5.1-codex'
 */
export const DEFAULT_MODEL = process.env.ORCHESTRATOR_MODEL || 'gpt-5.1-codex';

/**
 * 高コストモデルのトークンあたりのクレジットコスト
 * @type {number}
 * @default 10
 */
export const TOKEN_COST_HIGH = parseInt(process.env.TOKEN_COST_HIGH) || 10;

/**
 * 低コストモデルのトークンあたりのクレジットコスト
 * @type {number}
 * @default 1
 */
export const TOKEN_COST_LOW = parseInt(process.env.TOKEN_COST_LOW) || 1;

/**
 * 利用可能な全モデルのリスト
 * @type {string[]}
 */
export const AVAILABLE_MODELS = [
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

/**
 * 高コストモデルのリスト
 * @type {string[]}
 */
export const AVAILABLE_MODELS_HIGH_COST = [
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

/**
 * 低コストモデルのリスト
 * @type {string[]}
 */
export const AVAILABLE_MODELS_LOW_COST = [
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

/**
 * 推論能力を持つモデルのリスト
 * @type {string[]}
 */
export const REASONING_MODELS = [
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

/**
 * 推論能力を持たない通常のモデルのリスト
 * @type {string[]}
 */
export const NON_REASONING_MODELS = [
  'gpt-5-chat-latest',
  'gpt-4.1',
  'gpt-4o',
  'gpt-4.1-mini',
  'gpt-4.1-nano',
  'gpt-4o-mini'
];

/**
 * 無料枠の制限（トークン数）
 * @type {Object}
 * @property {number} highCost - 高コストモデルの1日あたりの無料トークン数
 * @property {number} lowCost - 低コストモデルの1日あたりの無料トークン数
 */
export const FREE_TIER_LIMITS = { 
  highCost: 1_000_000, 
  lowCost: 10_000_000 
};

/**
 * 制限警告を表示する閾値の割合
 * @type {number}
 * @default 0.8 (80%)
 */
export const LIMIT_THRESHOLD_RATIO = 0.8;

// ====================
// システムプロンプト関連
// ====================

/**
 * デフォルトのシステムプロンプト
 * @type {string}
 */
export const DEFAULT_SYSTEM_PROMPT = 'You are a helpful assistant.';

/**
 * 自動生成プロンプトの開始マーカー
 * @type {string}
 */
export const AUTO_PROMPT_MARKER_START = '-----\n[auto] thread_artifact_inventory\n';

/**
 * 自動生成プロンプトの終了マーカー
 * @type {string}
 */
export const AUTO_PROMPT_MARKER_END = '-----';

// ====================
// OpenAI API設定
// ====================

/**
 * OpenAI APIのタイムアウト時間（ミリ秒）
 * @type {number}
 * @default 1800000 (30分)
 */
export const OPENAI_API_TIMEOUT = 30 * 60 * 1000; // 30分

/**
 * OpenAI APIの最大リトライ回数
 * @type {number}
 * @default 2
 */
export const OPENAI_MAX_RETRIES = 2;

// ====================
// ディレクトリ・ファイルパス
// ====================

/**
 * アプリケーションのルートディレクトリ
 * @type {string}
 */
export const ROOT_DIR = path.dirname(__dirname);

/**
 * データファイル保存用ディレクトリ
 * @type {string}
 */
export const DATA_DIR = path.join(ROOT_DIR, 'data');

/**
 * アーティファクト保存用ディレクトリ
 * @type {string}
 */
export const ARTIFACTS_DIR = path.join(ROOT_DIR, 'artifacts');

/**
 * スレッド情報保存用JSONファイル
 * @type {string}
 */
export const THREADS_FILE = path.join(DATA_DIR, 'threads.json');

/**
 * トークン使用履歴CSVファイル
 * @type {string}
 */
export const TOKEN_LOG_FILE = path.join(DATA_DIR, 'token_usage.csv');

/**
 * システムプロンプト保存用JSONファイル
 * @type {string}
 */
export const SYSTEM_PROMPTS_FILE = path.join(DATA_DIR, 'system_prompts.json');

/**
 * レスポンスフォーマット保存用JSONファイル
 * @type {string}
 */
export const RESPONSE_FORMATS_FILE = path.join(DATA_DIR, 'response_formats.json');

// ====================
// ファイル名関連の定数
// ====================

/**
 * ファイル名に使用できない文字の正規表現
 * @type {RegExp}
 */
export const INVALID_FILENAME_CHARS_REGEX = /[\\/:*?"<>|]/g;

/**
 * アーティファクトのデフォルトファイル名
 * @type {string}
 */
export const DEFAULT_ARTIFACT_BASENAME = 'artifact';

// ====================
// サーバー設定
// ====================

/**
 * サーバーのポート番号
 * @type {number}
 * @default 3000
 */
export const PORT = process.env.PORT || 3000;

/**
 * ベースURL（Stripe決済のリダイレクト用など）
 * @type {string}
 */
export const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

// ====================
// 設定値のログ出力
// ====================

/**
 * 起動時に設定値をログ出力
 */
export function logConfiguration() {
  console.log(`Default model: ${DEFAULT_MODEL}`);
  console.log(`Available models: ${AVAILABLE_MODELS.join(', ')}`);
  console.log(`High cost models (free 1 million tokens / day): ${AVAILABLE_MODELS_HIGH_COST.join(', ')}`);
  console.log(`Low cost models (free 10 million tokens / day): ${AVAILABLE_MODELS_LOW_COST.join(', ')}`);
}
