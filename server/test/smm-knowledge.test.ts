import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { smmAccounts, smmPlatformPosts, smmPosts, smmZones } from '../src/db/schema-smm.js';
import { DEFAULT_STUDIO_ZONES, seedDatabase } from '../src/db/seed.js';
import { chatJson } from '../src/smm/ai.js';
import { brandFacts, brandTitle, marketingContext, studioDate, studioToIso } from '../src/smm/context.js';
import { remember } from '../src/smm/db.js';
import { describeZone, zoneRefs } from '../src/smm/interior.js';
import {
  addZone,
  addZonePhoto,
  claimDoc,
  getDoc,
  knowledgeText,
  listZones,
  removeZone,
  saveAiText,
  saveOwnerText,
  setZoneProgress,
  similarPastPosts,
  updateZone,
  zoneDescription,
  zoneOr404,
  zonesText,
} from '../src/smm/knowledge.js';
import { systemPrompt, todayLine, whenLine } from '../src/smm/prompts.js';
import { composePortrait } from '../src/smm/study.js';
import { step, type SmmProfile } from '../src/smm/types.js';
import { createTestApp, make, type TestApp } from './helpers.js';

// Сеть нейросетей не трогаем: chatJson отдаёт заготовленный ответ, а мы смотрим, что ушло в промпт.
vi.mock('../src/smm/ai.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/smm/ai.js')>();
  return { ...actual, chatJson: vi.fn() };
});
const chatMock = vi.mocked(chatJson);

/** Среда, 28 октября 2026, 10:00 по Москве. */
const NOW = Date.parse('2026-10-28T07:00:00.000Z');

/** Данные студии, которых не должно быть нигде в профиле автора. */
const STUDIO_MARKERS = ['MIKAN', 'Хеликс Звезда', 'Лабрет Комета', 'Админ', 'ул. Тестовая', 'Секретная студия', 'Варвара', '+7999', 'Студийное правило', 'Портрет студии-секрет', 'Студийный пост'];

const expectNoStudio = (text: string) => {
  for (const marker of STUDIO_MARKERS) expect(text, `«${marker}» просочилось к автору`).not.toContain(marker);
};

function addAccount(t: TestApp, profile: SmmProfile, handle: string): string {
  const id = randomUUID();
  t.ctx.db
    .insert(smmAccounts)
    .values({ id, profile, platform: 'telegram', title: handle, handle, createdAt: NOW, updatedAt: NOW })
    .run();
  return id;
}

function addPlatformPost(t: TestApp, accountId: string, caption: string, daysAgo: number, format = 'post'): void {
  t.ctx.db
    .insert(smmPlatformPosts)
    .values({ accountId, extId: randomUUID(), platform: 'telegram', format, publishedAt: NOW - daysAgo * 86_400_000, caption, views: 100 + daysAgo, statsAt: NOW })
    .run();
}

describe('SMM knowledge: studio facts and the author profile', () => {
  let t: TestApp;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    chatMock.mockReset();
    t = await createTestApp({ env: { PUBLIC_URL: 'https://mikan.test' } });
    await t.api('PUT', '/api/settings/studio', { address: 'ул. Тестовая, 7', about: 'Секретная студия про стерильность', phone: '+79990009999' });
    const helix = await make(t, '/api/services', { name: 'Хеликс Звезда', category: 'piercing', group: 'Ухо', price: 1600, durationMin: 30 });
    await make(t, '/api/services', { name: 'Тату мини', category: 'tattoo', price: 5000, priceFrom: true, durationMin: 120 });
    await make(t, '/api/products', {
      kind: 'jewelry', name: 'Лабрет Комета', category: 'Лабреты', material: 'Титан ASTM F136', price: 1500,
      variants: [{ name: '6 мм', initialQuantity: 3 }],
    });
    const client = await make(t, '/api/clients', { name: 'Клиентка Варвара', phone: '+79990001122' });
    // Четверг, 29 октября, 12:00–12:30 по Москве.
    await make(t, '/api/appointments', { clientId: client.id, masterId: 1, serviceId: helix.id, startsAt: '2026-10-29T09:00:00Z' });
    t.ctx.db
      .insert(smmPosts)
      .values({ id: randomUUID(), profile: 'studio', platform: 'telegram', status: 'published', topic: 'Студийный пост о проколах', publishedAt: NOW - 86_400_000, createdAt: NOW, updatedAt: NOW })
      .run();
    await remember(t.ctx, 'studio', { kind: 'rule', text: 'Студийное правило: на «вы»', source: 'staff' });
    await saveOwnerText(t.ctx, 'studio', 'brand', 'Портрет студии-секрет');
  });

  afterEach(async () => {
    await t.close();
    vi.useRealTimers();
  });

  it('gives the studio its services, jewelry, masters, free windows and quiet days', async () => {
    const facts = await brandFacts(t.ctx, 'studio');
    expect(facts).toContain('Студия: MIKAN STUDIO, адрес: ул. Тестовая, 7');
    expect(facts).toMatch(/Пирсинг · Ухо: Хеликс Звезда — 1\s600 ₽ \(~30 мин\)/);
    expect(facts).toMatch(/Тату: Тату мини — от 5\s000 ₽ \(~2 ч\)/);
    expect(facts).toContain('Мастера студии (только имена; стиль и опыт — из портрета студии): Админ.');
    expect(facts).toContain('виды — Лабреты; материалы — Титан ASTM F136; цены — от 1 500 ₽');
    expect(facts).toContain('Новые поступления украшений (за 21 дней, есть в наличии): Лабрет Комета, Титан ASTM F136.');
    expect(facts).toContain('Свободные окна для записи на 7 дн. вперёд');
    // Сегодня — с 11:00 (за час до начала), завтра — до и после записи 12:00–12:30.
    expect(facts).toContain('- Админ: ср 28.10 11:00–21:00; чт 29.10 11:00–12:00, 12:30–21:00;');
    expect(facts).toMatch(/Тихие дни \(мало записей\) в ближайшие 14 дн\.: чт 29\.10 \(загрузка ~5%\), пт 30\.10 \(загрузка ~0%\)/);
    expect(facts).toContain('Памятки студии по уходу');
    expect(facts).toContain('База знаний студии');
    // Ни имён, ни телефонов клиентов.
    expect(facts).not.toContain('Варвара');
    expect(facts).not.toContain('+79990001122');
  });

  it('keeps every studio datum out of the author context, prompts, knowledge and portrait', async () => {
    const author: SmmProfile = 'author';
    expect(await brandTitle(t.ctx, author)).toBe('Амина');
    const facts = await brandFacts(t.ctx, author);
    expect(facts).toContain('Автор блога: Амина. Это личный блог');
    expectNoStudio(facts);
    expect(facts).not.toMatch(/\d{2}:\d{2}/);

    const marketing = await marketingContext(t.ctx, author);
    expect(marketing.settings.brandName).toBe('Амина');
    expect(marketing.text).toContain('Голос автора');
    expectNoStudio(marketing.text);
    const studioMarketing = await marketingContext(t.ctx, 'studio');
    expect(studioMarketing.text).toContain('Студийный пост о проколах');
    expect(studioMarketing.text).toContain('Студийное правило');

    const knowledge = await knowledgeText(t.ctx, author, { craft: 'full', zones: await listZones(t.ctx, author) });
    expect(knowledge).toContain('Справка по тату и пирсингу (фон');
    expectNoStudio(knowledge);
    expect(await knowledgeText(t.ctx, 'studio', { craft: 'brief' })).toContain('От владельца (главное, соблюдай):\nПортрет студии-секрет');

    expectNoStudio(systemPrompt(author, 'Амина'));
    expect(await listZones(t.ctx, author)).toEqual([]);

    // Портрет автора: без её слов и соцсетей — не из чего, со словами — ни капли студии в промпте.
    await expect(composePortrait(t.ctx, author)).rejects.toMatchObject({ status: 400 });
    expect((await getDoc(t.ctx, author, 'brand')).error).toContain('Расскажите о себе');
    await saveOwnerText(t.ctx, author, 'brand', 'Я Амина, рисую графику и люблю путешествия');
    chatMock.mockResolvedValueOnce({ text: 'Портрет автора' });
    await composePortrait(t.ctx, author);
    const [authorCall] = chatMock.mock.calls;
    expect(authorCall?.[1]).toBe('author');
    expect(String(authorCall?.[2].user)).toContain('Я Амина, рисую графику');
    expectNoStudio(`${authorCall?.[2].system}\n${String(authorCall?.[2].user)}`);
    expect((await getDoc(t.ctx, author, 'brand')).aiText).toBe('Портрет автора');

    // У студии в источниках — её прайс и украшения.
    chatMock.mockResolvedValueOnce({ text: 'Портрет студии' });
    await composePortrait(t.ctx, 'studio');
    const studioUser = String(chatMock.mock.calls[1]?.[2].user);
    expect(studioUser).toContain('Хеликс Звезда');
    expect(studioUser).toContain('Портрет студии-секрет');
  });

  it('finds similar past posts of the profile only, ranked by matched words then recency', async () => {
    const studio = addAccount(t, 'studio', 'mikan_studio');
    const author = addAccount(t, 'author', 'amina_blog');
    addPlatformPost(t, studio, 'Татуировка на предплечье: тонкие линии, заживление прошло спокойно, мастер доволен результатом.', 10);
    addPlatformPost(t, studio, 'Графика и дотворк: новая татуировка на плечо. Татуировки в графике стареют красиво, если беречь от солнца.', 30);
    addPlatformPost(t, studio, 'Привезли новые титановые украшения ASTM F136: лабреты, кольца и кликеры для хеликса и септума.', 2);
    addPlatformPost(t, studio, 'Сторис: татуировка в графике, процесс сеанса и перевод эскиза на кожу перед контуром работы.', 1, 'story');
    addPlatformPost(t, author, 'Моя личная татуировка в графике — история о том, как я выбирала эскиз и мастера для себя.', 1);

    const found = await similarPastPosts(t.ctx, 'studio', 'Татуировки в стиле графика');
    expect(found).toContain('Как студия уже писала на похожие темы');
    const lines = found.split('\n').slice(1);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('Графика и дотворк');
    expect(lines[0]).toMatch(/^- 2026-09-28 telegram, 👁 130:/);
    expect(lines[1]).toContain('Татуировка на предплечье');
    expect(found).not.toContain('Сторис');
    expect(found).not.toContain('Моя личная');

    const authorFound = await similarPastPosts(t.ctx, 'author', 'татуировка графика');
    expect(authorFound).toContain('Как уже писали в этом блоге');
    expect(authorFound).toContain('Моя личная татуировка');
    expect(authorFound).not.toContain('предплечье');
    expect(await similarPastPosts(t.ctx, 'studio', 'а и в')).toBe('');
  });

  it('keeps knowledge docs and zones separate per profile', async () => {
    expect((await getDoc(t.ctx, 'author', 'brand')).ownerText).toBe('');
    await saveOwnerText(t.ctx, 'author', 'brand', 'Пишу от себя');
    expect((await getDoc(t.ctx, 'studio', 'brand')).ownerText).toBe('Портрет студии-секрет');
    expect(await knowledgeText(t.ctx, 'author', { craft: 'brief' })).toContain('Портрет автора:\nОт автора (главное, соблюдай):\nПишу от себя');

    const progress = step('Собираю всю ленту Telegram и Instagram', 2, 10, 10);
    expect(await claimDoc(t.ctx, 'author', 'socials', progress)).toBe(true);
    expect(await claimDoc(t.ctx, 'author', 'socials', progress)).toBe(false);
    expect(await claimDoc(t.ctx, 'studio', 'socials', progress)).toBe(true);
    // Зависшая работа (старше 15 минут) — раздел можно занять снова.
    vi.setSystemTime(NOW + 16 * 60_000);
    expect(await claimDoc(t.ctx, 'author', 'socials', progress)).toBe(true);
    await saveAiText(t.ctx, 'author', 'socials', 'Памятка автора', { posts: 3 });
    const doc = await getDoc(t.ctx, 'author', 'socials');
    expect(doc).toMatchObject({ aiText: 'Памятка автора', meta: { posts: 3 }, progress: null, error: null });
    expect((await getDoc(t.ctx, 'studio', 'socials')).aiText).toBe('');

    const zoneId = await addZone(t.ctx, 'author', 'Моя мастерская');
    await updateZone(t.ctx, zoneId, { ownerText: 'Светлая комната с большим окном' });
    const zone = await zoneOr404(t.ctx, zoneId);
    expect(zone).toMatchObject({ profile: 'author', code: 'З1', title: 'Моя мастерская' });
    expect(zoneDescription(zone)).toBe('от автора: Светлая комната с большим окном');
    expect(zonesText([zone])).toMatch(/^Места съёмки автора/);
    expect((await listZones(t.ctx, 'studio')).map((z) => z.title)).toEqual(DEFAULT_STUDIO_ZONES);
    const studioZone = (await listZones(t.ctx, 'studio'))[2]!;
    await updateZone(t.ctx, studioZone.id, { ownerText: 'Белые стены, кушетка' });
    expect(zonesText(await listZones(t.ctx, 'studio'))).toBe(
      'Помещения студии — как они выглядят (код зоны ставь в "zone", только когда сцена по сюжету у нас в студии — тогда картинка будет в нашем настоящем помещении):\n' +
        'З3 Тату-кабинет: от владельца: Белые стены, кушетка',
    );
    await expect(zoneOr404(t.ctx, randomUUID())).rejects.toMatchObject({ status: 404 });
  });

  it('describes a zone from absolute photo links and gives absolute references', async () => {
    const zone = (await listZones(t.ctx, 'studio'))[0]!;
    await addZonePhoto(t.ctx, zone.id, '/uploads/smm-reception.jpg');
    chatMock.mockResolvedValueOnce({ description: 'Светлый ресепшен'.padEnd(90, '.'), angles: 'от входа', anchor: 'Bright reception desk with warm light'.padEnd(45, '.') });
    await describeZone(t.ctx, zone.id);
    const parts = chatMock.mock.calls[0]?.[2].user;
    expect(chatMock.mock.calls[0]?.[1]).toBe('studio');
    expect(parts).toContainEqual({ type: 'image_url', image_url: { url: 'https://mikan.test/uploads/smm-reception.jpg' } });
    const described = await zoneOr404(t.ctx, zone.id);
    expect(described.aiText).toContain('Удачные ракурсы: от входа');
    expect(described.progress).toBeNull();
    expect(zoneRefs(t.ctx, described)).toEqual(['https://mikan.test/uploads/smm-reception.jpg']);
    expect(zoneRefs(t.ctx, undefined)).toEqual([]);
  });

  it('does not report work cut off by a restart: a stale doc or zone progress reads as idle', async () => {
    const progress = step('Собираю всю ленту Telegram и Instagram', 2, 10, 10);
    expect(await claimDoc(t.ctx, 'studio', 'socials', progress)).toBe(true);
    const zone = (await listZones(t.ctx, 'studio'))[0]!;
    await setZoneProgress(t.ctx, zone.id, step('Смотрю фото', 2, 10, 5));
    expect((await getDoc(t.ctx, 'studio', 'socials')).progress).toMatchObject({ label: 'Собираю всю ленту Telegram и Instagram' });
    expect((await zoneOr404(t.ctx, zone.id)).progress).toMatchObject({ label: 'Смотрю фото' });

    // The zone is stale after 5 minutes of no progress, the doc after 15 (as their re-claims).
    vi.setSystemTime(NOW + 6 * 60_000);
    expect((await zoneOr404(t.ctx, zone.id)).progress).toBeNull();
    expect((await getDoc(t.ctx, 'studio', 'socials')).progress).not.toBeNull();
    vi.setSystemTime(NOW + 16 * 60_000);
    expect((await getDoc(t.ctx, 'studio', 'socials')).progress).toBeNull();
    // And it can be started again.
    expect(await claimDoc(t.ctx, 'studio', 'socials', progress)).toBe(true);
    expect((await getDoc(t.ctx, 'studio', 'socials')).progress).not.toBeNull();
  });

  it('seeds the default studio zones once and never for the author', async () => {
    expect((await listZones(t.ctx, 'studio')).map((z) => z.title)).toEqual(DEFAULT_STUDIO_ZONES);
    seedDatabase(t.ctx.db, t.ctx.config);
    expect(await listZones(t.ctx, 'studio')).toHaveLength(DEFAULT_STUDIO_ZONES.length);
    for (const z of await listZones(t.ctx, 'studio')) await removeZone(t.ctx, z.id);
    seedDatabase(t.ctx.db, t.ctx.config);
    expect(await listZones(t.ctx, 'studio')).toEqual([]);
    expect(t.ctx.db.select().from(smmZones).all().filter((z) => z.profile === 'author')).toEqual([]);
  });

  it('works in the studio timezone, not the server one', () => {
    expect(studioToIso(t.ctx, '2026-10-20', '19:00')).toBe('2026-10-20T16:00:00.000Z');
    expect(studioToIso(t.ctx, '2026-10-20', '9:30')).toBe('2026-10-20T06:30:00.000Z');
    expect(studioToIso(t.ctx, '2026-13-01', '19:00')).toBeNull();
    expect(studioToIso(t.ctx, '2026-10-20', '25:00')).toBeNull();
    expect(studioDate(t.ctx, Date.parse('2026-10-27T22:30:00.000Z'))).toBe('2026-10-28');
    expect(todayLine(t.ctx)).toBe('Сегодня 2026-10-28, среда (время местное, Europe/Moscow).');
    expect(whenLine(t.ctx, '2026-10-20T16:00:00.000Z')).toBe('Выходит 2026-10-20 (вторник) в 19:00 по местному времени.');
    expect(whenLine(t.ctx, null)).toBe('Дата выхода не назначена.');
  });
});
