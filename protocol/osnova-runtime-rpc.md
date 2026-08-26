# Osnova Runtime RPC v1

Transport is newline-delimited JSON-RPC 2.0 over a random Unix domain socket on macOS or named pipe on Windows. Each request includes `_auth` in params; the bearer token is generated per runtime instance and must remain in desktop main/headless client.

Method groups:

- `project.create|open|validate|migrate|inspect-adoption|adopt`;
- `extension.install|update|rollback|connect|disconnect|list`;
- `operation.list|invoke`, `approval.decide`;
- `artifact.import|publish|read|list`;
- `session.create|fork|append|update|list|events`;
- `context.preview|resolve|reindex|search`;
- `agent.chat|agent.chat.cancel|agent.chat.get|agent.chat.resume|agent.chat.approve`;
- `job.get|list|cancel|subscribe`;
- `runtime.status|start|stop`;
- `connector.list|sync`;
- `model.install|list|remove`, `model.provider.configure|config-list|list|models-list`;
- `credential.remove`;
- `diagnostics.doctor|export`.

Методы `agent.plan`, `agent.get`, `agent.execute`, `agent.approve` и
`agent.cancel` не входят в RPC v1. Агентный запрос запускается через
`agent.chat` и исполняется единым диалоговым tool-loop. `agent.chat.approve`
подтверждает отдельный ожидающий вызов operation и не принимает или исполняет
структурный AgentPlan.

Server notifications preserve the JSON-RPC notification shape and are delivered
only to authenticated local clients:

- `job.changed` — durable job state/progress changed;
- `approval.required` — the job entered `waiting-approval`;
- `runtime.changed` — a process, container or remote runtime changed state;
- `artifact.published` — an atomic artifact batch was published into a project;
- `agent.activity` — tool-loop activity changed;
- `agent.output.delta` — a fragment of the streamed assistant response.

A terminal job is emitted only after portable session audit data and published
artifact descriptors are durable. Notifications are hints for reactive clients,
not the source of truth: after reconnect, clients recover state through
`job.list`, `runtime.status`, `artifact.list` and session events.

`runtime.start` принимает `projectPath` и `runtimeId`, проверяет подключение
владельца runtime к проекту, выполняет `health` и оставляет process живым только
для `project/shared` lifecycle. `job` и OCI завершаются после health check.
`agent.chat` требует `sessionId`, `goal` и выбранную модель. Для провайдера с
`recipient: cloud` перед запуском требуется `recipientApproval`. Параметры
`maxSteps` и `maxDurationSeconds` ограничивают один диалоговый запуск. Вызовы
operations проходят обычную проверку доступности и risk policy. Если операция
требует решения пользователя, job получает `waiting-approval`, а решение можно
передать через `agent.chat.approve` для агентного вызова или через
`approval.decide` для обычного `operation.invoke`.

`context.resolve` принимает risk `approval` для network/native custom provider.
Сам файл проекта не может выдать это разрешение: grants и сохранённые правила
живут в локальном runtime state.

`mcp.server.register`, `mcp.server.list` и `mcp.server.unregister` пока не входят
в dispatch этого RPC. Они доступны через прямой API `OsnovaRuntime` и тестовые
сценарии, а одноимённые desktop bridge методы не образуют рабочий публичный
RPC-путь до добавления серверных dispatch-кейсов.

RPC is a local process contract, not an extension API. Tools use Osnova Tool Protocol v1 or MCP adapter and never receive the runtime bearer token.
