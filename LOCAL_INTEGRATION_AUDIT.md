# Локальный интеграционный аудит One of Us — 24 сентября 2026

## 1. Фактическая архитектура

Статический frontend обслуживается тем же Node HTTP-сервером, что и API.
`payment-modal.js` / `payment-session.js` вызывают `POST /api/orders`.
`payment-service.js` валидирует запрос через `payment-domain.js`;
`postgres-repository.js` сохраняет участника, заказ, UTC-раунд и резерв суммы.
`payment-monitor.js` читает ERC-20 Transfer через JSON-RPC и сохраняет платежи.
После необходимого числа подтверждений одна транзакция PostgreSQL обновляет заказ,
платёж, диапазон билетов, ledger и счётчики раунда.
Frontend опрашивает `GET /api/orders/:id`; событие оплаты обновляет Your Entry и Live Activity.

Основные таблицы: participants, orders, payments, payment_code_reservations,
payment_amount_reservations, payment_identifier_reservations, ticket_ranges,
ticket_ledger_entries, rounds, scanner_state. Миграции 001–010 применяются
с нуля в новых схемах; ранее созданная локальная БД также проходит повторный migrate.

Состояния заказа: `pending → payment_detected → paid`.
Подтверждение платежа (`payments.payment_status=confirmed`) и выдача билетов
атомарны с переводом заказа в paid. До подтверждения ledger пуст.
Неоплаченный заказ становится expired; перевод в пределах окна сверки затем
даёт late_payment без билетов. Дополнительный перевод к уже найденному/оплаченному
заказу получает duplicate_payment в payments и не откатывает состояние заказа.
Не найденная сумма — unmatched; неоднозначное сопоставление — manual_review.
Повторные GET-запросы и сканирования не переводят paid назад.

Раунды проходят закрытие, snapshot, drand, settlement и payout через существующие
сервисы и round-lifecycle-orchestrator.js. Минимум — 10 оплаченных билетов.
При переносе сохраняются исходные ledger/round_id, а eligibility включает цепочку
предыдущих rolled_over раундов.

## 2. Выполненные проверки

| Команда / проверка | Результат |
| --- | --- |
| `npm run local:integration:start` | PostgreSQL Docker, Hardhat 31337, существующий MockUSDT и миграции готовы |
| `npm test` | 57 прошли; 13 opt-in интеграционных пропущены в обычном режиме |
| `node scripts/audit-local.js` | 20 файлов, суммарно 74 проверки прошли, 0 пропусков, exit 0 |
| `npm run test:browser` | 9 прошли; локальный платёжный E2E намеренно пропущен без opt-in |
| `node scripts/audit-local.js tests/browser/payment-local.spec.js` | Полный платёжный E2E прошёл; заключительный запуск также выполнен вместе с payout suite |
| `node scripts/audit-local.js tests/payout.integration.test.js tests/browser/payment-local.spec.js` | Обе группы прошли после последних исправлений |
| `git diff --check`, `node --check` для изменённых рабочих JS-модулей, runner и browser test | Прошли |
| Lint / typecheck / build | Соответствующих команд и конфигурации в проекте нет |

Начальные шесть HTTP-ошибок и первая browser-ошибка были EPERM при открытии
локальных портов в песочнице; с разрешённым запуском они исчезли.
Включённые интеграционные тесты затем обнаружили устаревшие фикстуры
origin_round_id и нестабильное ожидание receipt; причины и исправления ниже.
Промежуточные ошибки нового browser test были неверным селектором теста и
ожиданием другого формата диапазона; сам frontend для этого не менялся.

Runner создаёт отдельную `audit_<timestamp>_<index>` схему для каждого файла.
Существующие public-данные не очищались. Схемы оставлены для проверки.
Старые fixture TRUNCATE выполняются только внутри новых схем.

## 3. Сквозной результат и записи БД

`GET IN → order → MockUSDT → monitor → 3 confirmations → ticket ledger → UI` — PASS.

Заключительный browser run: схема `audit_1790269777614_1`.

| Поле | Значение |
| --- | --- |
| Order | `4f7f158b-e7e0-484b-92b3-fbb505a0338d` |
| Participant | `542b8c7e-870f-4e49-ac17-0c0ac3e09911` |
| Round | `9ee8e2e8-462a-41a7-8423-7c9ce2945ee9` |
| Payment | `8809d0f1-d99e-457d-93be-80d126070178` |
| Точная сумма | 2.001 MockUSDT = 2 001 000 единиц |
| Билеты | `#000001–000002` |
| Транзакция | `0x4da69822776c6e0e12156fbababfca8c48561d42bdc0cd7ba13b047e71715f8d` |
| Состояния | orders: paid; payments: confirmed |
| Связность | ledger participant и round совпадают с заказом; payment_id ведёт к подтверждённому переводу |

В тесте проверены: пустой ledger до третьего подтверждения; одна запись ledger
и один ticket_range после него; отсутствие повторной выдачи при двух параллельных
scan, повторной обработке того же log/transaction, другом log_index той же
транзакции, пяти GET-запросах и дополнительном реальном переводе той же суммы.

HTTP-сервер, подключение БД, repository и monitor перезапускались после detection.
Pending-заказ восстановился после reload без новой записи orders; закрытие и
повторное открытие окна возобновили опрос. После paid страница без ручной
перезагрузки показала билеты, Your Entry и Live Activity.
Повторная загрузка сохранила участника, профиль и подтверждённый диапазон.

Проверки ошибок: некорректный кошелёк блокирует Continue и даёт HTTP 400;
несуществующий заказ — HTTP 404 с восстановлением формы при сохранённом устаревшем ID;
неверный перевод 0.2 MockUSDT — unmatched; поздний — late_payment без билетов,
с понятным сообщением в окне. В БД по одному платежу confirmed, duplicate_payment,
unmatched и late_payment. JS-ошибок страницы не зарегистрировано.

Просмотрены desktop-снимки формы, успешной оплаты и страницы после reload.
Снимки находятся в `test-results/payment-local-GET-IN-→-rea-650b9-ger-→-UI-reload-and-restart/`:
payment-form.png, payment-success.png, payment-confirmed.png.

## 4. Найденные ошибки и исправления

| Симптом | Причина | Исправление |
| --- | --- | --- |
| MockUSDT нельзя проверить входящим монитором | Жёсткие mainnet chain/token | Явный local-режим: loopback, chain 31337, тестовый токен; API возвращает фактическую сеть |
| После закрытия окна оплата остаётся в ожидании | close отменял timer, open не восстанавливал | Возобновление polling при повторном открытии |
| Reload терял незавершённый заказ | Хранился только профиль/participant ID | Сохранение ID pending-заказа и восстановление серверного состояния |
| Your Entry / Activity обновлялись только по общему таймеру | Событие отправлялось window, слушатель установлен на document | Общий document event; проверено обновление карточек за 2 секунды после success |
| Смена payout wallet ломала новую покупку | Сохранённый participant ID вставлялся повторно с другим кошельком, конфликт PK | Сервер генерирует ID; существующий участник определяется по уникальному wallet, прежние выплаты не меняются |
| Подтверждение около полуночи могло попасть во вчерашний open-раунд либо ждать отсутствующий новый | Проверялся status без closes_at; новый раунд не создавался при confirm | Проверка времени закрытия и создание текущего UTC-раунда при необходимости |
| Перенесённые билеты и банк исчезали из API отображения | Выборка по paid_at текущего дня | Выборка ledger по цепочке eligibility текущего раунда |
| late_payment оставался в бесконечном ожидании | Frontend обрабатывал только paid/expired | Терминальное сообщение о позднем переводе, остановка polling |
| drand/payout fixtures падали после миграции 010 | Отсутствовал обязательный origin_round_id | Фикстуры сохраняют исходный раунд |
| Payout test периодически ждал уже замайненную транзакцию до timeout | Кэш block reads в RPC-клиенте на automining Hardhat | Отключён cacheTimeout только у тестового RPC-клиента; два последующих прогона успешны |

Также отсечены запоздалые ответы polling для уже сменившегося заказа/шага;
при возврате из ожидания timer останавливается.
Новые зависимости не добавлялись; миграции и production-конфигурация не менялись.

## 5. Проверка жизненного цикла

PASS: оплаченные билеты учитываются в минимуме; бесплатные не заменяют минимум;
underfilled закрытие и повторные rollovers идемпотентны; исходный round_id ledger
сохраняется, перенесённые билеты входят в новый snapshot ровно один раз.

Новая регрессия моделирует UTC-границу: 2 оплаченных билета вчера,
8 подтверждаются уже сегодня до закрытия вчерашнего раунда; затем rollover
переносит 2 USDT, API показывает все 10 билетов и банк 10 USDT.
Ещё один старый заказ подтверждается после rollover в сегодняшнем раунде;
новый заказ тоже привязан к нему. Итоговый snapshot: 11 билетов / 11 USDT,
с сохранением происхождения каждого диапазона.
Отдельный полный orchestrator E2E проходит OPEN → COMPLETED с реальной выплатой
MockUSDT; его drand fixture детерминирован. Криптографическая проверка настоящего
исторического drand beacon отдельно прошла через публичный Quicknet.

## 6. Файлы, изменённые именно этим аудитом

- `.gitignore` — исключены артефакты Playwright.
- `README.md` — команды аудита, локальная конфигурация, состояния; исправлены устаревшие описания.
- `payment-modal.js` — восстановление заказа, polling, событие UI и терминальное сообщение.
- `payment-monitor.js` — явная конфигурация сети/токена, изолированное имя scanner.
- `payment-network.js` — новый валидатор local/default target.
- `payment-service.js` — фактическая сеть в ответах API.
- `postgres-repository.js` — wallet/participant, UTC issuance, отображение rollover.
- `scripts/audit-local.js` — воспроизводимый runner с отдельными схемами.
- `tests/browser/payment-local.spec.js` — реальный браузерный платёжный E2E.
- `tests/payment-network.test.js` — ограничения локальной конфигурации.
- `tests/payment-round.postgres.test.js` — платежи, rollover и UTC-регрессия.
- `tests/drand.postgres.test.js` — актуальная snapshot fixture.
- `tests/payout.integration.test.js` — актуальная fixture и RPC без кэша для теста.
- `LOCAL_INTEGRATION_AUDIT.md` — этот отчёт.

Существующие незакоммиченные изменения сохранены. Коммит не создавался.
Стандартный bootstrap обновил только предусмотренный им игнорируемый
`.env.integration.local`; его содержимое и тестовый ключ в отчёт не включены.

## 7. Финальный git status --short

```text
 M .gitignore
 M AGENTS.md
 M README.md
 M index.html
 M payment-config.js
 M payment-modal.js
 M payment-session.js
 M payment-sources.js
 M script.js
 M styles.css
 M tests/payment-session.test.js
?? .env.example
?? .env.integration.example
?? LOCAL_INTEGRATION_AUDIT.md
?? compose.integration.yaml
?? compose.yaml
?? data/
?? db.js
?? drand-winner-service.js
?? drand.js
?? draw-snapshot-service.js
?? migrations/
?? package-lock.json
?? package.json
?? payment-domain.js
?? payment-monitor.js
?? payment-network.js
?? payment-service.js
?? payout-config.js
?? payout-observability.js
?? payout-provider.js
?? playwright.config.js
?? postgres-repository.js
?? round-lifecycle-orchestrator.js
?? round-service.js
?? scripts/
?? seed-demo-draws.js
?? server.js
?? settlement-domain.js
?? settlement-service.js
?? tests/browser/
?? tests/drand.integration.test.js
?? tests/drand.postgres.test.js
?? tests/drand.test.js
?? tests/draw-snapshot.postgres.test.js
?? tests/draw-snapshot.test.js
?? tests/fixtures/
?? tests/orchestrator.e2e.test.js
?? tests/payment-backend.test.js
?? tests/payment-monitor.test.js
?? tests/payment-network.test.js
?? tests/payment-round.postgres.test.js
?? tests/payout.integration.test.js
?? tests/rollover-ticket-eligibility.postgres.test.js
?? tests/round-closing.postgres.test.js
?? tests/round-closing.test.js
?? tests/round-lifecycle-orchestrator.test.js
?? tests/settlement.test.js
?? tests/site-summary.test.js
?? tests/verify-draw.http.test.js
```

## 8. Конкретные ограничения проверки

- Реальные средства и mainnet-переводы не использовались; публичная сеть выплат не проверялась.
- В browser E2E вызывается настоящий scan с управляемым майнингом, а не ожидание
  фонового интервала monitor.start(). Длительная работа interval/scheduler под нагрузкой не проверялась.
- Reorg/отмена уже обнаруженного блокчейн-события не моделировались.
- Полный orchestrator использует детерминированный drand fixture; проверка реального
  drand beacon выполнена отдельно, а не в одном запуске с новой покупкой.

Локальный PostgreSQL/Hardhat остаются запущены. Временные HTTP-серверы и браузеры
тестов закрыты. Audit-схемы и скриншоты оставлены для проверки.

## 9. Следующая инженерная задача

Подключить этот изолированный интеграционный прогон к CI: PostgreSQL + Hardhat +
MockUSDT + browser E2E, чтобы изменения платежей и миграций автоматически
проверялись до публикации.
