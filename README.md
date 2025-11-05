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
    Artifact編集ツールの省力化（全文出力はトークン消費が激しい）
        差分編集ツールは素晴らしいアイディアです！しかし、行を数値で指定させるのは、LLMが正確に指定できるか、という点で危険ではありませんか？
        startとendをパターンマッチング（連続したスペースや改行は無視）で指定すべきなように思えます。その際は、startにマッチする部分を先頭から末尾に向けて検索し、startにマッチする部分があれば、そこから最も下側近傍にあるendを検出する方式にしましょう。そしてstartが複数マッチする場合は、複数個所で置換/挿入/削除を行うべきです。
        また、ファイル全体で修正すべき個所が1部のみであるとは限りませんので、edit_type/start/end/contentの組み合わせは配列として受け取るべきです。

        read_artifactについては、summary_onlyオプションを追加するというよりも、read_artifactに「enum(Top/Bottom)+ n行」のオプションを追加して、オプションの指定がなければ全体を返し、オプションの指定があれば指定行分だけ返すという設計ではどうでしょう？
        それらに加えて、search_in_artifact的なtoolを追加して、「検索パターン（連続したスペースや改行は無視）」+「マッチ部分の上方n行」+「マッチ部分の下方m行」という必須パラメータを受け取って、対象テキストが存在する範囲を貪欲に取得し、配列として返す、というのはどうですか？

        良さそうでされば、まずはpatch_artifactツールと、その中身の関数を実装してほしいです。
    Reasoning部分や、場合によってはToolCall部分を、会話履歴に追加（現在はReasoningしても内容はロスしている）
    toolsにAIエージェント追加
    別々のスレッドから同じアーティファクトの参照（アーティファクト検索エクスプローラが必要？）
    Reasningの強度設定をチャットヘッダーに追加
    UIからMCPツールの追加・設定
    Shift-jis対応

    1. レスポンシブ対応
    2. システムプロンプト編集と同様に、応答スキーマの設定をUIから可能に
    3. MCPサーバーの追加