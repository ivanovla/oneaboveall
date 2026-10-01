# oneaboveall.org: стратегия запуска на западную аудиторию, v1

Дата: 2026-10-01. Бюджет: $1 000 на первый месяц. Автор: launch-стратегия (черновик для обсуждения).

---

## 0. Краткий вывод

1. **Первая волна строится вокруг одной механики: битвы за трон в прямом эфире.** Никакого «посмотрите, какой интересный сайт». Стример и его чат пытаются занять центр, удержать его или отобрать у другого стримера, а ежедневный дедлайн 16:00 ET и «появление» нового чемпиона в 19:00 ET работают как готовые ивенты. Платим за 20–30-минутные сегменты у 8–10 микро-стримеров (50–300 зрителей одновременно) по $40–120, а не за одну крупную интеграцию.
2. **Главный хук, который при этом честен: «Перебили — вернём всё».** По коду каждая ставка списывается полностью, а при перебитии автоматически возвращается целиком (`apps/engine/src/engine/recordBid.ts`). Значит, участвовать безопасно, платит только победитель. На этом строим весь копирайт.
3. **Деньги компании в аукцион не идут.** Ставка, оплаченная из нашего бюджета, вернётся к нам же и при этом поднимет цену для реальных участников. Это классический shill bidding: репутационно токсично и юридически рискованно. Вместо этого: стартовое место занимает честный плейсхолдер (`The Void`), а стример платит своими деньгами или деньгами чата, если сам захочет. Подробно в разделе 3.3.
4. **Бюджет:** $660 на стримеров (seed + launch), $160 на повторные букинги и бонусы лучшим, $80 на короткие нарезки, $50 на инструменты и live-тесты оплаты, $50 резерв. Органика (X, Reddit, Show HN) стоит $0 и используется как усилитель: её цель — превращать клипы со стримов в трафик.
5. **До запуска обязательны 5 продуктовых доработок:** OG/Twitter-превью, атрибуция `?ref=` до оплаты Stripe, модерация фото (сейчас сырое фото публично отдаётся сразу после загрузки), страницы Terms/Privacy с возрастом 18+ и, главное, **экономика комиссий**. При шаге $1 и полном возврате перебитых ставок затяжная война ставок может уйти в минус из-за невозвратных комиссий Stripe. Решение: manual capture (холд вместо списания) или процентный минимальный шаг.
6. **Самая сильная доработка ради виральности: OBS-виджет** (browser source) с текущим чемпионом, ценой, лидером раунда и таймером до 16:00 ET. Плюс публичное имя текущего лидера раунда: сейчас наружу отдаётся только цена (`getCurrentRoundInfo` в `apps/engine/src/queries/publicScene.ts`), а без имени нет драмы.
7. **Критерий успеха первой волны:** не выручка, а доказательство, что механика цепляет. За неделю запуска нужно ≥10 уникальных реально платящих участников, ≥3 смены чемпиона, ≥1 чемпион, не связанный с нашими партнёрами, и хотя бы один раунд с ≥3 участниками. Если после seed-недели (5 стримов) нет ни одной реальной ставки, платные стримы останавливаем и чиним воронку.

---

## 1. Допущения (явно)

| # | Допущение | Почему важно |
|---|---|---|
| A1 | Публичный запуск около **вт 27.10.2026**, мягкий запуск (seed-стримы на живом сайте) с **19.10.2026** | Под это рассчитан план по неделям |
| A2 | Цель первой волны: шум и первые реальные ставки/чемпионы, проверка, что механика цепляет. **Не** выручка | Определяет KPI и критерии стоп/продолжаем |
| A3 | Бюджет $1 000 покрывает только внешние траты (креаторы, инструменты, тесты). Время фаундера на аутрич и контент не оплачивается | Аутрич 40–60 стримерам — это 10–15 часов ручной работы |
| A4 | Механика взята из кода на 2026-10-01 (см. раздел 1.1), а не из ранних спек. Описание с депозитом 10% и баном на 3 раунда **устарело** | Влияет на копирайт и хуки |
| A5 | Арт нового чемпиона готовит человек в 3-часовое окно после закрытия (`CHAMPION_PROCESSING_GAP_MS`, `apps/engine/src/domain/config.ts`). Это одновременно и шаг модерации | На этом строим формат «Reveal в 19:00 ET» и защиту от NSFW в эфире |
| A6 | Stripe-аккаунт испанский (autónomo), валюта списания USD (`STRIPE_CURRENCY = "usd"`, `apps/api/src/stripeClient.ts`) | Комиссии и конвертация, см. 3.4 |
| A7 | Все цифры по ставкам креаторов — рыночные ориентиры из открытых источников на 10.2026 либо мои оценки (помечены «оценка») | Реальные цены подтверждаются только переговорами |

### 1.1. Как продукт работает сейчас (сверено с кодом)

- **Стартовое место** создаётся админом через `createInitialReign` (`apps/engine/src/engine/bootstrap.ts`) по цене $10. Публичного эндпоинта «купить первое место за $10» нет. Первая публичная ставка — **от $11** (шаг $1, `MIN_INCREMENT_CENTS`, `apps/engine/src/domain/config.ts`).
- **Ставка = полное списание** через Stripe сразу (`apps/api/src/routes/placeBid.ts`). Если ставку перебили, вся сумма автоматически возвращается (`recordBid.ts`). Депозитов, банов и доплаты нет.
- **Лидер раунда не может сам поднять свою ставку**, пока его не перебьют (`prepareBid.ts`).
- **Закрытие** каждый день в 16:00 America/New_York (`dailyClose.ts`). Если победитель есть, он устанавливается чемпионом через 3 часа, около **19:00 ET**, и тогда же начинается новый раунд. Между 16:00 и 19:00 ставки не принимаются. Если раунд пустой, новый стартует сразу в 16:00.
- **Публично видно:** чемпион (имя, цена, с какого момента, ссылка), 8 последних чемпионов, лидерборд (время, траты, число правлений), текущая цена и время закрытия. **Не видно:** кто сейчас лидирует в раунде и лента ставок.
- **Имя** берётся из Google/Apple, но его можно сменить (`PATCH /auth/name`, `apps/api/src/routes/authMe.ts`). Это важно для стримеров: они захотят ник, а не паспортное имя.
- **Фото:** обязательное согласие есть (`apps/api/src/routes/photo.ts`), но `GET /photos/:userId` отдаёт загруженное фото публично и **без модерации**, сразу после загрузки. Хранится на локальном диске (в коде прямо сказано, что для продакшена это ненадёжно).
- **Нет:** Terms/Privacy/возрастного гейта (в `apps/web/src/pages/` только `index.astro`), OG-мета (`BaseLayout.astro`), аналитики и UTM/реферального трекинга (есть только счётчик просмотров), уведомлений «вас перебили».

---

## 2. Позиционирование и хук

### 2.1. Что это для западного зрителя

Интернет-артефакт и статусная игра, наследник The Million Dollar Homepage (2005, $1 за пиксель, суммарно $1 037 100 к январю 2006 — [Wikipedia](https://en.wikipedia.org/wiki/The_Million_Dollar_Homepage)) и приложения «I Am Rich». Это **не** инвестиция, не NFT, не крипта и не азартная игра. Покупается одна вещь: место в центре одной страницы и место в её истории.

Тон: тёмный, сдержанный, слегка ироничный по отношению к собственной бессмысленности. Сайт не продаёт, он «допускает». Копирайт короткий.

### 2.2. Варианты one-liner'ов (EN)

| # | One-liner | Где использовать |
|---|---|---|
| 1 | **One page. One crowd. One above all.** | Тайтл, OG, био в X |
| 2 | **There's one seat at the center of this page. It's for sale. Forever.** | Лендинг, Show HN |
| 3 | **The Million Dollar Homepage sold a million pixels. We're selling one seat.** | Reddit, X, пресса (ностальгия) |
| 4 | **Outbid the person in the center. Get outbid? You get every cent back.** | Стримы, DM стримерам (снимает страх) |
| 5 | **Bidding closes at 4 PM Eastern. Every day. The center doesn't stay empty.** | Ежедневный пост, OBS-оверлей |
| 6 | **It does nothing. It means everything. Starting at $11.** | TikTok-хук, ироничный тон |
| 7 | **No crypto. No NFT. Just a seat, a crowd, and a receipt.** | Ответы скептикам, FAQ |

Рекомендация: основной **#1**, для стримов **#4** (ключ к безопасному участию чата), для органики **#3**.

### 2.3. Слова, которых избегаем

`bet`, `wager`, `jackpot`, `odds`, `prize`, `win money`, `invest`, `own`, `profit`, `NFT`, `token`. Вместо них: `bid`, `claim`, `take the center`, `displace`, `defend`, `hold`.

---

## 3. Бюджет $1 000

### 3.1. Разбивка по статьям и этапам

| Статья | Pre-launch (1–18.10) | Seed (19–25.10) | Launch (26.10–1.11) | Sustain (2–8.11) | Итого | Обоснование |
|---|---|---|---|---|---|---|
| Инструменты (аналитика, short-link, шаблоны оверлеев) | $30 | | | | **$30** | Plausible/Umami или аналог. Без атрибуции платить стримерам бессмысленно |
| Live-тесты оплаты (собственные ставки с возвратом = невозвратные комиссии) | $20 | | | | **$20** | Прогнать реальные карты US/UK/EU, 3DS и возвраты до первого эфира |
| Seed-стримы: 5 × $40–60 | | $250 | | | **$250** | Дёшево проверить 3 формата и 2–3 ниши |
| Launch: «Throne War» (2 стримера × $100) | | | $200 | | **$200** | Флагманский ивент недели, источник клипов |
| Launch: 3 стрима × ~$70 | | | $210 | | **$210** | Поддерживать драму каждый день недели запуска |
| Повторные букинги лучших + бонусы за результат | | | | $160 | **$160** | Платим за доказанное, а не за обещанное |
| Короткие нарезки (фрилансер-клиппер или креатор Shorts/TikTok) | | | $40 | $40 | **$80** | Клипы со стримов — основной органический актив |
| Резерв | | | | | **$50** | Перенос эфира, неожиданно сильный стример, доп. тесты |
| **Итого** | $50 | $250 | $450 | $200 | **$1 000** | |

Органика (X, Reddit, Show HN, Product Hunt) стоит $0 деньгами, но 1–2 часа в день времени фаундера.

### 3.2. Почему так

- По рыночным ориентирам стримеры на 50–500 CCV стоят $50–300 в час ([StreamScheme](https://www.streamscheme.com/twitch-sponsorship-rate-card/), [Envisioner](https://envisioner.io/blog/streamer-sponsorship-pricing-guide-2026), [InfluencerFee](https://influencerfee.com/blog/twitch-sponsorship-rates/)). Встречается формула $0.50–2.50 за зрителя в час. **Оценка:** на сегмент 20–30 минут у стримера с 50–150 CCV реалистичны $40–100, особенно если формат весёлый и не требует чтения рекламного текста. Стримеры до ~100 CCV редко получают спонсорства, поэтому «первый спонсор» тоже аргумент.
- С $1 000 одна интеграция у стримера на 1 000+ CCV ($300–1 500 за выделенный стрим) — ставка «всё на одну карту». Для проверки гипотезы нам нужно **8–10 независимых попыток**, а не одна.
- 60–70% бюджета уходит в последние 2 недели, после того как seed покажет, какие ниши и форматы работают.

### 3.3. Тратить ли бюджет на ставки самих стримеров? Короткий ответ: нет

Логичная идея: «дадим стримеру $20, пусть чат поставит его в центр». Разберём, к чему это приводит.

- Деньги ставки приходят **нам же**. Если стример выиграет, мы заплатили себе. Если его перебьют, мы вернули себе и потеряли комиссию. Реальная цена для нас близка к нулю, но для рынка это ставка продавца в собственном аукционе (**shill bidding**). Она поднимает цену для реальных участников и создаёт видимость спроса. eBay это прямо запрещает. Регуляторы потребительского права в US/UK/EU считают это обманной практикой (FTC Act §5, UK DMCC Act 2024 / бывшие CPRs, директива ЕС о недобросовестной коммерческой практике). Это **моя оценка рисков, а не юридическое заключение**; перед любой подобной схемой нужен юрист.
- Если всплывёт (а при публичном лидерборде всплывёт), это убьёт главный актив проекта: веру в то, что «все эти люди реально платили».

Что делаем вместо этого (честно и бесплатно):

1. **Плейсхолдер-чемпион.** Bootstrap-место занимает явный объект `The Void` (или `Nobody`) по $10 с подписью «This seat has never been claimed». Первый реальный человек, кто заплатит $11, становится **First Champion**: это сильный повод для стрима и постов.
2. **Стримеру платим только за эфирное время.** Ставить или нет, он решает сам и за свои деньги. Если ставит, на эфире звучит: «They paid me for this segment; this bid is my own money».
3. **Метка «Sponsored creator»** (продуктовая доработка, S) у правлений креаторов, которым мы платили в том же месяце. Честно и заодно интригует.
4. Если всё же хочется «подарить место», то **только** через bootstrap-плейсхолдер до первой реальной ставки и с публичной меткой «Sponsored placement». В конкурентных раундах денег компании нет никогда.

### 3.4. Экономика комиссий: обязательно учесть до запуска

Stripe не возвращает комиссию при рефанде ([Stripe Support](https://support.stripe.com/questions/understanding-fees-for-refunded-payments)). Тарифы испанского аккаунта ([stripe.com/en-es/pricing](https://stripe.com/en-es/pricing), проверено 2026-10-01): EEA standard 1.5% + €0.25, UK 2.5% + €0.25, international 3.15% + €0.25, **+2% за конвертацию**, спор (чарджбэк) €20 + €20 за ручной ответ.

**Оценка** для американской карты в USD: ~5.15% + ~$0.29 на каждую ставку. Пример: 20 ставок с шагом $1 от $11 до $30, 19 перебиты и возвращены. Невозвратные комиссии ≈ 19 × $0.29 + 5.15% × (11+…+29 ≈ $380) ≈ **$25**, выручка $30 минус ~$1.8 комиссии. **Итого около +$3.** При «чатовой» войне по $1 легко уйти в минус. Не катастрофа для маркетинга, но:

- **Вариант A (рекомендую, M):** `capture_method: "manual"`. Ставка становится холдом, при перебитии холд отменяется, списание происходит только у победителя после 16:00 ET. Холд живёт до 7 дней, раунд ≤24 ч, так что укладываемся. Отмена неуловленного PaymentIntent комиссий не порождает ([Stripe Docs](https://docs.stripe.com/payments/place-a-hold-on-a-payment-method)). **Обязательно подтвердить у поддержки Stripe для вашего аккаунта.** Затронуты `apps/api/src/routes/placeBid.ts`, `apps/engine/src/engine/recordBid.ts` (refund → cancel), `apps/engine/src/engine/roundResolution.ts` (capture победителя), обработка `requires_capture` в `apps/api/src/routes/stripeWebhook.ts`. Риск: отказ capture у победителя потребует fallback к следующему (логика каскада ранее уже была в engine). Это и есть главная сложность.
- **Вариант B (S, сразу):** минимальный шаг = `max($1, 5% от текущей цены)` в `validateBidAmount` (`apps/engine/src/domain/bidValidation.ts`). Меньше микро-ставок, растёт ощущение «ставки растут».
- **Вариант C (S, вне кода):** подключить USD-счёт для выплат в Stripe, чтобы не платить 2% конвертации (проверить доступность для испанского аккаунта).

---

## 4. Профиль идеального стримера

### 4.1. Платформы

| Платформа | Роль | Плюсы | Минусы / риски |
|---|---|---|---|
| **Twitch** | Основная | Культура «чат решает», команды ботов (`!throne`), рейды, клипы. Branded Content toggle | Дорогие поиски вручную; запрет на «Risky Gambling Products» в брендированном контенте (нас не касается, но формулировки аккуратные) |
| **YouTube Live + Shorts** | Вторая | Клипы живут долго, Shorts дают вторую жизнь стриму | Мелкие лайв-каналы плохо находятся; Shorts-интеграции $200–1 500 у 10–100k ([InfluencerFee](https://influencerfee.com/post.php?slug=youtube-shorts-vs-tiktok-pricing)), это дорого |
| **Kick** | Тест 1–2 стрима | Дешевле Twitch на 20–30% ([Envisioner](https://envisioner.io/blog/kick-streamer-marketing-guide)) | Сильная ассоциация с казино-стримами, а нам нельзя выглядеть как gambling. Берём только non-gambling каналы |
| **TikTok** (LIVE и нарезки) | Клипы, не основной | Привычка к LIVE-«battles» почти совпадает с нашей механикой | Политика Branded Content запрещает gambling и «get rich quick» ([TikTok BC Policy](https://www.tiktok.com/legal/page/global/bc-policy/en)), нас могут ошибочно туда отнести. Нужен toggle «Disclose commercial content». Платные посты 10–50k: $200–1 000 ([Napplo](https://napplo.com/guides/tiktok-sponsored-post-rates)), это дорого для нас |

### 4.2. Ниши (по приоритету)

1. **Just Chatting / internet culture / react-стримеры**: обсуждают странные сайты и интернет-историю, а Million Dollar Homepage для них знакомая тема.
2. **Art-стримеры** (Art, Makers & Crafting): рисуют нового чемпиона или пародию на сцену, реагируют на reveal в 19:00 ET. Эстетически совпадают с продуктом.
3. **Комьюнити с соревновательной культурой**: каналы, участвовавшие в r/place, стримеры с «чат против чата», стримеры с регулярными sub-goal/челленджами.
4. **VTuber'ы** (английские, малые): очень лояльные чаты, культура «поддержать своего». *Нужно продуктовое решение: можно ли в центр персонажа-аватар вместо фото лица? Это бы открыло большую нишу.*
5. **EU-англоязычные вечерние стримеры** (UK, NL, Nordics): 16:00 ET = 21:00–22:00 в Европе, прайм-тайм. Для них «финальный отсчёт» происходит в эфире.

**Исключаем:** каналы с детской аудиторией (Minecraft/Roblox/Fortnite для подростков: дети с картами родителей дают чарджбэки и регуляторные риски), казино/слоты/кейсы, drama/hate-контент, стримеров с недавними банами.

### 4.3. Размер

- **Основной диапазон: 50–300 avg CCV** (ставка $40–100 за сегмент, оценка).
- **1–2 «якоря»: 300–800 CCV** на Throne War ($100–150, оценка, если договоримся ниже рейт-карты за счёт формата).
- Ниже 30 CCV не берём: шума не будет даже при идеальной конверсии.

### 4.4. Как найти (конкретно)

| Инструмент | Что делать |
|---|---|
| [SullyGnome Channel Search](https://sullygnome.com/channelsearch) | Фильтр: language = English, avg viewers 50–300, игра/категория = Just Chatting / Art / VTuber-категории. Смотреть историю за 30 дней, стабильность расписания |
| [TwitchTracker](https://twitchtracker.com) | Время стримов: нужны эфиры, пересекающие 15:00–16:00 ET (отсчёт) или 19:00–21:00 ET (reveal) |
| [Streams Charts](https://streamscharts.com/overview) | Фильтры по языку и категориям, отдельно Kick-каналы |
| Twitch directory | Категория + теги `English`, `VTuber`, `Art`, сортировка «Viewers (low to high)», листать до диапазона 50–300 |
| Social Blade | Проверка YouTube/TikTok-аккаунтов стримера (есть ли каналы нарезок) |
| Discord-серверы стримеров | Оценка активности комьюнити: живой Discord = готовность к «войнам» |

Цель: длинный список из 60 каналов, шорт-лист из 25, 40 DM, около 10 букингов (**оценка конверсии:** 20–30% ответов, половина из них соглашается).

### 4.5. Критерии отбора (скоринг 0–2 по каждому, берём ≥8 из 12)

1. Активность чата: на глаз ≥10–15% зрителей пишут; бурные реакции на голосования и predictions.
2. Расписание пересекается с 16:00 ET или 19:00 ET.
3. Аудитория скорее 18+ (тематика, язык, отсутствие школьного контента).
4. Опыт комьюнити-ивентов: sub goals, charity, r/place, «чат решает».
5. Есть Discord и/или канал клипов (TikTok/Shorts), чтобы контент жил после стрима.
6. Нет недавних скандалов и гемблинг-спонсоров; был хотя бы 1 спонсор либо стример открыт к первому.

### 4.6. Модель оплаты

- Фикс **$40–120** за сегмент 20–30 минут + ссылка в панели и команда бота на 7 дней.
- **Бонус** (из статьи «Sustain») $25–50, если по реф-ссылке пришло ≥N платящих участников (N фиксируем заранее, например 3). Бонус за число *людей*, а не за сумму ставок, чтобы не стимулировать давление на чат.
- Оплата 100% в течение 48 ч после эфира (PayPal/Wise). Для первого спонсорства небольшой предоплаты обычно не требуют; если просят, 50% вперёд (оценка практики).
- **Не платим** процент от ставок чата: это напрямую стимулирует выжимать деньги из зрителей.

---

## 5. Форматы интеграций на механике продукта

| # | Формат | Механика | Лучшее время | Почему работает |
|---|---|---|---|---|
| F1 | **"Put Chat on the Throne"** | Стример открывает сайт, рассказывает про текущего чемпиона, чат решает, стоит ли его скинуть. Ставит стример из своих денег (или из донатов, собранных с прозрачной целью «на трон»). Чат голосует за фото и `character request` (`PATCH /auth/character-request`) | Любое, лучше до 16:00 ET | Чат — соавтор. Перебили? Деньги вернутся, так что риск низкий |
| F2 | **"Throne War"** (флагман) | Два стримера в одном раунде, в эфире одновременно или с рейдом друг к другу. Кто лидирует в 16:00 ET, тот забирает центр, проигравшему всё возвращается | Чт 29.10, 15:00–16:00 ET | Драма, клипы финальных секунд, перекрёстный трафик. **Нужно публичное имя лидера раунда** |
| F3 | **"4 PM Countdown"** | Регулярная рубрика: последние 15–30 минут перед закрытием на экране таймер и цена. Идеально для EU-вечерних стримеров | 15:30–16:00 ET (21:30–22:00 CET) | Ежедневный ритуал, низкая стоимость, можно делать с одним стримером несколько дней подряд |
| F4 | **"The Reveal"** | В 19:00 ET появляется новый чемпион. Стример (особенно художник) реагирует или рисует его | 19:00 ET (US prime time) | Второй ежедневный ивент; хорош для US-вечерних стримеров |
| F5 | **"Defend the Throne"** | Стример-чемпион в следующих эфирах следит за претендентами, чат решает, перебивать ли. Защита = новая ставка, старая цена уже уплачена | Дни после победы | Длинная история, лидерборд «кто дольше держал» |
| F6 | **Art-коллаб** | Художник рисует «свою версию» сцены с чемпионом дня. Клипы в TikTok/Shorts | Любое | Совпадение с эстетикой, кросс-постинг |

Ограничения на стримах (в брифе): никаких призывов «скиньтесь, кто сколько может» к неопределённой аудитории, всегда «18+, only if it's fun money». Донаты «на трон» допустимы, только если стример прямо говорит, на что идут деньги, и не обещает донатерам ничего ценного взамен (иначе это близко к лотерее/розыгрышу).

---

## 6. Готовые тексты (EN)

### 6.1. Первое сообщение стримеру (Twitch whisper / Discord / email)

**Subject:** Paid segment idea: put your chat on the throne

> Hey {Name}, caught your stream {day} ({one specific moment, e.g. "the chat vote on the cursed pizza"}). Quick pitch, and yes, it's paid.
>
> I built oneaboveall.org: one page, one painted crowd, one person standing in the center. That spot is a never-ending auction. Whoever's on top when bidding closes at 4 PM Eastern gets painted into the center with their link, and stays there until someone outbids them. Get outbid and you're refunded in full, automatically.
>
> I'd like to pay you ${fee} for a 20–30 minute segment: you and chat size up the current champion and decide whether to take the seat (or just roast the whole idea). No script, clearly marked as sponsored, and you never have to spend a cent yourself.
>
> Interested? I can send a one-page brief, and the dates are flexible between Oct 19 and Nov 6.
>
> {Your name}, maker of oneaboveall.org

### 6.2. Follow-up (через 4–5 дней, один раз)

> Hey {Name}, bumping this once, no worries if it's not your thing.
>
> We're booking a handful of streams for the week of Oct 26, including a head-to-head "Throne War" on Thursday Oct 29: two streamers, one seat, bidding closes live at 4 PM ET. ${fee} for about 30 minutes.
>
> Want the brief?

### 6.3. Бриф интеграции (одна страница)

> **oneaboveall.org: Creator Brief**
>
> **What it is:** One page, one painted crowd, one person in the center. The center seat is a permanent auction. Bidding closes every day at 4:00 PM Eastern; the new champion is painted in and revealed around 7:00 PM ET. Outbid bids are refunded in full automatically.
>
> **Your segment (20–30 min):**
> 1. Open oneaboveall.org on screen. Who's in the center? How long have they held it? What did they pay?
> 2. Let chat decide: do we take the seat? (Bidding is optional and always your own money.)
> 3. If you bid: let chat pick your photo vibe and your "character request" (how you want to be painted).
> 4. Close with the link and the 4 PM ET deadline.
>
> **Your link:** `oneaboveall.org/?ref={handle}`. Please add it to a panel and a chat command (`!throne`) for 7 days.
>
> **Must do:**
> - Turn on Twitch's **Branded Content** checkbox (YouTube: "includes paid promotion"; TikTok: "Disclose commercial content"; Kick: branded content disclosure).
> - Say it's sponsored at the start of the segment, and again if it runs past ~30 min. Keep a small on-screen "Sponsored by oneaboveall.org" label up during the segment.
> - Mention once: "You have to be 18+ to bid."
>
> **Please don't:**
> - Pressure viewers to spend or name specific amounts for chat to send.
> - Call it a bet, gamble, investment, or a way to make money. It isn't.
> - Upload anyone's face but your own (or someone who agreed on camera). No celebrities.
> - Promise donors anything in return for chipping in.
>
> **Payment:** ${fee}, paid within 48 hours of the stream via PayPal or Wise. Bonus ${bonus} if {N}+ people place a bid through your link within 7 days.
>
> **Contact:** {email / Discord}

### 6.4. Reddit: r/SideProject (перед постингом свериться с актуальными правилами сабреддита)

**Title:** I built a page where only one person can stand in the center, and the spot is a never-ending auction

> Hey r/SideProject. This is a weird one.
>
> oneaboveall.org is a single generated page: a crowd of people with one person in the middle. That middle spot is for sale through an auction that never ends. Bidding closes every day at 4 PM ET; whoever's on top gets painted into the center (with a link to their profile) and stays there until someone outbids them. If you're outbid, your bid is refunded in full.
>
> It's a spiritual sequel to the Million Dollar Homepage: no crypto, no NFT, nothing to "own". Just a seat, a public history of everyone who held it, and a leaderboard for who held it longest.
>
> Stack: Astro static page, Fastify API, Postgres, Stripe. Every new champion is hand-painted into the scene within ~3 hours of close, which is also how photos get moderated.
>
> Brutal feedback welcome, especially on whether the "you get refunded if outbid" part is clear.

### 6.5. Show HN (вт 27.10, около 8–9 AM ET)

**Title:** Show HN: One Above All – a never-ending auction for the center of one web page

> One page, one crowd, one person in the center. The center is sold through a perpetual auction: bids close daily at 4 PM America/New_York, the leader gets installed as champion (their artwork is prepared in a 3-hour gap), and holds the seat until outbid. Outbid bids are refunded automatically, so only the winner ends up paying.
>
> Some details HN might find interesting: the close is a fixed wall-clock time, not "24h after start", so DST had to be handled explicitly; the page itself is statically built, and only the money-moving endpoints are live; bids are recorded only from Stripe webhooks, idempotently.
>
> Viewing doesn't need an account; bidding does (Google/Apple). Happy to answer anything.

(Правила Show HN: проект должен быть «playable», без просьб апвоутить и с присутствием автора в треде. [HN Show guidelines](https://news.ycombinator.com/showhn.html). **Не** постим в r/InternetIsBeautiful: там запрещены платные сервисы и сайты с регистрацией ([RankHog summary](https://rankhog.com/subreddits/internetisbeautiful)).)

### 6.6. X: пост запуска + ежедневный шаблон

**Launch:**
> One page. One crowd. One above all.
>
> There's a single seat at the center of oneaboveall.org. It's for sale, forever. Bidding closes every day at 4 PM ET. Outbid? Full refund.
>
> It has never been claimed. Starting bid: $11.

**Ежедневно в 19:00 ET (после reveal):**
> Day {N}. {Champion name} now stands above all, for ${price}.
> Previous champion held the seat for {duration}.
> Bidding closes tomorrow, 4 PM ET.

**Перед Throne War:**
> Thursday, 4 PM ET. @{streamerA} vs @{streamerB}. One seat.
> The loser gets refunded. The winner gets painted into history.
> (Both streams are sponsored by us. Every bid is their own money.)

---

## 7. Метрики и трекинг

### 7.1. Метрики

**North Star первой волны:** число уникальных реально платящих участников в неделю (не партнёров) + число раундов с ≥2 участниками.

| Уровень | Метрика | Источник |
|---|---|---|
| Охват | Посетители по `ref`/UTM, просмотры клипов | Аналитика + платформы |
| Интерес | Клик «Displace» / посетители | Событие в аналитике |
| Намерение | Вход Google/Apple / клик Displace | Событие + `users.createdAt` |
| Действие | Успешные ставки / входы; уникальные участники | Stripe metadata + таблица `bids` |
| Конкуренция | Ставок на раунд, участников на раунд, смен чемпиона в неделю | `bids`, `reigns` |
| Завершение | Загрузили фото / победители | `users.photoConsentAt` |
| Экономика | Невозвратные комиссии / выручку; чарджбэки | Stripe Dashboard |
| Креатор | Посетители, участники, стоимость одного участника ($ гонорара / участники) | `ref` |

### 7.2. Схема ссылок

- Стримерам: `https://oneaboveall.org/?ref={handle}&utm_source={twitch|youtube|kick|tiktok}&utm_medium=stream&utm_campaign=launch_oct26`
- Органика: `?utm_source=reddit&utm_medium=post&utm_campaign=sideproject_launch`, `?utm_source=hn&utm_medium=showhn`, `?utm_source=x&utm_medium=post`.
- Для эфира нужен короткий вариант (**доработка**): `oneaboveall.org/c/{handle}` с редиректом на полную ссылку. Можно сделать без кода через Traefik redirect middleware или short-link сервис.

### 7.3. Что нужно доработать в продукте

| # | Доработка | Зачем | Где в коде | Сложность | Приоритет |
|---|---|---|---|---|---|
| P0-1 | **OG/Twitter-мета + картинка-превью** с текущим чемпионом | Без превью ссылки в X/Reddit/Discord выглядят мёртвыми | `apps/web/src/layouts/BaseLayout.astro` (мета нет совсем); картинку можно генерировать при статической сборке | S (статика) / M (динамическое изображение) | До запуска |
| P0-2 | **Атрибуция**: сохранять `ref` + UTM при первом визите (localStorage/cookie), передавать в `POST /bids` → `metadata.ref` у PaymentIntent, писать first-touch в `users` | Иначе непонятно, какому стримеру платить бонус и кого перебукивать | `apps/web/src/components/BidFlow.tsx`, `apps/api/src/routes/placeBid.ts` (metadata уже есть, добавить поле), `apps/engine/src/db/schema.ts` (`users.firstRef`, миграция), OAuth callbacks (`authGoogle.ts`/`authApple.ts`) для first-touch при регистрации | M | До запуска |
| P0-3 | **Аналитика событий** (Plausible/Umami: pageview с UTM, `displace_click`, `signin`, `bid_success`) | Воронка | `AuctionFlow.tsx`, `BidFlow.tsx` | S | До запуска |
| P0-4 | **Модерация фото**: не отдавать сырое фото публично до одобрения; админ-флаг approve/reject; правило на случай отказа (место остаётся, вместо фото силуэт, просьба перезагрузить) | Сейчас `GET /photos/:userId` отдаёт любое загруженное фото без проверки, и это может всплыть в эфире | `apps/api/src/routes/photo.ts` (стр. 100–109), `users.photoApprovedAt` | S–M | До запуска |
| P0-5 | **Надёжное хранилище фото** (S3/R2/MinIO) | Сейчас локальный диск, фото теряются при редеплое | `apps/api/src/routes/photo.ts` | S–M | До запуска |
| P0-6 | **Terms, Privacy, Content Policy, Refund policy; чекбокс 18+** в BidFlow; понятный statement descriptor в Stripe (`ONEABOVEALL SEAT`) | Комплаенс, чарджбэки, требования Stripe | Новые страницы в `apps/web/src/pages/`, `BidFlow.tsx` | S | До запуска |
| P0-7 | **Экономика комиссий**: manual capture (вариант A) или процентный шаг (вариант B) | См. 3.4 | `placeBid.ts`, `recordBid.ts`, `roundResolution.ts`, `stripeWebhook.ts` / `bidValidation.ts` | A: M–L, B: S | B до запуска обязательно, A желательно |
| P1-1 | **Публичный текущий лидер раунда + лента ставок** («{name} bid $27 · 3 min ago») | Без этого нет драмы и Throne War | `getCurrentRoundInfo` в `apps/engine/src/queries/publicScene.ts` (лидер уже вычисляется через `getQueueLeader`, нужно join с `users.name`), `apps/api/src/routes/currentRound.ts`, `AuctionFlow.tsx` | S | До Throne War (29.10) |
| P1-2 | **OBS-виджет** `/widget` (прозрачный фон: чемпион, цена, лидер раунда, таймер до 16:00 ET) | Стример держит его на экране весь эфир, это бесплатная постоянная реклама | Новая статическая страница в `apps/web`, опрос `/current-round` (кэш уже есть) | S–M | До seed, если успеваем, иначе до launch |
| P1-3 | **Уведомление «You've been displaced»** (email) | Перебитый участник сейчас ничего не узнаёт, кроме возврата. А это главный триггер для повторной ставки | Email-системы нет, нужен Resend/Postmark и хук в `recordBid.ts` | M | Launch-неделя |
| P1-4 | **Метка «Sponsored creator»** у правления | Прозрачность (раздел 3.3) | `reigns` или `users` флаг, `publicScene.ts`, UI | S | До seed |
| P1-5 | **Лимит первой ставки для новых аккаунтов** (например, ≤$250 в первые 24 ч) + правила Stripe Radar | Защита от краденых карт и импульсных ставок; `MAX_BID_CENTS` сейчас $20 млн | `prepareBid.ts`, `config.ts` | S | До запуска |
| P2-1 | Аватар/VTuber-персонаж вместо фото | Открывает нишу VTuber'ов | Продуктовое и арт-решение | — | После первой волны |
| P2-2 | Групповой пул ставки («чат скидывается» внутри продукта) | Сильнейшая механика для стримов, но это сбор чужих денег: KYC, возвраты, правовые вопросы | — | L | Не в v1 |

---

## 8. Риски и комплаенс

### 8.1. Раскрытие рекламы

| Регион / платформа | Требование | Источник |
|---|---|---|
| US (FTC) | В лайве раскрытие повторяется периодически, голосом и визуально, чтобы его увидели зашедшие позже | [FTC Disclosures 101](https://www.ftc.gov/business-guidance/resources/disclosures-101-social-media-influencers) |
| UK (ASA/CMA) | «Ad»/«#ad» в начале, видно без «see more»; касается и лайвов | [ASA #InfluencingResponsibly](https://www.asa.org.uk/news/influencingresponsibly-make-clear-upfront-when-ads-are-ads.html) |
| Twitch | Чекбокс Branded Content в Stream Manager; за нераскрытие предупреждение, затем санкции | [Twitch Branded Content Guidelines](https://help.twitch.tv/s/article/branded-content-policy?language=en_US) (страница не загрузилась при проверке; пересказ по [Dot Esports](https://dotesports.com/streaming/news/new-twitch-branded-content-guidelines-explained)) |
| YouTube | Чекбокс «includes paid promotion», распространяется и на лайвы | [YouTube Help](https://support.google.com/youtube/answer/154235?hl=en-GB) |
| TikTok | Toggle «Disclose commercial content» | [TikTok BC Policy](https://www.tiktok.com/legal/page/global/bc-policy/en) |
| Наши посты | Если сами постим про оплаченный стрим, пишем это прямо (пример в 6.6) | — |

### 8.2. Азартные игры и побуждение к тратам

- **По сути это не азартная игра:** нет элемента случая, победитель определяется наибольшей ставкой, перебитым всё возвращается. Twitch запрещает в брендированном контенте «Risky Gambling Products, such as online slots or roulette», TikTok запрещает gambling и «get rich quick». Наш риск — **ошибочная классификация** модератором из-за слов «auction», «bid», «win». Защита: словарь из 2.3, отсутствие обещаний дохода, фраза «nothing to win but the seat».
- **Побуждение тратить:** не платим стримерам процент от ставок, запрещаем называть суммы для чата, требуем «18+» в эфире.
- **Донаты «на трон»:** допустимы, только если цель прозрачна и донатерам ничего не обещают взамен. Никаких «кто задонатит больше, того фото поставим» (это уже ближе к розыгрышу).

### 8.3. Возраст

Twitch разрешён с 13 лет, значит в чате будут несовершеннолетние. Минимум: Terms с 18+, чекбокс в BidFlow, фраза стримера в эфире, исключение «детских» ниш. Стоит учесть, что дети, платящие картами родителей, — главный источник «дружественных» чарджбэков.

### 8.4. Модерация фото в эфире

- Сырое фото сейчас **публично доступно** сразу после загрузки (`photo.ts`). Если стример откроет профиль или ссылку в эфире, а там NSFW или чужое лицо, это бан стримеру и репутационный удар нам. **P0-4 до первого seed-стрима.**
- Арт готовит человек за 3 часа: это наш модерационный шлюз. Нужен Content Policy (нет NSFW, хейта, символики, чужих лиц без согласия, знаменитостей, несовершеннолетних) и процедура отказа.
- Ссылка `socialUrl` в hover-карточке тоже публичная, проверяем её при подготовке арта (скам, NSFW, малварь).
- Стримерам: «открывайте reveal после 19:00 ET, когда арт готов; не открывайте сырые ссылки».

### 8.5. Чарджбэки и мошенничество

- Спор стоит €20 (+€20 за ручной ответ) ([Stripe ES pricing](https://stripe.com/en-es/pricing)). При импульсных ставках со стрима возможны «friendly fraud», краденые карты и родительские карты.
- Меры: чекбокс 18+ и Terms с явным «you're buying a display placement; non-refundable once you hold the seat», понятный descriptor, email-чек, 3DS, правила Radar, лимит первой ставки (P1-5). Хранить доказательства: согласие на фото с таймстемпом уже пишется (`photoConsentAt`), туда же добавить согласие с Terms.
- Порог тревоги: доля споров > 0.5% от транзакций → пауза платных стримов и разбор (у карточных сетей мониторинговые пороги около 0.9–1%, **оценка**; точные значения уточнить у Stripe).

### 8.6. Восприятие «платишь ни за что»

Не прячем это, а делаем частью идеи: «It does nothing. That's the point.» Отсылки к Million Dollar Homepage и «I Am Rich», публичная история и лидерборд как «музей». Строка «No crypto. No NFT.» снимает главный западный скепсис. Прозрачность по деньгам (refund при перебитии, метки «Sponsored») — главная защита от обвинений в скаме.

### 8.7. Прочее

- **Сдвиг часовых поясов:** UK переходит на зимнее время 25.10, US — 01.11.2026. Значит 16:00 ET = 21:00 BST / 22:00 CEST до 25.10; 20:00 GMT / 21:00 CET с 25.10 по 01.11; 21:00 GMT / 22:00 CET после 01.11. Предупредить EU-стримеров.
- **Нагрузка:** `/current-round` кэшируется (1.5 с), статическая страница выдержит; узкое место — ручная подготовка арта при частых сменах чемпиона.

---

## 9. План по неделям

### Неделя 1 (1–7.10): фундамент
- Продукт: P0-1, P0-3, P0-6, P0-7B (шаг), P1-5. Запустить P0-2, P0-4, P0-5.
- Решить: плейсхолдер `The Void`, возможность аватаров (P2-1, только решение).
- Маркетинг: длинный список из 60 каналов (SullyGnome/TwitchTracker/Streams Charts), скоринг, шорт-лист из 25. Аккаунт X: 3–5 «build in public» постов (тизер сцены, «there's one seat»).
- Бюджет: $30 инструменты.

### Неделя 2 (8–14.10): аутрич + тесты
- Продукт: закрыть P0-2/4/5, P1-1, P1-4; OBS-виджет (P1-2), если успеваем.
- Live-тесты оплаты разными картами, включая 3DS и возврат при перебитии ($20).
- Аутрич: 40 DM (6.1), через 4–5 дней follow-up (6.2). Цель: 5 seed-букингов на 19–24.10 и 2 стримера на Throne War 29.10.
- Бюджет: $20.

### Неделя 3 (15–25.10): мягкий запуск + seed
- 19.10: сайт live, в центре `The Void`.
- 5 seed-стримов по $40–60: минимум 2 ниши (Just Chatting + Art или VTuber) и 2 формата (F1 + F3/F4).
- После каждого стрима: посетители по ref, клики Displace, входы, ставки, вопросы в чате (что непонятно).
- Нарезки лучших моментов с разрешения стримера (это прописано в брифе).
- Бюджет: $250.

**Решение в конце недели 3:**

| Результат seed | Действие |
|---|---|
| ≥2 из 5 стримов дали ≥1 реальную ставку, есть раунд с ≥2 участниками | **Продолжаем:** launch по плану, перебукиваем лучшую нишу |
| Трафик есть (≥30 посетителей по ref на стрим), но 0 ставок | **Меняем:** чиним воронку (вход, оплата, ясность «refund if outbid»), сдвигаем Throne War на неделю, launch-деньги держим |
| < 50 посетителей суммарно и 0 ставок за 5 стримов | **Останавливаем платные стримы**, оставшиеся ~$700 замораживаем, проверяем хук органикой и клипами, пересматриваем позиционирование |

### Неделя 4 (26.10–1.11): публичный запуск
- **Вт 27.10:** Show HN (8–9 AM ET), пост в r/SideProject, launch-пост в X. Фаундер весь день в комментариях. Product Hunt опционально, только если есть готовые материалы; он слабо совпадает с аудиторией (оценка).
- **Ср 28.10:** стрим F1 ($70).
- **Чт 29.10:** **Throne War** ($200), финал в 16:00 ET, reveal в 19:00 ET, клипы в тот же вечер.
- **Пт 30.10:** стрим F3 EU-вечерний ($70).
- **Сб 31.10 (Halloween):** стрим F1/F6 с темой «Halloween throne», character request в костюме ($70).
- Клипы: $40 фрилансеру на 5–8 вертикальных нарезок.
- Ежедневный пост в X в 19:00 ET.
- Бюджет: $450.

**Решение в конце недели 4** (цели — гипотезы-оценки):

| Метрика | Продолжаем | Меняем | Останавливаем |
|---|---|---|---|
| Уникальные реально платящие участники за неделю | ≥10 | 3–9 | ≤2 |
| Смены чемпиона | ≥3 | 1–2 | 0 |
| Чемпион без связи с партнёрами | ≥1 | 0, но органика ставит | 0 и органика не ставит |
| Стоимость одного платящего участника | ≤$40 | $40–100 | >$100 |
| Споры/чарджбэки | 0 | 1 (разобрать) | ≥2 или признаки фрода |

### Неделя 5 (2–8.11): sustain
- Перебукать 2 лучших стримеров (по стоимости участника) на регулярную рубрику F3/F5, выплатить бонусы ($160).
- $40 на клипы.
- Если органика даёт ≥50% участников, дальше платить только за результат. Если <20%, продукт держится на спонсорстве, и это сигнал пересмотреть механику (P1-3 уведомления, групповые пулы, аватары) до новых трат.
- Подготовить v2 стратегии: какие ниши масштабировать, какие продуктовые фичи (P2) делать.

---

## 10. Источники (проверено 2026-10-01)

- Ставки Twitch-стримеров: [StreamScheme rate card](https://www.streamscheme.com/twitch-sponsorship-rate-card/), [Envisioner pricing guide 2026](https://envisioner.io/blog/streamer-sponsorship-pricing-guide-2026), [InfluencerFee Twitch rates](https://influencerfee.com/blog/twitch-sponsorship-rates/)
- Kick: [Envisioner Kick guide](https://envisioner.io/blog/kick-streamer-marketing-guide), [StreamPlacements](https://streamplacements.com/blog/kick-streaming-sponsorships-complete-guide)
- TikTok/Shorts: [Napplo TikTok rates](https://napplo.com/guides/tiktok-sponsored-post-rates), [InfluencerFee Shorts vs TikTok](https://influencerfee.com/post.php?slug=youtube-shorts-vs-tiktok-pricing)
- Политики: [Twitch Branded Content](https://help.twitch.tv/s/article/branded-content-policy?language=en_US), [Dot Esports summary](https://dotesports.com/streaming/news/new-twitch-branded-content-guidelines-explained), [Twitch gambling restrictions](https://safety.twitch.tv/s/article/Prohibiting-Unsafe-Slots-Roulette-and-Dice-Gambling-Sites?language=en_US), [TikTok BC Policy](https://www.tiktok.com/legal/page/global/bc-policy/en), [YouTube paid promotion](https://support.google.com/youtube/answer/154235?hl=en-GB)
- Регуляторы: [FTC Disclosures 101](https://www.ftc.gov/business-guidance/resources/disclosures-101-social-media-influencers), [ASA #InfluencingResponsibly](https://www.asa.org.uk/news/influencingresponsibly-make-clear-upfront-when-ads-are-ads.html)
- Stripe: [Pricing ES](https://stripe.com/en-es/pricing), [Fees on refunds](https://support.stripe.com/questions/understanding-fees-for-refunded-payments), [Place a hold](https://docs.stripe.com/payments/place-a-hold-on-a-payment-method)
- Органика: [HN Show guidelines](https://news.ycombinator.com/showhn.html), [r/InternetIsBeautiful rules summary](https://rankhog.com/subreddits/internetisbeautiful)
- Аналоги: [The Million Dollar Homepage (Wikipedia)](https://en.wikipedia.org/wiki/The_Million_Dollar_Homepage)
- Поиск стримеров: [SullyGnome](https://sullygnome.com/channelsearch), [Streams Charts](https://streamscharts.com/overview), [TwitchTracker](https://twitchtracker.com)

**Не проверено:** имена конкретных стримеров (намеренно не приводятся, список собирается через инструменты из 4.4); точная текущая формулировка политики Twitch (официальная страница не загрузилась); есть ли у TikTok LIVE отдельный toggle раскрытия; комиссии за отменённые холды для конкретного испанского аккаунта (подтвердить у Stripe).
