# Queryn Tool Protocol v1

Advanced Tool использует JSON-RPC 2.0 через stdio или локальный HTTP.

## Handshake

Host вызывает `initialize` с protocol version, project-independent runtime
capabilities и временными paths. Tool возвращает поддерживаемую версию,
operations и capabilities. Несовместимая версия завершает запуск без публикации.

## Methods

- `health`
- `operations/list`
- `jobs/start`
- `jobs/get`
- `jobs/cancel`
- `context/resolve` для объявленного Context Provider;
- `connectors/pull` для возобновляемого Connector;
- `models/complete` для объявленного Model Provider;
- `shutdown`

## Notifications

- `jobs/progress`
- `logs/event`

## Job result

Результат содержит structured output и список candidate payloads относительно
`/queryn/outbox`. Absolute paths и `..` запрещены. Host не доверяет объявленным
MIME, size или hash и вычисляет их заново.

Remote/MCP runtime, у которого нет локального outbox mount, может добавить к
payload поле `contentBase64`. Host принимает только canonical relative path,
ограничивает суммарный inline output 12 MiB, материализует его в собственный
outbox и удаляет base64 из результата до persistence. Крупный binary output
должен идти через отдельный согласованный transport, а не безразмерный JSON.

## Context result

`context/resolve` получает `providerId`, artifact manifest в read-only input, level,
recipient и token budget. Host повторно ограничивает text/structured data бюджетом,
проверяет sources, не позволяет понизить sensitivity и пересекает
`allowedRecipients` с политикой артефакта.

## Model result

`models/complete` получает `providerId` и нормализованный model request без
секретов host. Ответ обязан содержать `text` и фактически использованную `model`.
Manifest заранее фиксирует `recipient: local | cloud`; cloud-вызов не начинается
без явного подтверждения получателя, которое записывается в session events.

## MCP

MCP servers подключаются адаптером. MCP Tools отображаются в operations, MCP
Resources - в context providers: contribution задаёт `resourceUriTemplate`, host
подставляет URL-encoded `{artifactId}` и вызывает `resources/read`. Text content
попадает в Context Envelope, binary content представляется только MIME-меткой и
не маскируется под prompt text.

Если `tools/call` возвращает экспериментальный MCP task, adapter опрашивает
`tasks/get`, передаёт отмену в `tasks/cancel` и завершает внешний task внутри
таймаута текущего Queryn Job. Внутренний Queryn Job остаётся источником истины
для approvals, retention, provenance и публикации артефактов. Ответы stdio/HTTP
имеют host-enforced предел размера; MCP server не может вернуть payload в
неограниченной JSON-строке.
