// utils/oauth-state-validation.js

// ==================================================
// Discord OAuth2 State検証の実装
// ==================================================

import crypto from 'crypto';
import Database from 'better-sqlite3';

// ==================================================
// データベースベース
// ==================================================

export class OAuthStateManager {
  constructor(dbPath = './data/auth.db') {
    this.db = new Database(dbPath);
    this.initDatabase();
  }

  initDatabase() {
    // oauth_states テーブルを作成
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS oauth_states (
        state TEXT PRIMARY KEY,
        user_id TEXT,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        metadata TEXT
      )
    `);

    // 有効期限切れのstateを削除するインデックス
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_oauth_states_expires_at 
      ON oauth_states(expires_at)
    `);

    console.log('OAuth states table initialized');
  }

  /**
   * 新しいstateを生成して保存
   * @param {string} userId - ユーザーID（オプション）
   * @param {object} metadata - 追加のメタデータ（オプション）
   * @param {number} expiresInMinutes - 有効期限（分）デフォルト10分
   * @returns {string} 生成されたstate
   */
  generateState(userId = null, metadata = {}, expiresInMinutes = 10) {
    const state = crypto.randomBytes(32).toString('hex');
    const now = Date.now();
    const expiresAt = now + (expiresInMinutes * 60 * 1000);

    const stmt = this.db.prepare(`
      INSERT INTO oauth_states (state, user_id, created_at, expires_at, metadata)
      VALUES (?, ?, ?, ?, ?)
    `);

    stmt.run(
      state,
      userId,
      now,
      expiresAt,
      JSON.stringify(metadata)
    );

    return state;
  }

  /**
   * stateを検証
   * @param {string} state - 検証するstate
   * @returns {object|null} 検証成功時はstateの情報、失敗時はnull
   */
  validateState(state) {
    if (!state) {
      return null;
    }

    const stmt = this.db.prepare(`
      SELECT * FROM oauth_states WHERE state = ?
    `);

    const record = stmt.get(state);

    if (!record) {
      console.log('[OAuth] State not found:', state);
      return null;
    }

    const now = Date.now();

    // 有効期限をチェック
    if (record.expires_at < now) {
      console.log('[OAuth] State expired:', state);
      this.deleteState(state);
      return null;
    }

    // 検証成功 - stateを削除（使い捨て）
    this.deleteState(state);
    console.log('[OAuth] State validated:', record);
    return {
      userId: record.user_id,
      createdAt: record.created_at,
      metadata: record.metadata ? JSON.parse(record.metadata) : {}
    };
  }

  /**
   * stateを削除
   */
  deleteState(state) {
    const stmt = this.db.prepare(`
      DELETE FROM oauth_states WHERE state = ?
    `);
    stmt.run(state);
  }

  /**
   * 期限切れのstateをクリーンアップ
   */
  cleanupExpiredStates() {
    const now = Date.now();
    const stmt = this.db.prepare(`
      DELETE FROM oauth_states WHERE expires_at < ?
    `);
    const result = stmt.run(now);
    
    if (result.changes > 0) {
      console.log(`[OAuth] Cleaned up ${result.changes} expired states`);
    }
    
    return result.changes;
  }

  /**
   * 特定ユーザーのstateを全て削除
   */
  deleteUserStates(userId) {
    const stmt = this.db.prepare(`
      DELETE FROM oauth_states WHERE user_id = ?
    `);
    return stmt.run(userId).changes;
  }
}

// シングルトンインスタンス
let stateManagerInstance = null;

export function getStateManager(dbPath) {
  if (!stateManagerInstance) {
    stateManagerInstance = new OAuthStateManager(dbPath);
  }
  return stateManagerInstance;
}
