// payment.js
// 支払い処理・クレジット購入システム

import Stripe from 'stripe';
import * as auth from './auth.js';

// Stripe初期化
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// 環境変数から購入レートを取得（デフォルト: 100円=1000クレジット）
const CREDIT_PURCHASE_RATE = parseFloat(process.env.CREDIT_PURCHASE_RATE) || 10; // 1円あたりのクレジット数
const CURRENCY = process.env.CURRENCY || 'jpy';
const MIN_PURCHASE_AMOUNT = parseInt(process.env.MIN_PURCHASE_AMOUNT) || 100; // 最小購入額（円）
const MAX_PURCHASE_AMOUNT = parseInt(process.env.MAX_PURCHASE_AMOUNT) || 100000; // 最大購入額（円）

// 金額からクレジット数を計算（端数切り捨て）
export function calculateCredits(amount) {
  return Math.floor(amount * CREDIT_PURCHASE_RATE);
}

// クレジット数から金額を計算
export function calculateAmount(credits) {
  return Math.ceil(credits / CREDIT_PURCHASE_RATE);
}

// プリセットの購入プラン
export const PURCHASE_PLANS = [
  { 
    id: 'starter', 
    name: 'スターター', 
    amount: 500, 
    credits: calculateCredits(500),
    description: '初めての方におすすめ'
  },
  { 
    id: 'basic', 
    name: 'ベーシック', 
    amount: 1000, 
    credits: calculateCredits(1000),
    description: '標準的なプラン'
  },
  { 
    id: 'standard', 
    name: 'スタンダード', 
    amount: 3000, 
    credits: calculateCredits(3000),
    description: '人気No.1プラン'
  },
  { 
    id: 'premium', 
    name: 'プレミアム', 
    amount: 5000, 
    credits: calculateCredits(5000),
    description: 'たっぷり使いたい方向け'
  },
  { 
    id: 'ultimate', 
    name: 'アルティメット', 
    amount: 10000, 
    credits: calculateCredits(10000),
    description: 'ヘビーユーザー向け'
  }
];

// Stripe Checkoutセッションの作成
export async function createCheckoutSession({
  userId,
  amount,
  credits,
  successUrl,
  cancelUrl
}) {
  // バリデーション
  if (!userId) {
    throw new Error('User ID is required');
  }

  if (amount < MIN_PURCHASE_AMOUNT || amount > MAX_PURCHASE_AMOUNT) {
    throw new Error(`Amount must be between ${MIN_PURCHASE_AMOUNT} and ${MAX_PURCHASE_AMOUNT}`);
  }

  // ユーザーの存在確認
  const user = await auth.getUser(userId);
  if (!user) {
    throw new Error('User not found');
  }

  // Checkoutセッション作成
  const session = await stripe.checkout.sessions.create({
    payment_method_types: ['card'],
    line_items: [
      {
        price_data: {
          currency: CURRENCY,
          product_data: {
            name: `クレジット購入 (${credits.toLocaleString()} クレジット)`,
            description: `${amount.toLocaleString()}${CURRENCY === 'jpy' ? '円' : CURRENCY}で${credits.toLocaleString()}クレジットを購入`,
          },
          unit_amount: CURRENCY === 'jpy' ? amount : amount * 100, // JPYは整数、他は最小単位
        },
        quantity: 1,
      },
    ],
    mode: 'payment',
    success_url: successUrl,
    cancel_url: cancelUrl,
    client_reference_id: userId,
    metadata: {
      userId,
      credits: credits.toString(),
      amount: amount.toString()
    }
  });

  return session;
}

// Webhookイベントの検証と処理
export async function handleWebhook(rawBody, signature) {
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  
  if (!webhookSecret) {
    throw new Error('STRIPE_WEBHOOK_SECRET is not configured');
  }

  let event;

  try {
    // Stripeの署名を検証
    event = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
  } catch (err) {
    throw new Error(`Webhook signature verification failed: ${err.message}`);
  }

  // イベントタイプに応じて処理
  switch (event.type) {
    case 'checkout.session.completed':
      await handleCheckoutCompleted(event.data.object);
      break;
    
    case 'payment_intent.succeeded':
      console.log('Payment succeeded:', event.data.object.id);
      break;
    
    case 'payment_intent.payment_failed':
      console.log('Payment failed:', event.data.object.id);
      break;
    
    default:
      console.log(`Unhandled event type: ${event.type}`);
  }

  return { received: true };
}

// チェックアウト完了時の処理
async function handleCheckoutCompleted(session) {
  const userId = session.client_reference_id || session.metadata.userId;
  const credits = parseInt(session.metadata.credits);

  if (!userId || !credits) {
    console.error('Missing userId or credits in session metadata');
    return;
  }

  try {
    // クレジットを付与（Admin権限で実行）
    // この関数は内部処理なので、直接DBを更新
    const user = await auth.getUser(userId);
    if (!user) {
      console.error(`User not found: ${userId}`);
      return;
    }

    // 管理者として自分自身に権限を与える処理
    // 実際には、この関数は内部から呼ばれるので、直接クレジットを追加
    await auth.updateUser(userId, {
      remaining_credit: user.remaining_credit + credits
    });

    console.log(`✓ Credits added to user ${userId}: +${credits} credits (Total: ${user.remaining_credit + credits})`);
    
    // 購入履歴の記録（オプション: 別テーブルで管理する場合）
    await recordPurchaseHistory({
      userId,
      amount: parseInt(session.metadata.amount),
      credits,
      sessionId: session.id,
      paymentStatus: session.payment_status
    });

  } catch (error) {
    console.error('Error adding credits:', error);
    // エラー処理: 管理者に通知など
  }
}

// 購入履歴の記録（オプション）
async function recordPurchaseHistory({
  userId,
  amount,
  credits,
  sessionId,
  paymentStatus
}) {
  // 将来的に購入履歴テーブルを作成する場合はここで記録
  console.log('Purchase recorded:', {
    userId,
    amount,
    credits,
    sessionId,
    paymentStatus,
    timestamp: new Date().toISOString()
  });
}

// 購入履歴の取得（将来の実装用）
export async function getPurchaseHistory(userId) {
  // 購入履歴テーブルから取得
  // 現時点では未実装
  return [];
}

// 設定情報の取得
export function getPaymentConfig() {
  return {
    creditRate: CREDIT_PURCHASE_RATE,
    currency: CURRENCY,
    minAmount: MIN_PURCHASE_AMOUNT,
    maxAmount: MAX_PURCHASE_AMOUNT,
    plans: PURCHASE_PLANS
  };
}

// Stripeの公開鍵を取得
export function getPublishableKey() {
  return process.env.STRIPE_PUBLISHABLE_KEY;
}