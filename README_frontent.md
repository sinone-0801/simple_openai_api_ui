# 認証機能実装ガイド

## 概要

server.jsの認証機能に対応したフロントエンド実装です。ビルドレス設計で、publicディレクトリに直接配置できます。

## 実装ファイル

### 1. login.html
ログインページです。以下の機能を持ちます：

- **2つの認証方式をサポート**:
  - パスワード認証: `userId` + `password`
  - グループID認証: `userId` + `groupId`
- 認証成功時にトークンをlocalStorageに保存
- index.htmlにリダイレクト
- エラーメッセージ表示

#### 配置場所
```
public/login.html
```

### 2. index.html (認証対応版)
既存のindex.htmlに認証機能を追加しました。

#### 主な追加機能

**1. 認証チェック**
```javascript
async function checkAuth()
```
- ページ読み込み時に自動実行
- トークンがない、または無効な場合はlogin.htmlにリダイレクト

**2. トークン管理**
```javascript
function getAuthToken()
function getAuthHeaders()
```
- localStorageからトークンを取得
- APIリクエストに使用するヘッダーを生成

**3. ログアウト機能**
```javascript
function logout()
```
- サイドバーにログアウトボタンを追加
- トークンを削除してlogin.htmlにリダイレクト

**4. ユーザー情報表示**
```javascript
function updateUserInfo(user)
```
- サイドバーにユーザーID、残クレジットを表示

**5. 自動認証ヘッダー追加**
```javascript
window.fetch = async function(url, options = {})
```
- すべてのAPIリクエスト(`./api/`または`/api/`)に自動的にAuthorizationヘッダーを追加
- 401エラー時は自動的にlogin.htmlにリダイレクト

#### 配置場所
```
public/index.html
```

## 認証フロー

1. **初回アクセス**
   ```
   ユーザー → index.html → 認証チェック → トークンなし → login.html
   ```

2. **ログイン**
   ```
   login.html → POST /api/auth/login → トークン取得 → localStorageに保存 → index.html
   ```

3. **認証済みアクセス**
   ```
   index.html → 認証チェック → トークン有効 → アプリ表示
   ```

4. **APIリクエスト**
   ```
   fetch('./api/...') → 自動的にAuthorizationヘッダー追加 → サーバー処理
   ```

5. **ログアウト**
   ```
   ログアウトボタン → localStorage削除 → login.html
   ```

## トークン形式

server.jsの認証方式に対応：

### パスワード認証
```
Bearer userId:password
```

### グループID認証
```
Bearer userId:groupId:group
```

## 実装のポイント

### 1. 相対パス使用
すべてのURLは相対パス(`./`)で記述されています：
- `./api/auth/login`
- `./api/auth/me`
- `./index.html`
- `./login.html`

### 2. ビルドレス設計
外部ライブラリや複雑なビルドプロセスを必要としません：
- 純粋なHTML/CSS/JavaScript
- publicディレクトリに直接配置可能

### 3. 自動認証
fetchをラップすることで、コード全体を書き換えることなく認証を追加：
```javascript
// 既存のコードはそのまま
const response = await fetch('./api/threads');

// 自動的に以下のように変換される
const response = await fetch('./api/threads', {
  headers: {
    'Authorization': 'Bearer userId:password'
  }
});
```

### 4. エラーハンドリング
401エラーが発生した場合、自動的にlogin.htmlにリダイレクト：
```javascript
if (response.status === 401) {
    handleUnauthorized();
    throw new Error('Unauthorized');
}
```

## セキュリティ考慮事項

1. **トークンの保存**: localStorageに保存（XSS対策として適切なCSPの設定を推奨）
2. **HTTPS推奨**: 本番環境ではHTTPSを使用してください
3. **トークンの有効期限**: サーバー側で適切な有効期限を設定してください

## デプロイ

```bash
# ファイルをpublicディレクトリにコピー
cp login.html public/
cp index.html public/

# サーバー起動
node server.js
```

## カスタマイズ

### ユーザー情報の表示カスタマイズ
`updateUserInfo(user)`関数を編集して、表示する情報を変更できます：

```javascript
function updateUserInfo(user) {
    // ユーザー情報をカスタマイズ
    userInfoDiv.innerHTML = `
        <div>ユーザー: ${user.user_id}</div>
        <div>権限: ${user.authority}</div>
        <!-- 追加の情報 -->
    `;
}
```

### ログイン画面のデザイン変更
login.htmlの`<style>`タグ内を編集してカスタマイズできます。

## トラブルシューティング

### ログインできない
- ユーザーIDとパスワード/グループIDが正しいか確認
- ブラウザのコンソールでエラーを確認
- server.jsが起動しているか確認

### 401エラーが繰り返される
- localStorageにトークンが正しく保存されているか確認
- トークンの形式が正しいか確認
- サーバー側の認証ミドルウェアが正しく動作しているか確認

### ページが真っ白になる
- ブラウザのコンソールでJavaScriptエラーを確認
- ファイルパスが正しいか確認（相対パス使用）

## まとめ

この実装により、既存のserver.jsの認証機能と完全に統合されたフロントエンドが実現できます。ビルドレス設計なので、publicディレクトリに直接配置するだけで動作します。
