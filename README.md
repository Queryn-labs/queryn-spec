# osnova-spec

Открытая исполнимая спецификация Osnova Reborn. Текущий формат проекта — `0.2`; `0.1` остаётся читаемым и мигрируется только явно.

```text
project/
  osnova.json
  notes/
  assets/
  artifacts/
  sessions/
  relations/
  .osnova/
```

`schemas/` содержит публичные JSON Schema проекта, артефактов, sessions, jobs, context и extension manifest. `protocol/` фиксирует Osnova Tool Protocol v1 и локальный RPC. Примеры находятся в `examples/`.

Проект остаётся понятным после удаления `.osnova/`. Отсутствующее расширение, модель, AI или OCI не препятствуют открытию.

`node scripts/verify-contracts.mjs` проверяет локальные `$ref`, обязательные поля
публичных TypeScript-интерфейсов и golden Reborn project. В multi-repo checkout
пути можно передать через `--core` и `--sdk`.

## Лицензия

Текст — CC BY 4.0; JSON Schema и машинно-читаемые примеры — MIT. Изменение долгоживущего контракта требует синхронного обновления core, docs и ADR.
