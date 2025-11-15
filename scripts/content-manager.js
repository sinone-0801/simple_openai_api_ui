// content-manager.js
// 対話形式のThread/Artifact管理CLIツール

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

// データパス
const DATA_DIR = path.join(__dirname, '../data');
const ARTIFACTS_DIR = path.join(__dirname, '../artifacts');
const THREADS_FILE = path.join(DATA_DIR, 'threads.json');

// メニュー表示
function displayMenu() {
  console.log('\n' + '='.repeat(60));
  console.log('Content Management CLI');
  console.log('='.repeat(60));
  console.log('\n【メニュー】');
  console.log('  1. Thread一覧表示');
  console.log('  2. Thread削除');
  console.log('  3. Thread一括削除（期間指定）');
  console.log('  4. Artifact一覧表示');
  console.log('  5. Artifact削除');
  console.log('  6. Thread配下のArtifact一括削除');
  console.log('  7. 孤立Artifact検出・削除');
  console.log('  8. CSV出力（Thread一覧）');
  console.log('  9. CSV出力（Artifact一覧）');
  console.log(' 10. ストレージ使用量確認');
  console.log('  0. 終了');
  console.log('='.repeat(60));
}

// Threads読み込み（サマリー）
async function loadThreads() {
  try {
    const content = await fs.readFile(THREADS_FILE, 'utf-8');
    const parsed = JSON.parse(content);
    return parsed.threads || [];
  } catch (error) {
    if (error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

// Threads保存（サマリー）
async function saveThreads(threads) {
  await fs.writeFile(THREADS_FILE, JSON.stringify({ threads }, null, 2), 'utf-8');
}

// 個別Thread読み込み
async function loadThread(threadId) {
  const threadPath = path.join(DATA_DIR, `thread_${threadId}.json`);
  try {
    const content = await fs.readFile(threadPath, 'utf-8');
    return JSON.parse(content);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

// 個別Thread削除
async function deleteThreadFile(threadId) {
  const threadPath = path.join(DATA_DIR, `thread_${threadId}.json`);
  try {
    await fs.unlink(threadPath);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }
}

// Artifact一覧取得
async function getAllArtifacts() {
  const artifacts = [];
  
  try {
    const entries = await fs.readdir(ARTIFACTS_DIR);
    
    for (const entry of entries) {
      const artifactDir = path.join(ARTIFACTS_DIR, entry);
      const stat = await fs.stat(artifactDir);
      
      if (!stat.isDirectory()) continue;
      
      const metadataPath = path.join(artifactDir, 'metadata.json');
      
      try {
        const content = await fs.readFile(metadataPath, 'utf-8');
        const metadata = JSON.parse(content);
        artifacts.push(metadata);
      } catch (e) {
        continue;
      }
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }
  
  return artifacts;
}

// ファイルサイズを取得
async function getDirectorySize(dirPath) {
  let size = 0;
  
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      
      if (entry.isDirectory()) {
        size += await getDirectorySize(fullPath);
      } else {
        const stat = await fs.stat(fullPath);
        size += stat.size;
      }
    }
  } catch (error) {
    // ディレクトリが存在しない場合は0を返す
  }
  
  return size;
}

// バイトをフォーマット
function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return (bytes / Math.pow(k, i)).toFixed(2) + ' ' + sizes[i];
}

// Thread一覧表示
async function listThreads() {
  console.log('\n' + '-'.repeat(60));
  console.log('Thread一覧');
  console.log('-'.repeat(60));
  
  const threads = await loadThreads();
  
  if (threads.length === 0) {
    console.log('Threadが登録されていません。');
    return;
  }

  console.log(`\n登録Thread数: ${threads.length}\n`);
  
  // テーブル形式で表示
  console.log('Thread ID'.padEnd(25) + 
              'User ID'.padEnd(20) + 
              'Title'.padEnd(30) + 
              'Created');
  console.log('-'.repeat(95));
  
  for (const thread of threads) {
    const threadId = (thread.id || 'N/A').padEnd(25);
    const userId = (thread.userId || 'N/A').padEnd(20);
    const title = (thread.title || 'Untitled').substring(0, 29).padEnd(30);
    const created = thread.createdAt ? new Date(thread.createdAt).toLocaleDateString('ja-JP') : 'N/A';
    
    console.log(threadId + userId + title + created);
  }
  
  console.log('-'.repeat(95));
}

// Thread削除
async function deleteThread() {
  console.log('\n' + '-'.repeat(60));
  console.log('Thread削除');
  console.log('-'.repeat(60));
  
  const threadId = await question('\nThread ID: ');
  if (!threadId.trim()) {
    console.log('❌ Thread IDは必須です。');
    return;
  }

  const threads = await loadThreads();
  const thread = threads.find(t => t.id === threadId.trim());
  
  if (!thread) {
    console.log('❌ Threadが見つかりません。');
    return;
  }

  // 詳細データを読み込み
  const threadData = await loadThread(threadId.trim());
  const messageCount = threadData?.messages?.length || 0;

  console.log('\nThread情報:');
  console.log('-'.repeat(60));
  console.log('Thread ID:     ', thread.id);
  console.log('User ID:       ', thread.userId || 'N/A');
  console.log('Title:         ', thread.title || 'Untitled');
  console.log('Messages:      ', messageCount);
  console.log('Artifacts:     ', thread.artifactIds?.length || 0);
  console.log('Created:       ', thread.createdAt || 'N/A');
  console.log('-'.repeat(60));

  const confirm = await question('\nこのThreadを削除しますか？ (yes/NO): ');

  if (confirm.toLowerCase() !== 'yes') {
    console.log('キャンセルしました。');
    return;
  }

  try {
    // サマリーから削除
    const updatedThreads = threads.filter(t => t.id !== threadId.trim());
    await saveThreads(updatedThreads);
    
    // 個別ファイルを削除
    await deleteThreadFile(threadId.trim());
    
    console.log('\n✓ Threadを削除しました！');
  } catch (error) {
    console.log(`\n❌ エラー: ${error.message}`);
  }
}

// Thread一括削除（期間指定）
async function bulkDeleteThreads() {
  console.log('\n' + '-'.repeat(60));
  console.log('Thread一括削除（期間指定）');
  console.log('-'.repeat(60));
  
  console.log('\n削除基準:');
  console.log('  1. 作成日が指定日より古いThread');
  console.log('  2. 最終更新日が指定日より古いThread');
  const criterion = await question('選択 (1-2): ');

  const daysStr = await question('\n何日以上前のThreadを削除しますか？: ');
  const days = parseInt(daysStr);
  
  if (isNaN(days) || days <= 0) {
    console.log('❌ 有効な日数を入力してください。');
    return;
  }

  const threads = await loadThreads();
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - days);

  const toDelete = [];
  
  for (const thread of threads) {
    let targetDate;
    
    if (criterion === '1') {
      targetDate = thread.createdAt ? new Date(thread.createdAt) : null;
    } else if (criterion === '2') {
      targetDate = thread.updatedAt ? new Date(thread.updatedAt) : null;
    }
    
    if (targetDate && targetDate < cutoffDate) {
      toDelete.push({ thread, targetDate });
    }
  }

  if (toDelete.length === 0) {
    console.log(`\n削除対象のThreadはありません（${days}日以上前）。`);
    return;
  }

  console.log(`\n削除対象Thread: ${toDelete.length}件`);
  console.log('-'.repeat(60));
  
  for (const { thread, targetDate } of toDelete.slice(0, 5)) {
    console.log(`${thread.id.padEnd(25)} ${targetDate.toLocaleDateString('ja-JP')}`);
  }
  
  if (toDelete.length > 5) {
    console.log(`... 他 ${toDelete.length - 5} 件`);
  }
  
  console.log('-'.repeat(60));

  const confirm = await question(`\n${toDelete.length}件のThreadを削除しますか？ (yes/NO): `);

  if (confirm.toLowerCase() !== 'yes') {
    console.log('キャンセルしました。');
    return;
  }

  try {
    const deleteIds = new Set(toDelete.map(item => item.thread.id));
    const updatedThreads = threads.filter(t => !deleteIds.has(t.id));
    await saveThreads(updatedThreads);
    
    // 個別ファイルも削除
    for (const { thread } of toDelete) {
      await deleteThreadFile(thread.id);
    }
    
    console.log(`\n✓ ${toDelete.length}件のThreadを削除しました！`);
  } catch (error) {
    console.log(`\n❌ エラー: ${error.message}`);
  }
}

// Artifact一覧表示
async function listArtifacts() {
  console.log('\n' + '-'.repeat(60));
  console.log('Artifact一覧');
  console.log('-'.repeat(60));
  
  const artifacts = await getAllArtifacts();
  
  if (artifacts.length === 0) {
    console.log('Artifactが登録されていません。');
    return;
  }

  console.log(`\n登録Artifact数: ${artifacts.length}\n`);
  
  // テーブル形式で表示
  console.log('Artifact ID'.padEnd(25) + 
              'Filename'.padEnd(30) + 
              'Thread ID'.padEnd(20));
  console.log('-'.repeat(75));
  
  for (const artifact of artifacts) {
    console.log(
      artifact.id.padEnd(25) +
      (artifact.filename || 'N/A').substring(0, 29).padEnd(30) +
      (artifact.threadId || 'N/A').padEnd(20)
    );
  }
  
  console.log('-'.repeat(75));
}

// Artifact削除
async function deleteArtifact() {
  console.log('\n' + '-'.repeat(60));
  console.log('Artifact削除');
  console.log('-'.repeat(60));
  
  const artifactId = await question('\nArtifact ID: ');
  if (!artifactId.trim()) {
    console.log('❌ Artifact IDは必須です。');
    return;
  }

  const artifactDir = path.join(ARTIFACTS_DIR, artifactId.trim());
  const metadataPath = path.join(artifactDir, 'metadata.json');

  try {
    const content = await fs.readFile(metadataPath, 'utf-8');
    const metadata = JSON.parse(content);
    
    console.log('\nArtifact情報:');
    console.log('-'.repeat(60));
    console.log('Artifact ID:   ', metadata.id);
    console.log('Filename:      ', metadata.filename);
    console.log('Thread ID:     ', metadata.threadId || 'N/A');
    console.log('Version Count: ', metadata.versions?.length || 0);
    console.log('Created:       ', metadata.createdAt || 'N/A');
    console.log('-'.repeat(60));

    const confirm = await question('\nこのArtifactを削除しますか？ (yes/NO): ');

    if (confirm.toLowerCase() !== 'yes') {
      console.log('キャンセルしました。');
      return;
    }

    // ディレクトリごと削除
    await fs.rm(artifactDir, { recursive: true, force: true });
    
    console.log('\n✓ Artifactを削除しました！');
  } catch (error) {
    if (error.code === 'ENOENT') {
      console.log('❌ Artifactが見つかりません。');
    } else {
      console.log(`\n❌ エラー: ${error.message}`);
    }
  }
}

// Thread配下のArtifact一括削除
async function deleteArtifactsByThread() {
  console.log('\n' + '-'.repeat(60));
  console.log('Thread配下のArtifact一括削除');
  console.log('-'.repeat(60));
  
  const threadId = await question('\nThread ID: ');
  if (!threadId.trim()) {
    console.log('❌ Thread IDは必須です。');
    return;
  }

  const artifacts = await getAllArtifacts();
  const threadArtifacts = artifacts.filter(a => a.threadId === threadId.trim());

  if (threadArtifacts.length === 0) {
    console.log('\n削除対象のArtifactはありません。');
    return;
  }

  console.log(`\n削除対象Artifact: ${threadArtifacts.length}件`);
  console.log('-'.repeat(60));
  
  for (const artifact of threadArtifacts.slice(0, 5)) {
    console.log(`${artifact.id.padEnd(25)} ${artifact.filename}`);
  }
  
  if (threadArtifacts.length > 5) {
    console.log(`... 他 ${threadArtifacts.length - 5} 件`);
  }
  
  console.log('-'.repeat(60));

  const confirm = await question(`\n${threadArtifacts.length}件のArtifactを削除しますか？ (yes/NO): `);

  if (confirm.toLowerCase() !== 'yes') {
    console.log('キャンセルしました。');
    return;
  }

  try {
    let deleted = 0;
    
    for (const artifact of threadArtifacts) {
      const artifactDir = path.join(ARTIFACTS_DIR, artifact.id);
      await fs.rm(artifactDir, { recursive: true, force: true });
      deleted++;
    }
    
    console.log(`\n✓ ${deleted}件のArtifactを削除しました！`);
  } catch (error) {
    console.log(`\n❌ エラー: ${error.message}`);
  }
}

// 孤立Artifact検出・削除
async function detectOrphanedArtifacts() {
  console.log('\n' + '-'.repeat(60));
  console.log('孤立Artifact検出・削除');
  console.log('-'.repeat(60));
  
  const threads = await loadThreads();
  const threadIds = new Set(threads.map(t => t.id));
  
  const artifacts = await getAllArtifacts();
  const orphanedArtifacts = artifacts.filter(a => 
    a.threadId && !threadIds.has(a.threadId)
  );

  if (orphanedArtifacts.length === 0) {
    console.log('\n孤立したArtifactはありません。');
    return;
  }

  console.log(`\n孤立Artifact: ${orphanedArtifacts.length}件`);
  console.log('（存在しないThread IDを参照しているArtifact）');
  console.log('-'.repeat(60));
  
  for (const artifact of orphanedArtifacts.slice(0, 10)) {
    console.log(`${artifact.id.padEnd(25)} Thread: ${artifact.threadId}`);
  }
  
  if (orphanedArtifacts.length > 10) {
    console.log(`... 他 ${orphanedArtifacts.length - 10} 件`);
  }
  
  console.log('-'.repeat(60));

  const confirm = await question(`\n${orphanedArtifacts.length}件の孤立Artifactを削除しますか？ (yes/NO): `);

  if (confirm.toLowerCase() !== 'yes') {
    console.log('キャンセルしました。');
    return;
  }

  try {
    let deleted = 0;
    
    for (const artifact of orphanedArtifacts) {
      const artifactDir = path.join(ARTIFACTS_DIR, artifact.id);
      await fs.rm(artifactDir, { recursive: true, force: true });
      deleted++;
    }
    
    console.log(`\n✓ ${deleted}件の孤立Artifactを削除しました！`);
  } catch (error) {
    console.log(`\n❌ エラー: ${error.message}`);
  }
}

// CSV出力（Thread一覧）
async function exportThreadsToCSV() {
  console.log('\n' + '-'.repeat(60));
  console.log('CSV出力（Thread一覧）');
  console.log('-'.repeat(60));

  const filename = await question('\nエクスポートファイル名 (例: threads_backup.csv): ');
  if (!filename.trim()) {
    console.log('❌ ファイル名は必須です。');
    return;
  }

  const filepath = path.join(__dirname, 'data', filename.trim());

  try {
    const threads = await loadThreads();

    // CSVヘッダー
    let csv = 'thread_id,user_id,title,artifact_count,created_at,updated_at\n';

    // データ行
    for (const thread of threads) {
      const row = [
        escapeCsvField(thread.id),
        escapeCsvField(thread.userId || ''),
        escapeCsvField(thread.title || ''),
        thread.artifactIds?.length || 0,
        escapeCsvField(thread.createdAt || ''),
        escapeCsvField(thread.updatedAt || '')
      ];
      csv += row.join(',') + '\n';
    }

    await fs.writeFile(filepath, csv, 'utf-8');

    console.log(`\n✓ ${threads.length} Threadをエクスポートしました！`);
    console.log(`ファイル: ${filepath}`);
  } catch (error) {
    console.log(`\n❌ エラー: ${error.message}`);
  }
}

// CSV出力（Artifact一覧）
async function exportArtifactsToCSV() {
  console.log('\n' + '-'.repeat(60));
  console.log('CSV出力（Artifact一覧）');
  console.log('-'.repeat(60));

  const filename = await question('\nエクスポートファイル名 (例: artifacts_backup.csv): ');
  if (!filename.trim()) {
    console.log('❌ ファイル名は必須です。');
    return;
  }

  const filepath = path.join(__dirname, 'data', filename.trim());

  try {
    const artifacts = await getAllArtifacts();

    // CSVヘッダー
    let csv = 'artifact_id,filename,thread_id,version_count,created_at,updated_at\n';

    // データ行
    for (const artifact of artifacts) {
      const row = [
        escapeCsvField(artifact.id),
        escapeCsvField(artifact.filename || ''),
        escapeCsvField(artifact.threadId || ''),
        artifact.versions?.length || 0,
        escapeCsvField(artifact.createdAt || ''),
        escapeCsvField(artifact.updatedAt || '')
      ];
      csv += row.join(',') + '\n';
    }

    await fs.writeFile(filepath, csv, 'utf-8');

    console.log(`\n✓ ${artifacts.length} Artifactをエクスポートしました！`);
    console.log(`ファイル: ${filepath}`);
  } catch (error) {
    console.log(`\n❌ エラー: ${error.message}`);
  }
}

// ストレージ使用量確認
async function checkStorageUsage() {
  console.log('\n' + '-'.repeat(60));
  console.log('ストレージ使用量確認');
  console.log('-'.repeat(60));

  try {
    const threads = await loadThreads();
    const artifacts = await getAllArtifacts();
    
    // Threadsファイルのサイズ
    let threadsSize = 0;
    try {
      const stat = await fs.stat(THREADS_FILE);
      threadsSize = stat.size;
    } catch (e) {
      // ファイルが存在しない場合
    }
    
    // 個別Threadファイルの合計サイズ
    let threadFilesSize = 0;
    for (const thread of threads) {
      try {
        const threadPath = path.join(DATA_DIR, `thread_${thread.id}.json`);
        const stat = await fs.stat(threadPath);
        threadFilesSize += stat.size;
      } catch (e) {
        // ファイルが存在しない場合
      }
    }
    
    // Artifactsディレクトリのサイズ
    const artifactsSize = await getDirectorySize(ARTIFACTS_DIR);
    
    // Dataディレクトリ全体のサイズ
    const dataSize = await getDirectorySize(DATA_DIR);
    
    console.log('\n【統計情報】');
    console.log('-'.repeat(60));
    console.log(`Thread数:          ${threads.length}`);
    console.log(`Artifact数:        ${artifacts.length}`);
    console.log('');
    console.log('【ストレージ使用量】');
    console.log('-'.repeat(60));
    console.log(`Threads JSON:      ${formatBytes(threadsSize)}`);
    console.log(`Thread Files:      ${formatBytes(threadFilesSize)}`);
    console.log(`Artifacts:         ${formatBytes(artifactsSize)}`);
    console.log(`Data (全体):       ${formatBytes(dataSize)}`);
    console.log('-'.repeat(60));
    
    // 最大のArtifact Top 5
    const artifactSizes = [];
    for (const artifact of artifacts) {
      const artifactDir = path.join(ARTIFACTS_DIR, artifact.id);
      const size = await getDirectorySize(artifactDir);
      artifactSizes.push({ artifact, size });
    }
    
    artifactSizes.sort((a, b) => b.size - a.size);
    
    if (artifactSizes.length > 0) {
      console.log('\n【サイズの大きいArtifact Top 5】');
      console.log('-'.repeat(60));
      
      for (const { artifact, size } of artifactSizes.slice(0, 5)) {
        const sizeStr = formatBytes(size).padStart(12);
        const filename = (artifact.filename || 'N/A').substring(0, 30);
        console.log(`${sizeStr}  ${filename}`);
      }
      console.log('-'.repeat(60));
    }
    
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

// メインループ
async function main() {
  try {
    // ディレクトリの存在確認・作成
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.mkdir(ARTIFACTS_DIR, { recursive: true });

    while (true) {
      displayMenu();
      const choice = await question('\n選択してください: ');

      switch (choice) {
        case '1':
          await listThreads();
          break;
        case '2':
          await deleteThread();
          break;
        case '3':
          await bulkDeleteThreads();
          break;
        case '4':
          await listArtifacts();
          break;
        case '5':
          await deleteArtifact();
          break;
        case '6':
          await deleteArtifactsByThread();
          break;
        case '7':
          await detectOrphanedArtifacts();
          break;
        case '8':
          await exportThreadsToCSV();
          break;
        case '9':
          await exportArtifactsToCSV();
          break;
        case '10':
          await checkStorageUsage();
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
    console.error('エラー:', error);
    rl.close();
    process.exit(1);
  }
}

main();