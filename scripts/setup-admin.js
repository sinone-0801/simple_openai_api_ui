// setup-admin.js
// 初期Adminユーザーを作成するセットアップスクリプト

import * as auth from '../auth.js';
import readline from 'readline';

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function question(prompt) {
  return new Promise((resolve) => {
    rl.question(prompt, resolve);
  });
}

async function setup() {
  console.log('='.repeat(50));
  console.log('Admin User Setup');
  console.log('='.repeat(50));
  console.log('');

  try {
    // データベース初期化
    await auth.initDatabase();
    console.log('✓ Database initialized');
    console.log('');

    // Admin情報の入力
    console.log('Please enter admin account information:');
    console.log('');

    const userId = await question('Admin User ID (default: admin): ');
    const adminUserId = userId.trim() || 'admin';

    const password = await question('Admin Password (default: admin123): ');
    const adminPassword = password.trim() || 'admin123';

    const creditInput = await question('Initial credit (default: 10000): ');
    const remainingCredit = parseInt(creditInput.trim()) || 10000;

    console.log('');
    console.log('Creating admin user...');

    // Admin作成
    const admin = await auth.createUser({
      userId: adminUserId,
      password: adminPassword,
      authority: auth.Authority.ADMIN,
      remainingCredit: remainingCredit
    });

    console.log('');
    console.log('✓ Admin user created successfully!');
    console.log('');
    console.log('Admin Account Information:');
    console.log('-'.repeat(50));
    console.log(`User ID:          ${admin.userId}`);
    console.log(`Password:         ${adminPassword}`);
    console.log(`Authority:        ${admin.authority}`);
    console.log(`Remaining Credit: ${admin.remainingCredit.toLocaleString()} tokens`);
    console.log('-'.repeat(50));
    console.log('');
    console.log('⚠️  IMPORTANT: Please change the password after first login!');
    console.log('');
    console.log('Authorization header format:');
    console.log(`Bearer ${adminUserId}:${adminPassword}`);
    console.log('');

    // オプション: 開発用のテストユーザーも作成
    const createTestUser = await question('Create a test user? (y/N): ');
    
    if (createTestUser.toLowerCase() === 'y') {
      console.log('');
      console.log('Creating test user...');
      
      const testUser = await auth.createUser({
        userId: 'testuser',
        password: 'test123',
        authority: auth.Authority.USER,
        remainingCredit: 10000
      });

      console.log('✓ Test user created!');
      console.log('');
      console.log('Test User Information:');
      console.log('-'.repeat(50));
      console.log(`User ID:          ${testUser.userId}`);
      console.log('Password:         test123');
      console.log(`Authority:        ${testUser.authority}`);
      console.log(`Remaining Credit: ${testUser.remainingCredit.toLocaleString()} tokens`);
      console.log('-'.repeat(50));
      console.log('');
    }

    // Bot用のユーザー作成オプション
    const createBotUser = await question('Create a bot user (for Discord/Line)? (y/N): ');
    
    if (createBotUser.toLowerCase() === 'y') {
      const botUserId = await question('Bot User ID: ');
      const botGroupId = await question('Bot Group ID (optional): ');
      
      console.log('');
      console.log('Creating bot user...');
      
      const botUser = await auth.createUser({
        userId: botUserId.trim(),
        groupId: botGroupId.trim() || null,
        authority: auth.Authority.ADMIN, // Botは通常Admin権限
        remainingCredit: 10000
      });

      console.log('✓ Bot user created!');
      console.log('');
      console.log('Bot User Information:');
      console.log('-'.repeat(50));
      console.log(`User ID:          ${botUser.userId}`);
      console.log(`Group ID:         ${botUser.groupId || 'N/A'}`);
      console.log(`Authority:        ${botUser.authority}`);
      console.log(`Remaining Credit: ${botUser.remainingCredit.toLocaleString()} tokens`);
      console.log('-'.repeat(50));
      console.log('');
      
      if (botUser.groupId) {
        console.log('Authorization header format (with group):');
        console.log(`Bearer ${botUser.userId}:${botUser.groupId}:group`);
      } else {
        console.log('⚠️  Note: This bot user needs a password or group ID for authentication');
      }
      console.log('');
    }

    console.log('Setup completed successfully!');
    console.log('');
    console.log('Next steps:');
    console.log('1. Start the server: node server.js');
    console.log('2. Test authentication: curl -H "Authorization: Bearer admin:admin123" http://localhost:3000/api/auth/me');
    console.log('3. Change admin password using /api/auth/change-password');
    console.log('');

  } catch (error) {
    if (error.message.includes('already exists')) {
      console.error('');
      console.error('❌ Error: Admin user already exists!');
      console.error('');
      console.error('If you want to reset, please:');
      console.error('1. Delete the database file: rm data/users.db');
      console.error('2. Run this setup script again');
      console.error('');
    } else {
      console.error('❌ Error during setup:', error.message);
      console.error('');
    }
  } finally {
    await auth.closeDatabase();
    rl.close();
  }
}

setup().catch(console.error);
