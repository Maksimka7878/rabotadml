# RaботаDML — Telegram Bot для команды брокеров

## Что это

Telegram-бот для управления сменами менеджеров по продаже новостроек Москвы (бизнес/премиум/делюкс класс). Менеджеры открывают/закрывают смены, фиксируют квал лидов и партии заявок. Администратор видит всё в реальном времени. После каждого квал лида бот автоматически скачивает запись звонка из amoCRM, транскрибирует через Gemini AI и отправляет суммарайз + оценку лида.

## Деплой

Vercel Serverless (Hobby план). Единственная точка входа — `api/webhook.js`. Все функции в папке `api/` — отдельные serverless endpoints.

```
vercel --prod
```

Лимит: 30 сек для webhook, 60 сек для остальных функций (настроено в `vercel.json`).

## Переменные окружения (Vercel)

| Переменная | Описание |
|---|---|
| `BOT_TOKEN` | Telegram Bot API токен |
| `ADMIN_CHAT_ID` | Chat ID администратора (8035455470) |
| `DATABASE_URL` | Neon PostgreSQL connection string |
| `AMO_DOMAIN` | Домен amoCRM (flatcherestate.amocrm.ru) |
| `AMO_TOKEN` | JWT токен amoCRM API v4 |
| `GEMINI_API_KEY` | Google Gemini API ключ |
| `HTTPS_PROXY` | Прокси для скачивания записей с comagic.ru (российский сервер, заблокирован с Vercel US) |

## Архитектура

```
api/webhook.js       ← главный обработчик всех Telegram updates
lib/telegram.js      ← обёртки Telegram Bot API
lib/storage.js       ← все запросы к PostgreSQL (Neon)
lib/amo.js           ← amoCRM API v4 (записи звонков, контакты, заметки)
lib/transcribe.js    ← Gemini AI: транскрипция + оценка лида
```

## База данных (Neon PostgreSQL)

Таблицы создаются автоматически при первом запросе через `initTables()`:

- **users** — зарегистрированные менеджеры (chat_id, name, state, вспомогательные поля для state machine)
- **shifts** — активные смены (chat_id, start_time, start_ts, qual_leads, lead_requests)
- **shift_log** — завершённые смены (история для статистики)
- **planned_shifts** — запланированные выходы на смену
- **call_analyses** — результаты AI-анализа звонков (transcription JSONB, score JSONB)

## Флоу менеджера

1. `/start` → вводит имя → регистрация
2. Главное меню: **Выйти на смену** / **Статистика** / **Поддержка**
3. На смене: **Квал лид** / **Партия заявок** / **Закончить смену**
4. При нажатии "Квал лид" → бот просит ссылку на лид из CRM
5. Менеджер вставляет ссылку вида `https://flatcherestate.amocrm.ru/leads/detail/12345`
6. Бот засчитывает квал лид и запускает `analyzeLeadCall` в фоне

## Флоу AI-анализа звонка (analyzeLeadCall)

```
CRM ссылка
  → getRecordingUrlFromLink() — ищет запись в notes лида и его контактов
  → downloadMp3() — скачивает MP3 через российский прокси (comagic.ru заблокирован с US серверов)
  → getLeadContactInfo() — берёт ФИО и телефон клиента из контакта лида в AMO
  → analyzeBuffer() — отправляет аудио в Gemini, получает JSON {transcription, score}
  → formatTgReply() — форматирует сообщение для Telegram (HTML + <pre> блок)
  → notifyAdmin() — шлёт результат как ответ на сообщение о квал лиде (reply)
  → formatNotePlain() + addNoteToLead() — дублирует суммарайз в примечание карточки в amoCRM
```

## Формат AI-ответа (lib/transcribe.js)

Gemini возвращает JSON:
```json
{
  "transcription": {
    "duration_seconds": 180,
    "manager_name": "Татьяна",
    "client_name": "Елена",
    "client_full_name": "Иванова Елена Петровна",
    "client_phone": "+7 999 123-45-67",
    "summary": "суммарайз абзацами..."
  },
  "score": {
    "score": 68,
    "factors": "факторы соответствия...",
    "limiting_factors": "ограничивающие факторы..."
  }
}
```

Промпт (в `COMBINED_PROMPT`) задаёт порядок суммарайза: цель → формат/площадь → локация → бюджет → срочность → что смотрел → контакт. Оценка 5–95%, шкала в промпте.

Модель: `gemini-3.1-flash-lite-preview`, fallback: `gemini-2.5-flash` → `gemini-2.0-flash-lite`.

## Формат сообщения admin в Telegram

```
⭐⭐⭐ КВАЛ ЛИД
От сотрудника: Татьяна
🔗 Ссылка на лида
🕐 03.05.2026, 14:23 (МСК)
📊 Всего за смену: 3

  ↳ (reply) 🎙
     Суммарайз лида: Иванова Елена Петровна
     📞 +7 999 123-45-67  🕐 4:32

     <pre>При заходе сказать, что звонил(а) ваш личный ассистент Татьяна, передал(а), что:

     [суммарайз текстом]</pre>

     ─────────────────

     Оценка привлекательности лида для брокера: 68%
     Факторы соответствия: ...
     Ограничивающие факторы: ...
```

## Скачивание записей звонков

Записи хранятся на `media.comagic.ru` — российский CDN, недоступен с Vercel US. Решение: российский прокси через `HTTPS_PROXY`. Код использует `node-fetch@2` + `https-proxy-agent@5` (CommonJS совместимые).

`node-fetch` нужен потому что нативный `fetch` Node 18 не поддерживает опцию `agent` — прокси игнорируется.

## amoCRM API

- Домен: значение `AMO_DOMAIN` целиком (`flatcherestate.amocrm.ru`), URL строится как `https://${domain}/api/v4/...`
- Записи звонков ищутся в notes лида (note_type: `call_in` / `call_out`), поля `params.link` или `params.record_url`
- Если в notes лида нет — ищет в notes контактов лида
- Контакт: `GET /api/v4/leads/{id}?with=contacts` → `GET /api/v4/contacts/{id}` → поле `custom_fields_values` с `field_code: "PHONE"`
- Заметка в карточку: `POST /api/v4/leads/{id}/notes` с `note_type: "common"`

## Права доступа

- Любой может написать боту → попадает в state machine регистрации
- `ADMIN_CHAT_ID` — особые права: меню управления, статистика всех менеджеров, удаление менеджеров, DM менеджерам
- Проверка через `isAdmin(chatId)` в `lib/telegram.js`

## Статистика

Администратор может запросить:
- **Сегодня** — смены за текущий день (МСК)
- **Неделя** — за последние 7 дней
- **Месяц** — за последние 30 дней
- **Детально** — все смены с временем начала/конца и показателями

Расчёт зарплаты: квал лид = 400₽, партия заявок = 600₽.

## State machine пользователя

Поле `state` в таблице `users`:
- `awaiting_name` — новый пользователь, ждёт имя
- `authorized` — авторизован, использует кнопки меню
- `awaiting_qual_link` — ждёт ссылку на лид из CRM
- `awaiting_support_*` — флоу поддержки
- `awaiting_dm_*` — флоу DM менеджеру (только admin)
- `awaiting_plan_*` — флоу планирования смены
