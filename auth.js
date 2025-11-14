// auth.js
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// データベースファイルのパス
const DB_PATH = path.join(__dirname, 'data', 'users.db');

// データベース接続
let db = null;

// Authority レベル
export const Authority = {
  ADMIN: 'Admin',
  VIP: 'Vip',
  USER: 'User',
  STOPPED: 'Stopped',
  BANNED: 'Banned'
};

// データベースの初期化
export async function initDatabase() {
  db = await open({
    filename: DB_PATH,
    driver: sqlite3.Database
  });

  // ユーザーテーブルの作成
  await db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      user_id TEXT PRIMARY KEY,
      password_hash TEXT,
      salt TEXT,
      group_id TEXT,
      thread_id TEXT,
      authority TEXT NOT NULL DEFAULT 'User',
      used_credit INTEGER DEFAULT 0,
      remaining_credit INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_login DATETIME,
      is_active INTEGER DEFAULT 1
    );

    CREATE INDEX IF NOT EXISTS idx_group_id ON users(group_id);
    CREATE INDEX IF NOT EXISTS idx_authority ON users(authority);
    CREATE INDEX IF NOT EXISTS idx_is_active ON users(is_active);
  `);

  console.log('User database initialized');
}

// パスワードのハッシュ化
function hashPassword(password, salt) {
  return crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
}

// ソルトの生成
function generateSalt() {
  return crypto.randomBytes(32).toString('hex');
}

// ユーザーの作成
export async function createUser({ 
  userId, 
  password = null, 
  groupId = null, 
  threadId = null, 
  authority = Authority.USER,
  remainingCredit = 10000 // デフォルト10,000クレジット（計量モデルで1/token消費、重いモデルで10/token消費くらい？）
}) {
  if (!userId) {
    throw new Error('User ID is required');
  }

  // 既存ユーザーチェック
  const existing = await db.get('SELECT user_id FROM users WHERE user_id = ?', [userId]);
  if (existing) {
    throw new Error('User already exists');
  }

  let passwordHash = null;
  let salt = null;

  if (password) {
    salt = generateSalt();
    passwordHash = hashPassword(password, salt);
  }

  await db.run(`
    INSERT INTO users (
      user_id, password_hash, salt, group_id, thread_id, 
      authority, remaining_credit, is_active
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 1)
  `, [userId, passwordHash, salt, groupId, threadId, authority, remainingCredit]);

  return {
    userId,
    groupId,
    threadId,
    authority,
    remainingCredit
  };
}

// ユーザー認証（UserID + Password）
export async function authenticateWithPassword(userId, password) {
  const user = await db.get(`
    SELECT * FROM users 
    WHERE user_id = ? AND is_active = 1
  `, [userId]);

  if (!user) {
    return null;
  }

  // 停止・BAN済みユーザーのチェック
  if (user.authority === Authority.STOPPED || user.authority === Authority.BANNED) {
    throw new Error(`Account is ${user.authority.toLowerCase()}`);
  }

  // パスワードチェック
  if (!user.password_hash || !user.salt) {
    return null;
  }

  const hash = hashPassword(password, user.salt);
  if (hash !== user.password_hash) {
    return null;
  }

  // 最終ログイン時刻を更新
  await db.run('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE user_id = ?', [userId]);

  return sanitizeUser(user);
}

// ユーザー認証（UserID + GroupID）
export async function authenticateWithGroup(userId, groupId) {
  const user = await db.get(`
    SELECT * FROM users 
    WHERE user_id = ? AND group_id = ? AND is_active = 1
  `, [userId, groupId]);

  if (!user) {
    return null;
  }

  // 停止・BAN済みユーザーのチェック
  if (user.authority === Authority.STOPPED || user.authority === Authority.BANNED) {
    throw new Error(`Account is ${user.authority.toLowerCase()}`);
  }

  // 最終ログイン時刻を更新
  await db.run('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE user_id = ?', [userId]);

  return sanitizeUser(user);
}

// ユーザー情報の取得
export async function getUser(userId) {
  const user = await db.get('SELECT * FROM users WHERE user_id = ?', [userId]);
  return user ? sanitizeUser(user) : null;
}

// 全ユーザーの取得（Admin用）
export async function getAllUsers() {
  const users = await db.all('SELECT * FROM users ORDER BY created_at DESC');
  return users.map(sanitizeUser);
}

// ユーザー情報の更新
export async function updateUser(userId, updates) {
  const allowedFields = ['group_id', 'thread_id', 'authority', 'remaining_credit'];
  const updateFields = [];
  const values = [];

  for (const [key, value] of Object.entries(updates)) {
    if (allowedFields.includes(key)) {
      updateFields.push(`${key} = ?`);
      values.push(value);
    }
  }

  if (updateFields.length === 0) {
    throw new Error('No valid fields to update');
  }

  values.push(userId);
  
  await db.run(`
    UPDATE users 
    SET ${updateFields.join(', ')}, updated_at = CURRENT_TIMESTAMP 
    WHERE user_id = ?
  `, values);

  return getUser(userId);
}

// パスワードの変更
export async function changePassword(userId, oldPassword, newPassword) {
  const user = await db.get('SELECT * FROM users WHERE user_id = ?', [userId]);
  
  if (!user) {
    throw new Error('User not found');
  }

  // 既存パスワードの確認（oldPasswordが空文字列の場合はスキップ - 管理者による強制変更）
  if (oldPassword && user.password_hash && user.salt) {
    const hash = hashPassword(oldPassword, user.salt);
    if (hash !== user.password_hash) {
      throw new Error('Invalid old password');
    }
  }

  // 新しいパスワードの設定
  const newSalt = generateSalt();
  const newHash = hashPassword(newPassword, newSalt);

  await db.run(`
    UPDATE users 
    SET password_hash = ?, salt = ?, updated_at = CURRENT_TIMESTAMP 
    WHERE user_id = ?
  `, [newHash, newSalt, userId]);

  return true;
}

// アカウント停止（Admin用）
export async function stopAccount(adminUserId, targetUserId) {
  const admin = await getUser(adminUserId);
  if (!admin || admin.authority !== Authority.ADMIN) {
    throw new Error('Unauthorized: Admin only');
  }

  await db.run(`
    UPDATE users 
    SET authority = ?, updated_at = CURRENT_TIMESTAMP 
    WHERE user_id = ?
  `, [Authority.STOPPED, targetUserId]);

  return getUser(targetUserId);
}

// アカウントBAN（Admin用）
export async function banAccount(adminUserId, targetUserId) {
  const admin = await getUser(adminUserId);
  if (!admin || admin.authority !== Authority.ADMIN) {
    throw new Error('Unauthorized: Admin only');
  }

  await db.run(`
    UPDATE users 
    SET authority = ?, is_active = 0, updated_at = CURRENT_TIMESTAMP 
    WHERE user_id = ?
  `, [Authority.BANNED, targetUserId]);

  return getUser(targetUserId);
}

// アカウントの復活（Admin用）
export async function reactivateAccount(adminUserId, targetUserId, authority = Authority.USER) {
  const admin = await getUser(adminUserId);
  if (!admin || admin.authority !== Authority.ADMIN) {
    throw new Error('Unauthorized: Admin only');
  }

  await db.run(`
    UPDATE users 
    SET authority = ?, is_active = 1, updated_at = CURRENT_TIMESTAMP 
    WHERE user_id = ?
  `, [authority, targetUserId]);

  return getUser(targetUserId);
}

// アカウント削除（Admin用）
export async function deleteAccount(adminUserId, targetUserId) {
  const admin = await getUser(adminUserId);
  if (!admin || admin.authority !== Authority.ADMIN) {
    throw new Error('Unauthorized: Admin only');
  }

  // Adminアカウントの削除は禁止
  const target = await getUser(targetUserId);
  if (target && target.authority === Authority.ADMIN) {
    throw new Error('Cannot delete admin account');
  }

  await db.run('DELETE FROM users WHERE user_id = ?', [targetUserId]);
  return { message: 'User deleted successfully' };
}

// クレジット使用量の記録
export async function recordCreditUsage(userId, tokens) {
  const user = await getUser(userId);
  if (!user) {
    throw new Error('User not found');
  }

  await db.run(`
    UPDATE users 
    SET used_credit = used_credit + ?, 
        remaining_credit = remaining_credit - ?,
        updated_at = CURRENT_TIMESTAMP 
    WHERE user_id = ?
  `, [tokens, tokens, userId]);

  return getUser(userId);
}

// クレジットの追加（Admin用）
export async function addCredit(adminUserId, targetUserId, amount) {
  const admin = await getUser(adminUserId);
  if (!admin || admin.authority !== Authority.ADMIN) {
    throw new Error('Unauthorized: Admin only');
  }

  await db.run(`
    UPDATE users 
    SET remaining_credit = remaining_credit + ?,
        updated_at = CURRENT_TIMESTAMP 
    WHERE user_id = ?
  `, [amount, targetUserId]);

  return getUser(targetUserId);
}

// クレジットのリセット（Admin用）
export async function resetCredit(adminUserId, targetUserId, amount) {
  const admin = await getUser(adminUserId);
  if (!admin || admin.authority !== Authority.ADMIN) {
    throw new Error('Unauthorized: Admin only');
  }

  await db.run(`
    UPDATE users 
    SET remaining_credit = ?,
        used_credit = 0,
        updated_at = CURRENT_TIMESTAMP 
    WHERE user_id = ?
  `, [amount, targetUserId]);

  return getUser(targetUserId);
}

// ユーザー情報のサニタイズ（パスワードハッシュなどを除外）
function sanitizeUser(user) {
  const { password_hash, salt, ...sanitized } = user;
  return {
    ...sanitized,
    isActive: Boolean(user.is_active)
  };
}

// Admin権限チェック
export async function isAdmin(userId) {
  const user = await getUser(userId);
  return user && user.authority === Authority.ADMIN;
}

// クレジット残高チェック
export async function hasEnoughCredit(userId, requiredTokens) {
  const user = await getUser(userId);
  if (!user) {
    return false;
  }
  return user.remaining_credit >= requiredTokens;
}

// データベースのクローズ
export async function closeDatabase() {
  if (db) {
    await db.close();
    console.log('Database connection closed');
  }
}
