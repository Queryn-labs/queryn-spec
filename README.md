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

`npm run generate` генерирует контрактные TypeScript-типы из схем в
`osnova-core/packages/types/src/generated/` и `osnova-plugin-sdk/src/generated/`.
Сгенерированные файлы коммитятся, ручное редактирование запрещено: изменение
контракта вносится в схему, затем типы перегенерируются.

`npm run verify` проверяет локальные `$ref` во всех схемах и валидность golden
Reborn project. Оба репозитория-потребителя запускают эту же проверку свежести
перед своими тестами через `pretest`. В multi-repo checkout пути можно передать
через `--core` и `--sdk`, а режим `--check` падает, если сгенерированные файлы
устарели относительно схем.

`npm test` запускает тесты сканера гигиены комментариев. Для миграционного аудита
используйте `node scripts/check-comment-hygiene.mjs --repo <name>` в режиме отчета
или добавьте `--check`, чтобы завершить команду с ошибкой при нарушении. Пути и
правила `TODO` для репозиториев находятся в `scripts/comment-hygiene/repos.json`.

Контрактные векторы `slugify` и `slugifyIdentifier` хранятся в
`contract/slug-vectors.json`. Core и desktop проверяют их одним набором данных,
чтобы зеркало функции в renderer не расходилось с доменной реализацией.

## Лицензия

Текст — CC BY 4.0; JSON Schema и машинно-читаемые примеры — MIT. Изменение долгоживущего контракта требует синхронного обновления core, docs и ADR.
