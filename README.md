## 1. install
```bash
npm install
```

### 1-1. copy .env
```bash
cp .env_copy .env
```

### 1-2. edit .env
```.env
# OpenAI API設定
OPENAI_API_KEY=sk-proj-XXXXXXXXXXXXXXXXXXXXX
    ↑ get api-key from openai developers

# Default Model
ORCHESTRATOR_MODEL=o4-mini
        ↓ chose from below
    # gpt-5, gpt-5-codex, gpt-5-chat-latest, gpt-4.1, gpt-4o, o1, o3
    # gpt-5-mini, gpt-5-nano, gpt-4.1-mini, gpt-4.1-nano, gpt-4o-mini, o1-mini, o3-mini, o4-mini, codex-mini-latest.

# サーバー設定
PORT=3000
    ↑ set preferred port number
```

## 2. run
```bash
npm start
```

## 3. next-step
    Discord 課金 bot + App Embed
    
    Reasoning部分や、場合によってはToolCall部分を、会話履歴に追加（現在はReasoningしても内容はロスしている）
    toolsにAIエージェント追加
    別々のスレッドから同じアーティファクトの参照（アーティファクト検索エクスプローラが必要？）
    Reasningの強度設定をチャットヘッダーに追加
    UIからMCPツールの追加・設定
    Shift-jis対応

    1. レスポンシブ対応
    3. MCPサーバーの追加

    manage-pending-users.js の UX を user-manager.js 方式に変更
    discordでartifactが作られたらchannelにリンクを貼る...ことは認証しないとできないので、生ファイルを投稿

    server.js の以下の部分で、 OpenAI API へメタデータが送信できていないので、 Assistant API の Thread 機能を使う必要あり（あとメッセージの送信時間も送れていない）
    // メッセージ送信と応答生成
    app.post('/api/threads/:threadId/messages', requireAuth, checkCredit, async (req, res)

    discord-botでのtools禁止オプション追加
    名前などのbotの人格設定部分をsystempromptに含めるべき