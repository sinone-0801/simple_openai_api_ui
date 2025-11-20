// manage-pending-users.js
// =============================================================================
// 承認待ちユーザー管理ツール
// =============================================================================
// このスクリプトは、/request-access コマンドで申請したユーザーの
// 承認・却下を簡単に行うためのCLIツールです。
//
// 使用方法:
// node manage-pending-users.js list              # 承認待ちユーザー一覧
// node manage-pending-users.js approve <user_id> # ユーザーを承認
// node manage-pending-users.js reject <user_id>  # ユーザーを却下
// node manage-pending-users.js approve-vip <user_id> # VIPとして承認
// =============================================================================

import { 
  initDatabase, 
  getAllUsers, 
  updateUser,
  Authority 
} from '../auth.js';

// =============================================================================
// ヘルパー関数
// =============================================================================

/**
 * テーブル形式で出力するヘルパー
 */
function printTable(headers, rows) {
  // 列幅の計算
  const colWidths = headers.map((header, i) => {
    const maxContentWidth = Math.max(...rows.map(row => String(row[i]).length));
    return Math.max(header.length, maxContentWidth);
  });

  // ヘッダーの出力
  console.log('');
  console.log(headers.map((h, i) => h.padEnd(colWidths[i])).join(' | '));
  console.log(colWidths.map(w => '-'.repeat(w)).join('-+-'));

  // 行の出力
  rows.forEach(row => {
    console.log(row.map((cell, i) => String(cell).padEnd(colWidths[i])).join(' | '));
  });
  console.log('');
}

/**
 * 承認待ちユーザー一覧を表示
 */
async function listPendingUsers() {
  const users = await getAllUsers();
  const pendingUsers = users.filter(u => u.authority === Authority.PENDING);

  if (pendingUsers.length === 0) {
    console.log('\n✅ 承認待ちのユーザーはいません。\n');
    return;
  }

  console.log(`\n📋 承認待ちユーザー (${pendingUsers.length}人):`);

  const headers = ['User ID', 'Group ID', 'Created At'];
  const rows = pendingUsers.map(u => [
    u.user_id,
    u.group_id || 'N/A',
    new Date(u.created_at).toLocaleString('ja-JP')
  ]);

  printTable(headers, rows);

  console.log('承認するには:');
  console.log('  node manage-pending-users.js approve <user_id>');
  console.log('  node manage-pending-users.js approve-vip <user_id>\n');
}

/**
 * すべてのユーザーを表示（権限フィルタ付き）
 */
async function listAllUsers(filterAuthority = null) {
  const users = await getAllUsers();
  let filteredUsers = users;

  if (filterAuthority) {
    filteredUsers = users.filter(u => u.authority === filterAuthority);
  }

  if (filteredUsers.length === 0) {
    console.log('\n✅ ユーザーが見つかりません。\n');
    return;
  }

  const title = filterAuthority 
    ? `📋 ${filterAuthority}ユーザー (${filteredUsers.length}人):`
    : `📋 全ユーザー (${filteredUsers.length}人):`;
  
  console.log(`\n${title}`);

  const headers = ['User ID', 'Authority', 'Credit', 'Group ID', 'Active'];
  const rows = filteredUsers.map(u => [
    u.user_id,
    u.authority,
    u.remaining_credit.toLocaleString(),
    u.group_id || 'N/A',
    u.isActive ? 'Yes' : 'No'
  ]);

  printTable(headers, rows);
}

/**
 * ユーザーを承認
 */
async function approveUser(userId, authority = Authority.USER) {
  try {
    const updated = await updateUser(userId, {
      authority: authority,
      remaining_credit: 10000000 // 10M tokens
    });

    if (!updated) {
      console.error(`\n❌ ユーザー ${userId} が見つかりません。\n`);
      return;
    }

    console.log(`\n✅ ユーザー ${userId} を ${authority} として承認しました。`);
    console.log(`   クレジット: 10,000,000 tokens\n`);
  } catch (error) {
    console.error(`\n❌ エラー: ${error.message}\n`);
  }
}

/**
 * ユーザーを却下（削除）
 */
async function rejectUser(userId) {
  try {
    // Pendingユーザーを削除（Stoppedに変更する方法もある）
    const updated = await updateUser(userId, {
      authority: Authority.STOPPED
    });

    if (!updated) {
      console.error(`\n❌ ユーザー ${userId} が見つかりません。\n`);
      return;
    }

    console.log(`\n✅ ユーザー ${userId} を却下しました（Stoppedステータスに変更）。\n`);
  } catch (error) {
    console.error(`\n❌ エラー: ${error.message}\n`);
  }
}

// =============================================================================
// メイン処理
// =============================================================================

async function main() {
  await initDatabase();

  const args = process.argv.slice(2);
  const command = args[0];
  const userId = args[1];

  if (!command) {
    console.log(`
使用方法:
  node manage-pending-users.js list              # 承認待ちユーザー一覧
  node manage-pending-users.js list-all          # 全ユーザー一覧
  node manage-pending-users.js approve <user_id> # ユーザーを承認（User権限）
  node manage-pending-users.js approve-vip <user_id> # VIPとして承認
  node manage-pending-users.js reject <user_id>  # ユーザーを却下

例:
  node manage-pending-users.js list
  node manage-pending-users.js approve 123456789012345678
  node manage-pending-users.js approve-vip 123456789012345678
  node manage-pending-users.js reject 123456789012345678
    `);
    process.exit(0);
  }

  switch (command) {
    case 'list':
      await listPendingUsers();
      break;

    case 'list-all':
      await listAllUsers();
      break;

    case 'list-admin':
      await listAllUsers(Authority.ADMIN);
      break;

    case 'list-vip':
      await listAllUsers(Authority.VIP);
      break;

    case 'list-user':
      await listAllUsers(Authority.USER);
      break;

    case 'approve':
      if (!userId) {
        console.error('\n❌ User IDを指定してください。\n');
        process.exit(1);
      }
      await approveUser(userId, Authority.USER);
      break;

    case 'approve-vip':
      if (!userId) {
        console.error('\n❌ User IDを指定してください。\n');
        process.exit(1);
      }
      await approveUser(userId, Authority.VIP);
      break;

    case 'reject':
      if (!userId) {
        console.error('\n❌ User IDを指定してください。\n');
        process.exit(1);
      }
      await rejectUser(userId);
      break;

    default:
      console.error(`\n❌ 不明なコマンド: ${command}\n`);
      console.log('使用可能なコマンド: list, list-all, approve, approve-vip, reject\n');
      process.exit(1);
  }

  process.exit(0);
}

// エラーハンドリング
process.on('unhandledRejection', (error) => {
  console.error('\n❌ エラーが発生しました:', error.message);
  process.exit(1);
});

// 実行
main();
