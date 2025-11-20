#!/usr/bin/env node
// guild-manager-cli.js
// =============================================================================
// Guild管理CLI（対話形式）
// =============================================================================
// Discordサーバー（Guild）の登録・管理を行う対話形式のコマンドラインツール
//
// 使用方法:
//   node guild-manager-cli.js
//
// 機能:
//   - 承認待ちリクエストの表示・承認・拒否
//   - Guild一覧表示
//   - Guild情報表示
//   - Guild有効化・無効化
//   - 認証トークン生成
// =============================================================================

import 'dotenv/config';
import readline from 'readline';
import {
  getPendingGuildRequests,
  approveGuildRequest,
  rejectGuildRequest,
  registerGuild,
  disableGuild,
  enableGuild,
  getAllGuilds,
  displayGuildAuthInfo,
  generateGuildAuthToken,
  cleanupOldRequests,
  loadGuildConfig
} from '../discord-bot/guild-manager.js';

// =============================================================================
// readline設定
// =============================================================================

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function question(prompt) {
  return new Promise((resolve) => {
    rl.question(prompt, resolve);
  });
}

// =============================================================================
// メニュー表示
// =============================================================================

function displayMenu() {
  console.log('\n' + '='.repeat(70));
  console.log('Guild Manager - Discord Bot Guild Management Tool');
  console.log('='.repeat(70));
  console.log('\n【メニュー】');
  console.log('  1. 承認待ちリクエスト一覧');
  console.log('  2. リクエストを承認');
  console.log('  3. リクエストを拒否');
  console.log('  4. 登録済みGuild一覧');
  console.log('  5. Guild情報表示');
  console.log('  6. Guild有効化');
  console.log('  7. Guild無効化');
  console.log('  8. 認証トークン生成');
  console.log('  9. 手動Guild登録');
  console.log(' 10. 古いリクエストをクリーンアップ');
  console.log('  0. 終了');
  console.log('='.repeat(70));
}

// =============================================================================
// テーブル表示ヘルパー
// =============================================================================

function printTable(headers, rows) {
  if (rows.length === 0) {
    console.log('\n(No data)\n');
    return;
  }

  // 列幅の計算
  const colWidths = headers.map((header, i) => {
    const maxContentWidth = Math.max(...rows.map(row => String(row[i] || '').length));
    return Math.max(header.length, maxContentWidth);
  });

  // ヘッダーの出力
  console.log('');
  console.log(headers.map((h, i) => h.padEnd(colWidths[i])).join(' | '));
  console.log(colWidths.map(w => '-'.repeat(w)).join('-+-'));

  // 行の出力
  rows.forEach(row => {
    console.log(row.map((cell, i) => String(cell || '').padEnd(colWidths[i])).join(' | '));
  });
  console.log('');
}

// =============================================================================
// コマンドハンドラ
// =============================================================================

async function handlePendingRequests() {
  console.log('\n' + '-'.repeat(70));
  console.log('承認待ちGuildリクエスト');
  console.log('-'.repeat(70));
  
  const requests = getPendingGuildRequests();
  
  if (requests.length === 0) {
    console.log('\n承認待ちのリクエストはありません。\n');
    return;
  }
  
  console.log(`\n承認待ちリクエスト数: ${requests.length}\n`);
  
  const headers = ['Guild ID', 'Name', 'Members', 'Requested At'];
  const rows = requests.map(r => [
    r.guildId,
    r.name,
    r.memberCount || 'N/A',
    new Date(r.requestedAt).toLocaleString('ja-JP')
  ]);
  
  printTable(headers, rows);
}

async function handleApproveRequest() {
  console.log('\n' + '-'.repeat(70));
  console.log('リクエストを承認');
  console.log('-'.repeat(70));
  
  const requests = getPendingGuildRequests();
  
  if (requests.length === 0) {
    console.log('\n承認待ちのリクエストはありません。\n');
    return;
  }
  
  // リクエスト一覧を表示
  console.log('\n承認待ちリクエスト:');
  requests.forEach((r, i) => {
    console.log(`  ${i + 1}. ${r.name} (${r.guildId})`);
  });
  
  const choice = await question('\n承認するリクエストの番号を入力 (0: キャンセル): ');
  const index = parseInt(choice) - 1;
  
  if (index < 0 || index >= requests.length) {
    console.log('\n操作をキャンセルしました。');
    return;
  }
  
  const request = requests[index];
  
  console.log(`\nGuild: ${request.name}`);
  console.log(`ID: ${request.guildId}`);
  console.log(`Member Count: ${request.memberCount || 'N/A'}`);
  console.log(`Requested: ${new Date(request.requestedAt).toLocaleString('ja-JP')}`);
  
  const confirm = await question('\nこのリクエストを承認しますか？ (y/n): ');
  
  if (confirm.toLowerCase() !== 'y') {
    console.log('\n操作をキャンセルしました。');
    return;
  }
  
  try {
    approveGuildRequest(request.guildId);
    console.log('\n✅ リクエストを承認し、Guildを登録しました！');
    console.log('\n認証情報を表示するには、メニューから「5. Guild情報表示」を選択してください。');
  } catch (error) {
    console.log(`\n❌ エラー: ${error.message}`);
  }
}

async function handleRejectRequest() {
  console.log('\n' + '-'.repeat(70));
  console.log('リクエストを拒否');
  console.log('-'.repeat(70));
  
  const requests = getPendingGuildRequests();
  
  if (requests.length === 0) {
    console.log('\n承認待ちのリクエストはありません。\n');
    return;
  }
  
  // リクエスト一覧を表示
  console.log('\n承認待ちリクエスト:');
  requests.forEach((r, i) => {
    console.log(`  ${i + 1}. ${r.name} (${r.guildId})`);
  });
  
  const choice = await question('\n拒否するリクエストの番号を入力 (0: キャンセル): ');
  const index = parseInt(choice) - 1;
  
  if (index < 0 || index >= requests.length) {
    console.log('\n操作をキャンセルしました。');
    return;
  }
  
  const request = requests[index];
  
  console.log(`\nGuild: ${request.name}`);
  console.log(`ID: ${request.guildId}`);
  
  const reason = await question('\n拒否理由 (オプション): ');
  
  const confirm = await question('\nこのリクエストを拒否しますか？ (y/n): ');
  
  if (confirm.toLowerCase() !== 'y') {
    console.log('\n操作をキャンセルしました。');
    return;
  }
  
  try {
    rejectGuildRequest(request.guildId, reason.trim());
    console.log('\n✅ リクエストを拒否しました。');
  } catch (error) {
    console.log(`\n❌ エラー: ${error.message}`);
  }
}

async function handleListGuilds() {
  console.log('\n' + '-'.repeat(70));
  console.log('登録済みGuild一覧');
  console.log('-'.repeat(70));
  
  const guilds = getAllGuilds();
  
  if (guilds.length === 0) {
    console.log('\n登録済みのGuildはありません。\n');
    return;
  }
  
  console.log(`\n登録Guild数: ${guilds.length}\n`);
  
  const headers = ['Guild ID', 'Name', 'Status', 'Registered At'];
  const rows = guilds.map(g => [
    g.guildId,
    g.name,
    g.enabled ? '✅ Enabled' : '❌ Disabled',
    new Date(g.registeredAt).toLocaleString('ja-JP')
  ]);
  
  printTable(headers, rows);
}

async function handleShowGuild() {
  console.log('\n' + '-'.repeat(70));
  console.log('Guild情報表示');
  console.log('-'.repeat(70));
  
  const guilds = getAllGuilds();
  
  if (guilds.length === 0) {
    console.log('\n登録済みのGuildはありません。\n');
    return;
  }
  
  // Guild一覧を表示
  console.log('\n登録済みGuild:');
  guilds.forEach((g, i) => {
    const status = g.enabled ? '✅' : '❌';
    console.log(`  ${i + 1}. ${status} ${g.name} (${g.guildId})`);
  });
  
  const choice = await question('\n情報を表示するGuildの番号を入力 (0: キャンセル): ');
  const index = parseInt(choice) - 1;
  
  if (index < 0 || index >= guilds.length) {
    console.log('\n操作をキャンセルしました。');
    return;
  }
  
  const guild = guilds[index];
  displayGuildAuthInfo(guild.guildId);
}

async function handleEnableGuild() {
  console.log('\n' + '-'.repeat(70));
  console.log('Guild有効化');
  console.log('-'.repeat(70));
  
  const guilds = getAllGuilds().filter(g => !g.enabled);
  
  if (guilds.length === 0) {
    console.log('\n無効化されているGuildはありません。\n');
    return;
  }
  
  // 無効化されているGuild一覧を表示
  console.log('\n無効化されているGuild:');
  guilds.forEach((g, i) => {
    console.log(`  ${i + 1}. ${g.name} (${g.guildId})`);
  });
  
  const choice = await question('\n有効化するGuildの番号を入力 (0: キャンセル): ');
  const index = parseInt(choice) - 1;
  
  if (index < 0 || index >= guilds.length) {
    console.log('\n操作をキャンセルしました。');
    return;
  }
  
  const guild = guilds[index];
  
  try {
    enableGuild(guild.guildId);
    console.log('\n✅ Guildを有効化しました！');
  } catch (error) {
    console.log(`\n❌ エラー: ${error.message}`);
  }
}

async function handleDisableGuild() {
  console.log('\n' + '-'.repeat(70));
  console.log('Guild無効化');
  console.log('-'.repeat(70));
  
  const guilds = getAllGuilds().filter(g => g.enabled);
  
  if (guilds.length === 0) {
    console.log('\n有効なGuildはありません。\n');
    return;
  }
  
  // 有効なGuild一覧を表示
  console.log('\n有効なGuild:');
  guilds.forEach((g, i) => {
    console.log(`  ${i + 1}. ${g.name} (${g.guildId})`);
  });
  
  const choice = await question('\n無効化するGuildの番号を入力 (0: キャンセル): ');
  const index = parseInt(choice) - 1;
  
  if (index < 0 || index >= guilds.length) {
    console.log('\n操作をキャンセルしました。');
    return;
  }
  
  const guild = guilds[index];
  
  const confirm = await question(`\n"${guild.name}" を無効化しますか？ (y/n): `);
  
  if (confirm.toLowerCase() !== 'y') {
    console.log('\n操作をキャンセルしました。');
    return;
  }
  
  try {
    disableGuild(guild.guildId);
    console.log('\n✅ Guildを無効化しました！');
  } catch (error) {
    console.log(`\n❌ エラー: ${error.message}`);
  }
}

async function handleGenerateToken() {
  console.log('\n' + '-'.repeat(70));
  console.log('認証トークン生成');
  console.log('-'.repeat(70));
  
  const guilds = getAllGuilds();
  
  if (guilds.length === 0) {
    console.log('\n登録済みのGuildはありません。\n');
    return;
  }
  
  // Guild一覧を表示
  console.log('\n登録済みGuild:');
  guilds.forEach((g, i) => {
    const status = g.enabled ? '✅' : '❌';
    console.log(`  ${i + 1}. ${status} ${g.name} (${g.guildId})`);
  });
  
  const choice = await question('\nトークンを生成するGuildの番号を入力 (0: キャンセル): ');
  const index = parseInt(choice) - 1;
  
  if (index < 0 || index >= guilds.length) {
    console.log('\n操作をキャンセルしました。');
    return;
  }
  
  const guild = guilds[index];
  const token = generateGuildAuthToken(guild.guildId);
  const botUserId = process.env.BOT_USER_ID || 'discord-bot';
  
  console.log('\n' + '='.repeat(70));
  console.log('認証トークン');
  console.log('='.repeat(70));
  console.log(`Guild: ${guild.name}`);
  console.log(`Guild ID: ${guild.guildId}`);
  console.log(`Status: ${guild.enabled ? '✅ Enabled' : '❌ Disabled'}`);
  console.log('='.repeat(70));
  console.log('\nAPI認証用 (userId:password 形式):');
  console.log(`User ID: ${botUserId}`);
  console.log(`Password: ${token}`);
  console.log('\n結合形式:');
  console.log(`${botUserId}:${token}`);
  console.log('='.repeat(70));
  console.log('\n⚠️  このトークンは安全に保管してください！\n');
}

async function handleManualRegister() {
  console.log('\n' + '-'.repeat(70));
  console.log('手動Guild登録');
  console.log('-'.repeat(70));
  console.log('\nNote: 通常はBotがサーバーに追加された際に自動でリクエストが作成されます。');
  console.log('      このオプションは手動で登録する必要がある場合のみ使用してください。\n');
  
  const guildId = await question('Guild ID: ');
  if (!guildId.trim()) {
    console.log('\n❌ Guild IDは必須です。');
    return;
  }
  
  const guildName = await question('Guild Name: ');
  if (!guildName.trim()) {
    console.log('\n❌ Guild Nameは必須です。');
    return;
  }
  
  const confirm = await question(`\n"${guildName.trim()}" (${guildId.trim()}) を登録しますか？ (y/n): `);
  
  if (confirm.toLowerCase() !== 'y') {
    console.log('\n操作をキャンセルしました。');
    return;
  }
  
  try {
    registerGuild(guildId.trim(), guildName.trim());
    console.log('\n✅ Guildを登録しました！');
    console.log('\n認証情報を表示するには、メニューから「5. Guild情報表示」を選択してください。');
  } catch (error) {
    console.log(`\n❌ エラー: ${error.message}`);
  }
}

async function handleCleanup() {
  console.log('\n' + '-'.repeat(70));
  console.log('古いリクエストのクリーンアップ');
  console.log('-'.repeat(70));
  
  const daysInput = await question('\n何日より古いリクエストを削除しますか？ (デフォルト: 30): ');
  const days = parseInt(daysInput) || 30;
  
  const confirm = await question(`\n${days}日より古い処理済みリクエストを削除しますか？ (y/n): `);
  
  if (confirm.toLowerCase() !== 'y') {
    console.log('\n操作をキャンセルしました。');
    return;
  }
  
  try {
    cleanupOldRequests(days);
  } catch (error) {
    console.log(`\n❌ エラー: ${error.message}`);
  }
}

// =============================================================================
// メインループ
// =============================================================================

async function main() {
  // 環境変数チェック
  if (!process.env.BOT_MASTER_SECRET) {
    console.error('\n❌ Error: BOT_MASTER_SECRET is not set\n');
    console.log('Please set BOT_MASTER_SECRET in your .env file');
    console.log('Example: BOT_MASTER_SECRET=your_very_long_and_secure_secret_here\n');
    process.exit(1);
  }
  
  console.log('\n✅ Guild Manager started successfully!');
  
  try {
    while (true) {
      displayMenu();
      const choice = await question('\n選択してください: ');
      
      switch (choice) {
        case '1':
          await handlePendingRequests();
          break;
        
        case '2':
          await handleApproveRequest();
          break;
        
        case '3':
          await handleRejectRequest();
          break;
        
        case '4':
          await handleListGuilds();
          break;
        
        case '5':
          await handleShowGuild();
          break;
        
        case '6':
          await handleEnableGuild();
          break;
        
        case '7':
          await handleDisableGuild();
          break;
        
        case '8':
          await handleGenerateToken();
          break;
        
        case '9':
          await handleManualRegister();
          break;
        
        case '10':
          await handleCleanup();
          break;
        
        case '0':
          console.log('\n終了します。');
          rl.close();
          process.exit(0);
        
        default:
          console.log('\n❌ 無効な選択です。');
      }
      
      await question('\nEnterキーで続行...');
    }
  } catch (error) {
    console.error('\n❌ Error:', error.message);
    rl.close();
    process.exit(1);
  }
}

// エラーハンドリング
process.on('unhandledRejection', (error) => {
  console.error('\n❌ Error:', error.message);
  process.exit(1);
});

// 実行
main();
