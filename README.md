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
    5. システムプロンプト編集と同様に、応答スキーマの設定をUIから可能に
    6. MCPサーバーの追加