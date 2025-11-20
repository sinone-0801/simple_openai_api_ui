// ==================================================
// OAuth の state validation 用テストコード
// ==================================================
import { OAuthStateManager } from '../utils/oauth-state-validation.js';

export function testStateValidation() {
    console.log('\n=== State Validation Test ===\n');

    const manager = new OAuthStateManager();

    // テスト1: 正常なstate
    console.log('Test 1: Normal state validation');
    const state1 = manager.generateState('user123', { guildId: 'guild456' });
    console.log('Generated state:', state1);
    const result1 = manager.validateState(state1);
    console.log('Validation result:', result1);
    console.log('✓ Pass\n');

    // テスト2: 同じstateの再利用（失敗するべき）
    console.log('Test 2: Reuse same state (should fail)');
    const result2 = manager.validateState(state1);
    console.log('Validation result:', result2);
    console.log('✓ Pass (correctly rejected)\n');

    // テスト3: 存在しないstate
    console.log('Test 3: Non-existent state');
    const result3 = manager.validateState('invalid_state');
    console.log('Validation result:', result3);
    console.log('✓ Pass (correctly rejected)\n');

    // テスト4: 期限切れstate
    console.log('Test 4: Expired state');
    const state4 = manager.generateState('user789', {}, 0.01); // 0.01分 = 0.6秒
    console.log('Generated state:', state4);
    console.log('Waiting 1 second...');
    setTimeout(() => {
        const result4 = manager.validateState(state4);
        console.log('Validation result:', result4);
        console.log('✓ Pass (correctly expired)\n');
    }, 1000);
}

testStateValidation();