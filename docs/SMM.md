# СММ-маркетолог

ИИ-маркетолог ведёт Telegram-канал и Instagram: составляет план на месяц, пишет посты, рисует картинки и видео,
присылает на одобрение в Telegram и в приложение, сам публикует в канал и в Instagram (по официальному API),
передаёт человеку то, что выкладывается вручную, собирает цифры площадок, сравнивает прогноз с фактом, пишет
отчёты и учится на замечаниях. Логика и все возможности перенесены из СММ-модуля Titan HUB и заточены под тату и
пирсинг.

Исходник переноса (только чтение): `~/Projects/Developer/titan-hub`
- сервер: `apps/api/src/modules/smm/*.ts`, миграции `apps/api/src/migrations/sql/084_smm.sql`, `089_…`, `090_…`;
- приложение: `apps/mobile/src/app/(app)/manage/smm/*.tsx`, `apps/mobile/src/components/smm/*.tsx`,
  `apps/mobile/src/lib/smm-api.ts`, `apps/mobile/src/lib/smm-knowledge.ts`;
- шлюз: `infra/telegram-relay/worker.js`.

## Два профиля

| | `studio` | `author` |
|---|---|---|
| Что ведём | соцсети MIKAN STUDIO | личные соцсети автора — Амины |
| Данные студии (услуги, цены, мастера, записи, свободные окна, украшения на складе, адрес) | да, в контексте маркетолога | **нет** — отдельный контент, не связан с рабочими процессами MIKAN |
| Справка о тату и пирсинге (`craft.ts`) | да | да, как фон (кто она — пишет сама в портрете) |

У каждого профиля **всё своё**: площадки (свой Telegram-канал и свой Instagram), настройки (`smm_settings:<profile>`),
план месяца, публикации, память, отчёты, бюджет на нейросети и расходы, подключение Instagram API, фотоархив,
база знаний (`brand` — портрет, `socials` — что было в соцсетях), места съёмки (zones), свои даты. Общие — только
ключ Polza (`AI_API_KEY`) и Telegram-бот @mikan_robot (он админ обоих каналов и шлёт превью на одобрение).

Профиль автора по умолчанию выключен (`enabled: false`) — крон его не трогает, пока его не включат в настройках.

## Что поменялось по сравнению с Titan HUB

- Нет ролей и права «СММ»: любой вошедший сотрудник может всё. «Только владелец» в Titan → без ограничений.
  Уведомления «владельцу» → одобряющим профиля (`approverIds`, пусто — все сотрудники, связанные с ботом).
- Нет push-уведомлений: всё, что Titan шлёт push'ем, идёт в Telegram одобряющим/выкладывающему (их личные чаты с
  ботом: `bot_chats.employee_id`), а в приложении — бейдж «Ещё» и счётчики на главной СММ.
- Tai → «маркетолог» (в текстах интерфейса и промптах). В замечаниях `role: 'tai'` → `'ai'`.
- Клуб → студия/бренд: `clubTitle` → `brandTitle`, `club` (ключ базы знаний) → `brand`, `mafia.ts` → `craft.ts`,
  мафия/турниры/бар/кабинки → тату, пирсинг, украшения, уход, кабинеты студии.
- Время: не «МСК» жёстко, а часовой пояс студии (`studioTimezone(db)`, по умолчанию Europe/Moscow), через luxon.
- Хранилище: SQLite + drizzle (`server/src/db/schema-smm.ts`, миграция `drizzle/0014_smm.sql`), id — UUID строкой
  (`crypto.randomUUID()`), время — мс (`*_at` колонки), JSON — текст `*_json`. Наружу — ISO-строки (`toIso`).
  Полнотекстового поиска Postgres нет: поиск по архиву и прошлым постам — `LIKE` по словам + ранжирование в JS.
- Файлы: вместо MinIO — `data/uploads/smm-<uuid>.<ext>`, в базе и API относительный путь `/uploads/smm-…`
  (приложение делает полный адрес само, Telegram получает файл с диска, Meta — по публичной ссылке через шлюз).
- Внешний интернет из РФ (t.me, Instagram API, файлы для Meta) — через Cloudflare Worker MIKAN
  (`cloudflare/telegram-proxy/worker.js`, маршруты `/web/<SMM_RELAY_KEY>/<host><path>` и `/media/smm-<файл>`).
- Ошибки — формат MIKAN `{ error: { code, message } }`. `SmmError(message, status)` наследует `AppError`
  (400 validation_error, 402 payment_required, 404 not_found, 409 conflict, 502 upstream_error) — общий обработчик
  `app.ts` отдаёт её как есть; в маршрутах не нужен свой `fail()`.
- Журнал — `ctx.log.warn/error({ err: errorMessage(e) }, '…')`, не `console`.
- id сотрудников — целые числа (`assigneeId`, `approvedBy`, `publisherId`, `approverIds`, `authorId`).

## Правила переноса кода (сервер)

Модули лежат в `server/src/smm/<то же имя файла>.ts`, маршруты — `server/src/routes/smm.ts` и
`server/src/routes/smm-knowledge.ts`. Каждая экспортируемая функция Titan сохраняет **имя, порядок параметров и
асинхронность** (была `async` — остаётся `async`, даже если тело синхронное), кроме перечисленного ниже:

1. Первый параметр `db: Database` → `ctx: AppContext` (`server/src/context.ts`: `db`, `config`, `log`, `gateway`).
   Исключение — `settings.ts`: `getSmmSettings(db, profile)` и `saveSmmSettings(db, profile, patch)` синхронные и
   принимают `db` (`ctx.db`); `await` перед ними допустим.
2. Функции, у которых профиль не выводится из строки базы, получают **вторым** параметром `profile: SmmProfile`.
   Функции по id поста / медиа / плана / зоны и по объекту поста берут профиль из строки (`post.profile`) — у них
   параметра нет. Полный список — в таблице ниже; если функции в таблице нет, действует это правило.
3. `SmmEnv` (`{db, clubId}`) и `clubKey` исчезают — везде `ctx`.
4. Если вам нужна функция из файла другого агента, импортируйте её по сигнатуре из таблицы, даже если файла ещё
   нет. Не создавайте чужие файлы и не пишите заглушки в них. Ошибки typecheck про отсутствующие чужие модули
   ожидаемы до сборки; свои файлы доводите до чистоты.

### Сигнатуры

`P` = `profile: SmmProfile`. Все функции из Titan, не указанные здесь, переносятся по правилам 1–2.

**db.ts** (агент «Ядро»): `loadPost(ctx, id, allMedia?)`, `listPosts(ctx, { profile?, from?, to?, planId?, status? })`
(без `profile` — все профили), `updatePost(ctx, id, patch)`, `insertPost(ctx, p)` (`p.profile` обязателен),
`deletePost`, `setPostProgress`, `claimPost(ctx, id, busy)`, `insertMedia`, `updateMedia`, `unselectSlot`,
`pendingMedia(ctx)`, `loadMedia`, `deleteMedia`, `nextSort`, `deleteSlot`, `reorderSlots`, `loadPlan(ctx, P, month)`,
`loadPlanById(ctx, id)`, `ensurePlan(ctx, P, month)`, `updatePlan(ctx, id, patch)`, `claimPlan(ctx, id, busy)`,
`addComment(ctx, { postId?, planId?, authorId?: number|null, authorName?, role: 'staff'|'ai', text })`,
`listComments(ctx, by, limit?)`, `listMemory(ctx, P)`, `remember(ctx, P, m)`, `forget(ctx, id)`, `mapAccount(row)`,
`listAccounts(ctx, P): Promise<AccountRow[]>` (`AccountRow = SmmAccount & { tgChatId: string | null }`),
`publishChannel(ctx, P)`, `mapReport(row)`, `listReports(ctx, P, limit?)`. Даты в патчах и `New*` — ISO-строки,
как в Titan; перевод в мс — внутри db.ts.

**ai.ts** («Ядро»): `SMM_MODELS`, `smmApiKey(ctx)`, `recordSpend(ctx, P, kind, model, costRub, note?)`,
`monthSpend(ctx, P)`, `polzaBalance(ctx)`, `extractJson(text)`, `chatJson<T>(ctx, P, opts)`, `resultUrl(v)`,
`generateImage(ctx, P, opts)` (временная ссылка Polza), `startVideo(ctx, P, opts)`, `pollVideo(ctx, P, polzaId)`,
типы `ChatPart`, `VideoRequest`, `VideoState`. Polza — OpenAI-совместимый `${config.ai.baseUrl}/v1/chat/completions`,
`/v1/media`, `/v1/balance` (`baseUrl` по умолчанию `https://polza.ai/api`), ключ `config.ai.apiKey`.
Тесты подменяют сеть через `ctx.smmFetch?: typeof fetch`.

**files.ts** («Ядро», новый — замена imageStore): `saveSmmFile(ctx, data: Buffer, ext): Promise<string>` →
`/uploads/smm-<uuid>.<ext>`; `storeRemote(ctx, url, ext, maxBytes?): Promise<string>` — скачать (ссылки Polza
живут 7 дней) и сохранить; `smmFilePath(ctx, path): string | null` — файл на диске для Telegram;
`absoluteUrl(ctx, path)` — `PUBLIC_URL` + путь (референсы для Polza); `removeSmmFile(ctx, path)`.

**relay.ts** («Ядро»): `relayUrl(ctx, url)`, `webFetch(ctx, url, init?)`, `publicMediaUrl(ctx, path)` — ссылка на
наш файл для серверов Meta через Worker (`/media/smm-…`).

**forecast.ts** («Ядро»): `loadForecastModel(ctx, P)`, `forecastFor(model, post)`, `withForecast(ctx, posts)`,
`freezeForecast(ctx, postId)`.

**context.ts** («Знания»): `studioDate(ctx, ms?)` (YYYY-MM-DD по времени студии; замена `mskDate`),
`studioToIso(ctx, date, time)` (замена `mskToIso`), `brandTitle(ctx, P)` (= `settings.brandName`),
`brandFacts(ctx, P, days?)` (замена `clubFacts`; у автора — без данных студии), `marketingContext(ctx, P)`.

**prompts.ts** («Знания»): `todayLine(ctx)`, `systemPrompt(P, brandName)`, `whenLine(ctx, publishAt)`,
`HOOK_FORMULAS`, `directionsOf(settings): { key: string; title: string }[]` (направления профиля из
`settings.directions`, по строке; ключ — короткий латинский slug), плюс остальные константы Titan
(`PLATFORM_LABEL`, `FORMAT_LABEL` и т. п.) под теми же именами.

**craft.ts** («Знания», замена `mafia.ts`): `craftKnowledge(level: 'brief' | 'full'): string`.

**holidays.ts** («Знания»): `listOwnDates(ctx, P)`, `datesBetween(ctx, P, from, to)`, `datesText`, `mustCover`,
`mourningDays`; тип `ClubDate` → `BrandDate`.

**style.ts, slop-ru.ts** («Знания»): как в Titan.

**knowledge.ts** («Знания»): `KnowledgeKey = 'brand' | 'socials'`; `getDoc(ctx, P, key)`, `saveOwnerText(ctx, P, key, text)`,
`setDocProgress(ctx, P, key, progress, error?)`, `claimDoc(ctx, P, key, progress)`, `saveAiText(ctx, P, key, text, meta)`,
`listZones(ctx, P)`, `zoneOr404(ctx, id)`, `addZone(ctx, P, title)`, `updateZone(ctx, id, patch)`, `removeZone(ctx, id)`,
`addZonePhoto(ctx, zoneId, url)`, `removeZonePhoto(ctx, zoneId, photoId)`, `setZoneProgress(ctx, id, …)`,
`saveZoneAiText(ctx, id, text, anchor)`, `zoneDescription`, `usableZones`, `zonesText`, `zoneByCode`,
`similarPastPosts(ctx, P, text, limit?)`, `knowledgeText(ctx, P, opts)`. Тип `Zone` получает `profile`.

**interior.ts** («Знания»): `describeZone(ctx, zoneId)`, `describeZoneInBackground(ctx, zoneId)`, `zoneRefs(zone)`
(полные ссылки через `absoluteUrl`).

**study.ts** («Знания»): `collectHistory(ctx, P)`, `studySocials(ctx, P)`, `composePortrait(ctx, P)`,
`studyBrand(ctx, P)` (замена `studyClub`), `studyInBackground(ctx, P, what: 'socials' | 'brand')`.

**library.ts** («Генерация»): `photoUrl`, `cropUrl`, `folderIdFrom`, `libraryState(ctx, P)`, `syncLibrary(ctx, P)`,
`connectLibrary(ctx, P, link)`, `disconnectLibrary(ctx, P)`, `searchLibrary(ctx, P, text, opts?)`,
`libraryPhotos(ctx, P, ids)`, `libraryOfKind(ctx, P, kind, limit)`, `markUsed(ctx, P, ids)`, `libraryAlbums(ctx, P)`,
`albumPhotos(ctx, P, folderId)`, `libraryCounts(ctx, P)`, `archiveLine(photos)`,
`archiveCandidates(ctx, post /* с profile */, limit?)`, `describePending(ctx, limit?)` (все профили).

**media.ts** («Генерация»): `brandLogo(ctx, P)` (замена `clubLogo`), `generateImages(ctx, post /* id, format, profile */, jobs, range?)`,
`regenerateImage(ctx, postId, opts)`, `addArchivePhoto(ctx, postId, photoId, sort?)`, `pollVideos(ctx)`,
`addUpload(ctx, postId, data: Buffer, mime: string)` (фото и видео).

**video.ts** («Генерация»): `makePostVideo(ctx, postId, wish?)`, `makePostVideoInBackground(ctx, postId, wish?)`.

**writer.ts** («Генерация»): `Author = { id: number | null; name: string }`; `writePost(ctx, postId)`,
`writePostInBackground(ctx, postId, after?)`, `revisePost(ctx, postId, remark, author)`,
`reviseInBackground(ctx, postId, remark, author, after?, onError?)`, `suggestIdeas(ctx, P, opts)`.

**planner.ts** («Генерация»): `monthRange`, `isMonth`, `generatePlan(ctx, P, month, opts)`,
`generatePlanInBackground(ctx, P, month, opts, after?)`, `revisePlan(ctx, P, month, remark, author)`,
`revisePlanInBackground(ctx, P, month, remark, author)`.

**report.ts** («Генерация»): `generateReport(ctx, P, period?)`.

**telegram.ts** («Площадки»): `SmmPerson = { id: number; name: string; chatId: number | null }` (личный чат
сотрудника с ботом); `approvers(ctx, P)`, `personById(ctx, id)`, `publisherFor(ctx, P, settings, post)`,
`telegramHtml`, `plainText`, `whenText(ctx, iso)`, `checkChannel(ctx, input)`, `channelMembers(ctx, chatId)`,
`publishToChannel(ctx, post)`, `reviewButtons(postId)`, `sendReviewTo(ctx, post, chatId, intro?)`,
`sendHandoff(ctx, post, to, kind?)`, `awaitedLinkPost(ctx, chatId)`, `setAwaitedLink(ctx, chatId, postId|null)`,
`setAwaitedRemark(ctx, chatId, postId|null)`, `awaitedRemarkPost(ctx, chatId)`, `tell(ctx, chatId|null, html)`.

**tg-handlers.ts** («Площадки»): обработка кнопок `smm:…` и лички сотрудников, встроенная в бота MIKAN
(`server/src/bot/*`).

**instagram.ts** («Площадки»): всё по правилу 2 — `instagramState(ctx, P)`, `connectInstagram(ctx, P, token, userId)`,
`disconnectInstagram(ctx, P)`, `refreshInstagramToken(ctx, P)`, `igProfile(ctx, P)`, `igRecentMedia(ctx, P, limit?)`,
`igAllMedia(ctx, P, max?)`, `igStories(ctx, P)`, `igInsights(ctx, P, media)`, `igPeriod(ctx, P, days)`,
`igDaily(ctx, P, metric, days)`, `igAudience(ctx, P)`, `instagramCanPublish(ctx, post /* с profile */)`,
`publishToInstagram(ctx, post)`.

**stats.ts** («Площадки»): `parseCount`, `parseChannelPage`, `upsertPlatformPost(ctx, account, p)`, `igFormat`,
`collectStats(ctx, P, opts?)`, `accountHistory(ctx, P, days?)`.

**analytics.ts** («Процесс»): `accuracyOf(posts)`, `insightsText(ctx, P)`, `analyticsPayload(ctx, P)`.

**workflow.ts** («Процесс»): `Actor = { id: number | null; name: string }`; `canAutoPublish(ctx, post)`,
`withAuto(ctx, posts)`, `approvePost(ctx, postId, by)`, `skipPost(ctx, postId)`, `restorePost(ctx, postId)`,
`markPublished(ctx, postId, url)`, `publishNow(ctx, postId)`, `requestReview(ctx, post)`, `smmTick(ctx)` (крон раз в
минуту из `server/src/index.ts`, перебирает включённые профили).

## API

Все маршруты — под входом сотрудника, с префиксом **`/api/smm/:profile`** (`profile` = `studio` | `author`, иначе
404), и повторяют маршруты Titan (`smm.router.ts` + `knowledge.router.ts`) с теми же путями, телами и формами ответов.
Пример: Titan `POST /api/smm/posts/:id/approve` → MIKAN `POST /api/smm/author/posts/:id/approve`. Пост, план, медиа и
зона чужого профиля — 404. Плюс:

- `GET /api/smm/profiles` → `{ items: [{ profile, brandName, enabled, review, awaitingLink, failed }] }` — для
  переключателя профилей и бейджа (`review` — сколько ждут одобрения).
- `GET /api/smm/:profile/people` → `{ items: [{ id, name, telegram: boolean }] }` — сотрудники для выбора
  одобряющих и выкладывающего (`telegram` — есть личный чат с ботом).
- `GET /api/dashboard/badges` (существующий) получает поле `smmReview` (одобрения по включённым профилям); бейдж
  вкладки «Ещё» его учитывает.

Отличия ответов от Titan: id сотрудников — числа; `settings` — форма `server/src/smm/settings.ts` (добавлены
`enabled`, `brandName`, `directions`, `approverIds`; `publisherId` — число); ключ базы знаний `club` → `brand`;
замечания `role: 'ai'` вместо `'tai'`; `/meta` отдаёт `directions` профиля (из настроек). Загрузка файлов —
`multipart/form-data`, одно поле `file`; медиа поста — фото до 10 МБ и видео до 100 МБ (лимит маршрута).
Ошибки — `{ error: { code, message } }`.

## Telegram

- Бот @mikan_robot — администратор канала каждого профиля с правом публикации. Канал указывают на площадке
  профиля (`tgChatId`: `@username` или `-100…`); проверка — «Проверить» на площадке (`checkChannel`).
- Превью на одобрение с кнопками «Одобрить», «Поправить», «Не выкладывать», «Выложил» — в личные чаты одобряющих.
  Замечание текстом в ответ — маркетолог переписывает; ссылку на вышедший пост — отмечает опубликованным.
- `callback_data` — `smm:<действие>:<uuid поста>` (≤ 64 байт).

## Переменные окружения

`SMM_TEXT_MODEL`, `SMM_IMAGE_MODEL`, `SMM_VIDEO_MODEL`, `SMM_IMAGE_RESOLUTION` (1K | 2K | 4K) — модели Polza, по
умолчанию как в Titan; `SMM_RELAY_KEY` — секрет маршрута `/web/` шлюза (тот же — секрет `WEB_RELAY_KEY` Worker'а);
без него запросы к t.me и Instagram идут напрямую. `PUBLIC_URL` — нужен для ссылок на файлы.

## iOS

`ios/MIKAN/Features/More/Smm/…` (вход — «Ещё» → «Маркетинг» → «СММ-маркетолог»), модели
`ios/MIKAN/Core/Models/Smm*.swift`, запросы `ios/MIKAN/Core/Networking/Endpoints+Smm.swift`. Переключатель профиля
(«Студия» / «Амина») сверху главной СММ; все экраны работают в выбранном профиле. Проверка — только сборка
(`xcodebuild build-for-testing`, без симуляторов).
