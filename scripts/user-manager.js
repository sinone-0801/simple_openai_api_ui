// user-manager.js
// 対話形式のユーザー管理CLIツール

import 'dotenv/config';
import * as auth from '../auth.js';
import fs from 'fs/promises';
import readline from 'readline';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function question(prompt) {
  return new Promise((resolve) => {
    rl.question(prompt, resolve);
  });
}

// メニュー表示
function displayMenu() {
  const botUserId = process.env.BOT_USER_ID;
  console.log('\n' + '='.repeat(60));
  console.log('User Management CLI');
  console.log('='.repeat(60));
  console.log('\n【メニュー】');
  console.log('  1. ユーザー一覧表示');
  console.log('  2. ユーザー作成');
  console.log('  3. ユーザー情報更新');
  console.log('  4. パスワード変更');
  console.log('  5. クレジット付与');
  console.log('  6. クレジットリセット');
  console.log('  7. ユーザー削除');
  console.log('  8. アカウント停止');
  console.log('  9. アカウントBAN');
  console.log(' 10. アカウント復活');
  console.log(' 11. CSV出力（全ユーザー情報）');
  console.log(' 12. CSVインポート（ユーザー情報上書き）');
  console.log(' 13. 初期セットアップ（最初の管理者を作成）');
  console.log(
    ` 14. BOTアカウント発行（${
      botUserId ? `推奨: ${botUserId}` : '.env の BOT_USER_ID 未設定'
    }）`
  );
  console.log('  0. 終了');
  console.log('='.repeat(60));
}

// ユーザー一覧表示
async function listUsers() {
  console.log('\n' + '-'.repeat(60));
  console.log('ユーザー一覧');
  console.log('-'.repeat(60));
  
  const users = await auth.getAllUsers();
  
  if (users.length === 0) {
    console.log('ユーザーが登録されていません。');
    return;
  }

  console.log(`\n登録ユーザー数: ${users.length}\n`);
  
  // テーブル形式で表示
  console.log('ID'.padEnd(20) + 
              'Authority'.padEnd(12) + 
              'Remaining'.padEnd(15) + 
              'Used'.padEnd(15) + 
              'Active');
  console.log('-'.repeat(60));
  
  for (const user of users) {
    const isActive = user.is_active ? '✓' : '✗';
    const remaining = user.remaining_credit.toLocaleString().padEnd(14);
    const used = user.used_credit.toLocaleString().padEnd(14);
    
    console.log(
      user.user_id.padEnd(20) +
      user.authority.padEnd(12) +
      remaining +
      used +
      isActive
    );
  }
  
  console.log('-'.repeat(60));
}

// ユーザー作成
async function createUser() {
  console.log('\n' + '-'.repeat(60));
  console.log('新規ユーザー作成');
  console.log('-'.repeat(60));
  
  const userId = await question('\nUser ID: ');
  if (!userId.trim()) {
    console.log('❌ User IDは必須です。');
    return;
  }

  console.log('\n認証方式を選択:');
  console.log('  1. パスワード認証');
  console.log('  2. グループID認証（Discord/Line）');
  console.log('  3. 両方設定');
  const authType = await question('選択 (1-3): ');

  let password = null;
  let groupId = null;
  let threadId = null;

  if (authType === '1' || authType === '3') {
    password = await question('Password: ');
    if (!password.trim()) {
      console.log('❌ パスワードは必須です。');
      return;
    }
  }

  if (authType === '2' || authType === '3') {
    groupId = await question('Group ID (Discord Guild ID / Line Group ID): ');
    threadId = await question('Thread ID (Discord Channel ID / Line Room ID, オプション): ');
  }

  console.log('\n権限レベルを選択:');
  console.log('  1. Admin  - 全機能アクセス可能');
  console.log('  2. Vip    - クレジット無制限');
  console.log('  3. User   - 通常ユーザー');
  console.log('  4. Stopped - アカウント停止中');
  console.log('  5. Banned - アカウントBAN済み');
  const authorityChoice = await question('選択 (1-5, デフォルト: 3): ');

  const authorityMap = {
    '1': auth.Authority.ADMIN,
    '2': auth.Authority.VIP,
    '3': auth.Authority.USER,
    '4': auth.Authority.STOPPED,
    '5': auth.Authority.BANNED
  };
  const authority = authorityMap[authorityChoice] || auth.Authority.USER;

  const creditInput = await question('初期クレジット (デフォルト: 10000000): ');
  const remainingCredit = parseInt(creditInput) || 10000000;

  try {
    const user = await auth.createUser({
      userId: userId.trim(),
      password: password ? password.trim() : null,
      groupId: groupId ? groupId.trim() : null,
      threadId: threadId ? threadId.trim() : null,
      authority,
      remainingCredit
    });

    console.log('\n✓ ユーザーを作成しました！');
    console.log('-'.repeat(60));
    console.log('User ID:          ', user.userId);
    console.log('Authority:        ', user.authority);
    console.log('Group ID:         ', user.groupId || 'N/A');
    console.log('Thread ID:        ', user.threadId || 'N/A');
    console.log('Remaining Credit: ', user.remainingCredit.toLocaleString());
    console.log('-'.repeat(60));

    if (password) {
      console.log('\n認証トークン（パスワード認証）:');
      console.log(`Bearer ${user.userId}:${password}`);
    }
    if (groupId) {
      console.log('\n認証トークン（グループ認証）:');
      console.log(`Bearer ${user.userId}:${user.groupId}:group`);
    }
  } catch (error) {
    console.log(`\n❌ エラー: ${error.message}`);
  }
}

// ユーザー情報更新
async function updateUser() {
  console.log('\n' + '-'.repeat(60));
  console.log('ユーザー情報更新');
  console.log('-'.repeat(60));

  const userId = await question('\nUser ID: ');
  if (!userId.trim()) {
    console.log('❌ User IDは必須です。');
    return;
  }

  const user = await auth.getUser(userId.trim());
  if (!user) {
    console.log('❌ ユーザーが見つかりません。');
    return;
  }

  console.log('\n現在の情報:');
  console.log('-'.repeat(60));
  console.log('User ID:          ', user.user_id);
  console.log('Authority:        ', user.authority);
  console.log('Group ID:         ', user.group_id || 'N/A');
  console.log('Thread ID:        ', user.thread_id || 'N/A');
  console.log('Remaining Credit: ', user.remaining_credit.toLocaleString());
  console.log('Used Credit:      ', user.used_credit.toLocaleString());
  console.log('-'.repeat(60));

  console.log('\n変更する項目を選択:');
  console.log('  1. Group ID');
  console.log('  2. Thread ID');
  console.log('  3. Authority');
  console.log('  4. Remaining Credit');
  console.log('  5. すべて更新');
  const choice = await question('選択 (1-5): ');

  const updates = {};

  if (choice === '1' || choice === '5') {
    const groupId = await question(`Group ID (現在: ${user.group_id || 'N/A'}, 空欄でスキップ): `);
    if (groupId.trim()) {
      updates.group_id = groupId.trim();
    }
  }

  if (choice === '2' || choice === '5') {
    const threadId = await question(`Thread ID (現在: ${user.thread_id || 'N/A'}, 空欄でスキップ): `);
    if (threadId.trim()) {
      updates.thread_id = threadId.trim();
    }
  }

  if (choice === '3' || choice === '5') {
    console.log('\n権限レベルを選択:');
    console.log('  1. Admin');
    console.log('  2. Vip');
    console.log('  3. User');
    console.log('  4. Stopped');
    console.log('  5. Banned');
    const authorityChoice = await question(`選択 (1-5, 現在: ${user.authority}, 空欄でスキップ): `);
    
    const authorityMap = {
      '1': auth.Authority.ADMIN,
      '2': auth.Authority.VIP,
      '3': auth.Authority.USER,
      '4': auth.Authority.STOPPED,
      '5': auth.Authority.BANNED
    };
    
    if (authorityMap[authorityChoice]) {
      updates.authority = authorityMap[authorityChoice];
    }
  }

  if (choice === '4' || choice === '5') {
    const credit = await question(`Remaining Credit (現在: ${user.remaining_credit.toLocaleString()}, 空欄でスキップ): `);
    if (credit.trim()) {
      updates.remaining_credit = parseInt(credit);
    }
  }

  if (Object.keys(updates).length === 0) {
    console.log('\n更新する項目がありません。');
    return;
  }

  try {
    const updatedUser = await auth.updateUser(userId.trim(), updates);
    console.log('\n✓ ユーザー情報を更新しました！');
    console.log('-'.repeat(60));
    console.log('User ID:          ', updatedUser.user_id);
    console.log('Authority:        ', updatedUser.authority);
    console.log('Group ID:         ', updatedUser.group_id || 'N/A');
    console.log('Thread ID:        ', updatedUser.thread_id || 'N/A');
    console.log('Remaining Credit: ', updatedUser.remaining_credit.toLocaleString());
    console.log('-'.repeat(60));
  } catch (error) {
    console.log(`\n❌ エラー: ${error.message}`);
  }
}

// パスワード変更
async function changePassword() {
  console.log('\n' + '-'.repeat(60));
  console.log('パスワード変更');
  console.log('-'.repeat(60));

  const userId = await question('\nUser ID: ');
  if (!userId.trim()) {
    console.log('❌ User IDは必須です。');
    return;
  }

  const user = await auth.getUser(userId.trim());
  if (!user) {
    console.log('❌ ユーザーが見つかりません。');
    return;
  }

  console.log('\n⚠️  注意: 管理者としてパスワードを直接設定します。');
  console.log('現在のパスワードの確認は不要です。\n');

  const newPassword = await question('新しいパスワード: ');
  if (!newPassword.trim()) {
    console.log('❌ パスワードは必須です。');
    return;
  }

  const confirm = await question('パスワードを確認: ');
  if (newPassword !== confirm) {
    console.log('❌ パスワードが一致しません。');
    return;
  }

  try {
    // 管理者による強制的なパスワード設定
    await auth.changePassword(userId.trim(), '', newPassword.trim());
    console.log('\n✓ パスワードを変更しました！');
    console.log('\n認証トークン:');
    console.log(`Bearer ${userId.trim()}:${newPassword.trim()}`);
  } catch (error) {
    console.log(`\n❌ エラー: ${error.message}`);
  }
}

// クレジット付与
async function addCredit() {
  console.log('\n' + '-'.repeat(60));
  console.log('クレジット付与');
  console.log('-'.repeat(60));

  const userId = await question('\nUser ID: ');
  if (!userId.trim()) {
    console.log('❌ User IDは必須です。');
    return;
  }

  const user = await auth.getUser(userId.trim());
  if (!user) {
    console.log('❌ ユーザーが見つかりません。');
    return;
  }

  console.log(`\n現在のクレジット: ${user.remaining_credit.toLocaleString()} tokens`);

  const amount = await question('付与するクレジット: ');
  const amountNum = parseInt(amount);

  if (isNaN(amountNum) || amountNum <= 0) {
    console.log('❌ 正の整数を入力してください。');
    return;
  }

  try {
    // 一時的にAdminユーザーを作成して操作
    const adminId = '__temp_admin__';
    await auth.createUser({
      userId: adminId,
      authority: auth.Authority.ADMIN,
      remainingCredit: 0
    }).catch(() => {}); // 既に存在する場合は無視

    const updatedUser = await auth.addCredit(adminId, userId.trim(), amountNum);

    console.log('\n✓ クレジットを付与しました！');
    console.log('-'.repeat(60));
    console.log('User ID:              ', updatedUser.user_id);
    console.log('付与額:               ', amountNum.toLocaleString());
    console.log('更新後のクレジット:    ', updatedUser.remaining_credit.toLocaleString());
    console.log('-'.repeat(60));
  } catch (error) {
    console.log(`\n❌ エラー: ${error.message}`);
  }
}

// クレジットリセット
async function resetCredit() {
  console.log('\n' + '-'.repeat(60));
  console.log('クレジットリセット');
  console.log('-'.repeat(60));

  const userId = await question('\nUser ID: ');
  if (!userId.trim()) {
    console.log('❌ User IDは必須です。');
    return;
  }

  const user = await auth.getUser(userId.trim());
  if (!user) {
    console.log('❌ ユーザーが見つかりません。');
    return;
  }

  console.log(`\n現在のクレジット: ${user.remaining_credit.toLocaleString()} tokens`);
  console.log(`使用済みクレジット: ${user.used_credit.toLocaleString()} tokens`);

  const amount = await question('\n新しいクレジット額: ');
  const amountNum = parseInt(amount);

  if (isNaN(amountNum) || amountNum < 0) {
    console.log('❌ 0以上の整数を入力してください。');
    return;
  }

  const confirm = await question(`\nクレジットを ${amountNum.toLocaleString()} tokens にリセットしますか？ (y/N): `);
  if (confirm.toLowerCase() !== 'y') {
    console.log('キャンセルしました。');
    return;
  }

  try {
    // 一時的にAdminユーザーを作成して操作
    const adminId = '__temp_admin__';
    await auth.createUser({
      userId: adminId,
      authority: auth.Authority.ADMIN,
      remainingCredit: 0
    }).catch(() => {});

    const updatedUser = await auth.resetCredit(adminId, userId.trim(), amountNum);

    console.log('\n✓ クレジットをリセットしました！');
    console.log('-'.repeat(60));
    console.log('User ID:              ', updatedUser.user_id);
    console.log('新しいクレジット:      ', updatedUser.remaining_credit.toLocaleString());
    console.log('使用済みクレジット:    ', updatedUser.used_credit.toLocaleString());
    console.log('-'.repeat(60));
  } catch (error) {
    console.log(`\n❌ エラー: ${error.message}`);
  }
}

// ユーザー削除
async function deleteUser() {
  console.log('\n' + '-'.repeat(60));
  console.log('ユーザー削除');
  console.log('-'.repeat(60));

  const userId = await question('\nUser ID: ');
  if (!userId.trim()) {
    console.log('❌ User IDは必須です。');
    return;
  }

  const user = await auth.getUser(userId.trim());
  if (!user) {
    console.log('❌ ユーザーが見つかりません。');
    return;
  }

  console.log('\n削除対象:');
  console.log('-'.repeat(60));
  console.log('User ID:   ', user.user_id);
  console.log('Authority: ', user.authority);
  console.log('-'.repeat(60));

  if (user.authority === auth.Authority.ADMIN) {
    console.log('\n⚠️  警告: このユーザーはAdminです！');
  }

  const confirm = await question('\n本当に削除しますか？ (yes/NO): ');
  if (confirm.toLowerCase() !== 'yes') {
    console.log('キャンセルしました。');
    return;
  }

  try {
    // 一時的にAdminユーザーを作成して操作
    const adminId = '__temp_admin__';
    await auth.createUser({
      userId: adminId,
      authority: auth.Authority.ADMIN,
      remainingCredit: 0
    }).catch(() => {});

    if (user.authority === auth.Authority.ADMIN) {
      const allUsers = await auth.getAllUsers();
      const adminCount = allUsers.filter(
        (u) => u.authority === auth.Authority.ADMIN
      ).length;

      if (adminCount <= 1) {
        console.log('\n❌ このユーザーは唯一のAdminのため削除できません。');
        return;
      }

      console.log('\nAdminアカウントを一旦User権限に降格してから削除します...');
      await auth.updateUser(user.user_id, { authority: auth.Authority.USER });
      user.authority = auth.Authority.USER;
      console.log('✓ 権限をUserに変更しました。');
    }

    await auth.deleteAccount(adminId, userId.trim());

    console.log('\n✓ ユーザーを削除しました。');
  } catch (error) {
    console.log(`\n❌ エラー: ${error.message}`);
  }
}

// アカウント停止
async function stopAccount() {
  console.log('\n' + '-'.repeat(60));
  console.log('アカウント停止');
  console.log('-'.repeat(60));

  const userId = await question('\nUser ID: ');
  if (!userId.trim()) {
    console.log('❌ User IDは必須です。');
    return;
  }

  const user = await auth.getUser(userId.trim());
  if (!user) {
    console.log('❌ ユーザーが見つかりません。');
    return;
  }

  console.log(`\n現在のステータス: ${user.authority}`);

  const confirm = await question('\nアカウントを停止しますか？ (y/N): ');
  if (confirm.toLowerCase() !== 'y') {
    console.log('キャンセルしました。');
    return;
  }

  try {
    const adminId = '__temp_admin__';
    await auth.createUser({
      userId: adminId,
      authority: auth.Authority.ADMIN,
      remainingCredit: 0
    }).catch(() => {});

    const updatedUser = await auth.stopAccount(adminId, userId.trim());

    console.log('\n✓ アカウントを停止しました。');
    console.log(`新しいステータス: ${updatedUser.authority}`);
  } catch (error) {
    console.log(`\n❌ エラー: ${error.message}`);
  }
}

// アカウントBAN
async function banAccount() {
  console.log('\n' + '-'.repeat(60));
  console.log('アカウントBAN');
  console.log('-'.repeat(60));

  const userId = await question('\nUser ID: ');
  if (!userId.trim()) {
    console.log('❌ User IDは必須です。');
    return;
  }

  const user = await auth.getUser(userId.trim());
  if (!user) {
    console.log('❌ ユーザーが見つかりません。');
    return;
  }

  console.log(`\n現在のステータス: ${user.authority}`);
  console.log('⚠️  BANされたユーザーはログインできなくなります。');

  const confirm = await question('\nアカウントをBANしますか？ (yes/NO): ');
  if (confirm.toLowerCase() !== 'yes') {
    console.log('キャンセルしました。');
    return;
  }

  try {
    const adminId = '__temp_admin__';
    await auth.createUser({
      userId: adminId,
      authority: auth.Authority.ADMIN,
      remainingCredit: 0
    }).catch(() => {});

    const updatedUser = await auth.banAccount(adminId, userId.trim());

    console.log('\n✓ アカウントをBANしました。');
    console.log(`新しいステータス: ${updatedUser.authority}`);
  } catch (error) {
    console.log(`\n❌ エラー: ${error.message}`);
  }
}

// アカウント復活
async function reactivateAccount() {
  console.log('\n' + '-'.repeat(60));
  console.log('アカウント復活');
  console.log('-'.repeat(60));

  const userId = await question('\nUser ID: ');
  if (!userId.trim()) {
    console.log('❌ User IDは必須です。');
    return;
  }

  const user = await auth.getUser(userId.trim());
  if (!user) {
    console.log('❌ ユーザーが見つかりません。');
    return;
  }

  console.log(`\n現在のステータス: ${user.authority}`);

  console.log('\n復活後の権限を選択:');
  console.log('  1. Admin');
  console.log('  2. Vip');
  console.log('  3. User');
  const choice = await question('選択 (1-3, デフォルト: 3): ');

  const authorityMap = {
    '1': auth.Authority.ADMIN,
    '2': auth.Authority.VIP,
    '3': auth.Authority.USER
  };
  const authority = authorityMap[choice] || auth.Authority.USER;

  try {
    const adminId = '__temp_admin__';
    await auth.createUser({
      userId: adminId,
      authority: auth.Authority.ADMIN,
      remainingCredit: 0
    }).catch(() => {});

    const updatedUser = await auth.reactivateAccount(adminId, userId.trim(), authority);

    console.log('\n✓ アカウントを復活しました。');
    console.log(`新しいステータス: ${updatedUser.authority}`);
  } catch (error) {
    console.log(`\n❌ エラー: ${error.message}`);
  }
}

// CSV出力
async function exportToCSV() {
  console.log('\n' + '-'.repeat(60));
  console.log('CSV出力');
  console.log('-'.repeat(60));

  const filename = await question('\n出力ファイル名 (デフォルト: users_export.csv): ');
  const filepath = path.join(__dirname, '../data', filename.trim() || 'users_export.csv');

  try {
    const users = await auth.getAllUsers();

    if (users.length === 0) {
      console.log('❌ エクスポートするユーザーがいません。');
      return;
    }

    // CSVヘッダー
    const headers = [
      'user_id',
      'password_hash',
      'salt',
      'group_id',
      'thread_id',
      'authority',
      'used_credit',
      'remaining_credit',
      'created_at',
      'updated_at',
      'last_login',
      'is_active'
    ];

    let csv = headers.join(',') + '\n';

    // データ行
    for (const user of users) {
      const row = [
        escapeCsvField(user.user_id),
        escapeCsvField(user.password_hash || ''),
        escapeCsvField(user.salt || ''),
        escapeCsvField(user.group_id || ''),
        escapeCsvField(user.thread_id || ''),
        escapeCsvField(user.authority),
        user.used_credit || 0,
        user.remaining_credit || 0,
        escapeCsvField(user.created_at || ''),
        escapeCsvField(user.updated_at || ''),
        escapeCsvField(user.last_login || ''),
        user.is_active ? 1 : 0
      ];
      csv += row.join(',') + '\n';
    }

    await fs.writeFile(filepath, csv, 'utf-8');

    console.log(`\n✓ ${users.length} ユーザーをエクスポートしました！`);
    console.log(`ファイル: ${filepath}`);
    console.log('\n⚠️  注意: このファイルにはパスワードハッシュとソルトが含まれています。');
    console.log('安全に保管してください。');
  } catch (error) {
    console.log(`\n❌ エラー: ${error.message}`);
  }
}

// CSVインポート
async function importFromCSV() {
  console.log('\n' + '-'.repeat(60));
  console.log('CSVインポート');
  console.log('-'.repeat(60));

  const filename = await question('\nインポートファイル名: ');
  if (!filename.trim()) {
    console.log('❌ ファイル名は必須です。');
    return;
  }

  const filepath = path.join(__dirname, 'data', filename.trim());

  try {
    const content = await fs.readFile(filepath, 'utf-8');
    const lines = content.trim().split('\n');

    if (lines.length < 2) {
      console.log('❌ CSVファイルが空です。');
      return;
    }

    const headers = lines[0].split(',');
    const dataLines = lines.slice(1);

    console.log(`\n${dataLines.length} 件のユーザーが見つかりました。`);
    console.log('\n⚠️  警告: 既存のユーザー情報を上書きします！');
    const confirm = await question('インポートを実行しますか？ (yes/NO): ');

    if (confirm.toLowerCase() !== 'yes') {
      console.log('キャンセルしました。');
      return;
    }

    let imported = 0;
    let errors = 0;

    // データベース操作用のAdminアカウント
    const adminId = '__temp_admin__';
    await auth.createUser({
      userId: adminId,
      authority: auth.Authority.ADMIN,
      remainingCredit: 0
    }).catch(() => {});

    for (const line of dataLines) {
      try {
        const values = parseCsvLine(line);
        const userData = {};

        headers.forEach((header, index) => {
          userData[header.trim()] = values[index];
        });

        // 既存ユーザーの確認
        const existingUser = await auth.getUser(userData.user_id);

        if (existingUser) {
          // 既存ユーザーの更新（SQLiteを直接操作）
          await updateUserDirectly(userData);
        } else {
          // 新規ユーザー作成（SQLiteを直接操作）
          await insertUserDirectly(userData);
        }

        imported++;
      } catch (error) {
        console.log(`エラー (User: ${line.split(',')[0]}): ${error.message}`);
        errors++;
      }
    }

    console.log(`\n✓ インポート完了！`);
    console.log(`成功: ${imported} 件`);
    if (errors > 0) {
      console.log(`失敗: ${errors} 件`);
    }
  } catch (error) {
    console.log(`\n❌ エラー: ${error.message}`);
  }
}

// 初期セットアップ（最初の管理者だけを作成）
async function runInitialSetup() {
  console.log('\n' + '='.repeat(60));
  console.log('Initial Setup – create the very first admin user');
  console.log('='.repeat(60));

  const users = await auth.getAllUsers();
  if (users.length > 0) {
    console.log('\n❌ 既にユーザーが存在するため、このメニューは初期状態でのみ実行できます。');
    console.log('ユーザーを全削除したい場合は data/users.db を手動で削除してから実行してください。');
    return;
  }

  const userIdInput = await question('\nAdmin User ID (default: admin): ');
  const adminUserId = userIdInput.trim() || 'admin';

  const passwordInput = await question('Admin Password (default: admin123): ');
  const adminPassword = passwordInput.trim() || 'admin123';

  const creditInput = await question('Initial credit (default: 10000): ');
  const remainingCredit = parseInt(creditInput.trim(), 10) || 10000;

  try {
    const admin = await auth.createUser({
      userId: adminUserId,
      password: adminPassword,
      authority: auth.Authority.ADMIN,
      remainingCredit
    });

    console.log('\n✓ Admin user created successfully!');
    console.log('-'.repeat(60));
    console.log(`User ID:          ${admin.userId}`);
    console.log(`Password:         ${adminPassword}`);
    console.log(`Authority:        ${admin.authority}`);
    console.log(`Remaining Credit: ${admin.remainingCredit.toLocaleString()}`);
    console.log('-'.repeat(60));
    console.log('\nAuthorization header example:');
    console.log(`Bearer ${adminUserId}:${adminPassword}`);
    console.log('\n⚠️  IMPORTANT: Change the password after first login.\n');
  } catch (error) {
    if (error.message.includes('already exists')) {
      console.log('\n❌ Admin user already exists. If this is unexpected, delete data/users.db and rerun the setup.');
    } else {
      console.log(`\n❌ エラー: ${error.message}`);
    }
  }
}

// BOTアカウント（管理者・パスワードなし）発行
async function createBotAccount() {
  console.log('\n' + '-'.repeat(60));
  console.log('BOTアカウント発行（Admin / passwordless）');
  console.log('-'.repeat(60));

  const botUserId = process.env.BOT_USER_ID;
  const botDefaultCredit = process.env.BOT_DEFAULT_CREDIT;
  if (!botUserId) {
    console.log('❌ BOT_USER_ID が .env に設定されていません。');
    return;
  }

  const existing = await auth.getUser(botUserId);
  if (existing) {
    console.log(`ℹ️ BOTユーザー ${botUserId} は既に存在します。`);
    console.log(`   現在の権限: ${existing.authority}`);
    return;
  }

  try {
    const botUser = await auth.createUser({
      userId: botUserId,
      authority: auth.Authority.ADMIN,
      remainingCredit: botDefaultCredit ? parseInt(botDefaultCredit) : 10000000
    });

    console.log('\n✓ BOTアカウントを作成しました！');
    console.log('-'.repeat(60));
    console.log('User ID:          ', botUser.userId);
    console.log('Authority:        ', botUser.authority);
    console.log('Password:         ', 'なし（内部利用専用）');
    console.log('Remaining Credit: ', botUser.remainingCredit.toLocaleString());
    console.log('-'.repeat(60));
    console.log('\nBOTクライアントは以下IDを利用してください:');
    console.log(`BOT_USER_ID = ${botUserId}`);
    console.log('このアカウントはBearerトークンでのパスワード入力を必要としません。');
  } catch (error) {
    console.log(`\n❌ エラー: ${error.message}`);
  }
}

// CSV用のフィールドエスケープ
function escapeCsvField(field) {
  if (field === null || field === undefined) return '';
  const str = String(field);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

// CSV行のパース
function parseCsvLine(line) {
  const values = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    const nextChar = line[i + 1];

    if (char === '"') {
      if (inQuotes && nextChar === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      values.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  values.push(current);

  return values;
}

// SQLiteに直接ユーザーを挿入
async function insertUserDirectly(userData) {
  const sqlite3 = await import('sqlite3');
  const { open } = await import('sqlite');

  const db = await open({
    filename: path.join(__dirname, 'data', 'users.db'),
    driver: sqlite3.default.Database
  });

  await db.run(`
    INSERT INTO users (
      user_id, password_hash, salt, group_id, thread_id,
      authority, used_credit, remaining_credit, created_at,
      updated_at, last_login, is_active
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    userData.user_id,
    userData.password_hash || null,
    userData.salt || null,
    userData.group_id || null,
    userData.thread_id || null,
    userData.authority || 'User',
    parseInt(userData.used_credit) || 0,
    parseInt(userData.remaining_credit) || 0,
    userData.created_at || new Date().toISOString(),
    userData.updated_at || new Date().toISOString(),
    userData.last_login || null,
    parseInt(userData.is_active) || 1
  ]);

  await db.close();
}

// SQLiteで直接ユーザーを更新
async function updateUserDirectly(userData) {
  const sqlite3 = await import('sqlite3');
  const { open } = await import('sqlite');

  const db = await open({
    filename: path.join(__dirname, 'data', 'users.db'),
    driver: sqlite3.default.Database
  });

  await db.run(`
    UPDATE users SET
      password_hash = ?,
      salt = ?,
      group_id = ?,
      thread_id = ?,
      authority = ?,
      used_credit = ?,
      remaining_credit = ?,
      created_at = ?,
      updated_at = ?,
      last_login = ?,
      is_active = ?
    WHERE user_id = ?
  `, [
    userData.password_hash || null,
    userData.salt || null,
    userData.group_id || null,
    userData.thread_id || null,
    userData.authority || 'User',
    parseInt(userData.used_credit) || 0,
    parseInt(userData.remaining_credit) || 0,
    userData.created_at || new Date().toISOString(),
    userData.updated_at || new Date().toISOString(),
    userData.last_login || null,
    parseInt(userData.is_active) || 1,
    userData.user_id
  ]);

  await db.close();
}

// メインループ
async function main() {
  try {
    await auth.initDatabase();

    while (true) {
      displayMenu();
      const choice = await question('\n選択してください: ');

      switch (choice) {
        case '1':
          await listUsers();
          break;
        case '2':
          await createUser();
          break;
        case '3':
          await updateUser();
          break;
        case '4':
          await changePassword();
          break;
        case '5':
          await addCredit();
          break;
        case '6':
          await resetCredit();
          break;
        case '7':
          await deleteUser();
          break;
        case '8':
          await stopAccount();
          break;
        case '9':
          await banAccount();
          break;
        case '10':
          await reactivateAccount();
          break;
        case '11':
          await exportToCSV();
          break;
        case '12':
          await importFromCSV();
          break;
        case '13':
          await runInitialSetup();
          break;
        case '14':
          await createBotAccount();
          break;
        case '0':
          console.log('\n終了します。');
          rl.close();
          await auth.closeDatabase();
          process.exit(0);
        default:
          console.log('\n❌ 無効な選択です。');
      }

      await question('\nEnterキーで続行...');
    }
  } catch (error) {
    console.error('エラー:', error);
    rl.close();
    await auth.closeDatabase();
    process.exit(1);
  }
}

main();