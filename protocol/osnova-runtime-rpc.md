# Osnova Runtime RPC v1

Transport is newline-delimited JSON-RPC 2.0 over a random Unix domain socket on macOS or named pipe on Windows. Each request includes `_auth` in params; the bearer token is generated per runtime instance and must remain in desktop main/headless client.

Method groups:

- `project.create|open|validate|migrate`;
- `extension.install|update|rollback|connect|disconnect|list`;
- `operation.list|invoke`, `approval.decide`;
- `artifact.import|publish|read|list`;
- `session.create|append|list|events`;
- `context.preview|resolve|reindex|search`;
- `agent.plan|get|execute|approve|cancel`;
- `job.get|list|cancel|subscribe`;
- `runtime.status|start|stop`;
- `model.install|list|remove`, `model.provider.configure|config-list|list`;
- `diagnostics.doctor|export`.

Server notifications preserve the JSON-RPC notification shape and are delivered
only to authenticated local clients:

- `job.changed` — durable job state/progress changed;
- `approval.required` — the job entered `waiting-approval`;
- `runtime.changed` — a process, container or remote runtime changed state;
- `artifact.published` — an atomic artifact batch was published into a project.

A terminal job is emitted only after portable session audit data and published
artifact descriptors are durable. Notifications are hints for reactive clients,
not the source of truth: after reconnect, clients recover state through
`job.list`, `runtime.status`, `artifact.list` and session events.

`runtime.start` принимает `projectPath` и `runtimeId`, проверяет подключение
владельца runtime к проекту, выполняет `health` и оставляет process живым только
для `project/shared` lifecycle. `job` и OCI завершаются после health check.
`agent.plan` требует `recipientApproval`, прежде чем compact snapshot уйдёт
провайдеру с `recipient: cloud`. Extension-backed provider дополнительно проходит
effective runtime policy; `providerApproval` может подтвердить или сохранить это
правило. План принимает `maxSteps` и `maxDurationSeconds`, а шаг может ссылаться
на уже существующие `inputArtifacts` или на результаты `inputFromSteps`.

`context.resolve` принимает risk `approval` для network/native custom provider.
Сам файл проекта не может выдать это разрешение: grants и сохранённые правила
живут в локальном runtime state.

RPC is a local process contract, not an extension API. Tools use Osnova Tool Protocol v1 or MCP adapter and never receive the runtime bearer token.
