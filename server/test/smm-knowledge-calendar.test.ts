import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { silentLogger, type AppContext } from '../src/context.js';
import { openDatabase } from '../src/db/client.js';
import { seedDatabase } from '../src/db/seed.js';
import { craftKnowledge, CRAFT_SECTIONS } from '../src/smm/craft.js';
import {
  addOwnDate,
  blackFriday,
  datesBetween,
  datesText,
  fridays13,
  listOwnDates,
  mourningDays,
  mustCover,
  orthodoxEaster,
  removeOwnDate,
} from '../src/smm/holidays.js';
import { directionsOf, HOOK_FORMULAS, SAFETY_RULES, systemPrompt } from '../src/smm/prompts.js';
import { DEFAULT_SMM_SETTINGS } from '../src/smm/settings.js';
import { humanize, lintText } from '../src/smm/style.js';
import { FakeGateway, noImageGenerator, testConfig } from './helpers.js';

function bareContext(): AppContext {
  const config = testConfig();
  const { db, sqlite } = openDatabase(':memory:');
  seedDatabase(db, config);
  return {
    db,
    sqlite,
    config,
    log: silentLogger,
    gateway: new FakeGateway(),
    ai: null,
    generateImage: noImageGenerator,
    qr: null,
    onBotSettingsChanged: () => undefined,
  };
}

describe('SMM calendar: holidays, tattoo culture dates and own dates per profile', () => {
  let ctx: AppContext;
  beforeEach(() => {
    ctx = bareContext();
  });
  afterEach(() => {
    ctx.sqlite.close();
  });

  it('computes floating dates: Friday the 13th, Black Friday, Orthodox Easter', () => {
    expect(fridays13(2026)).toEqual(['2026-02-13', '2026-03-13', '2026-11-13']);
    expect(fridays13(2027)).toEqual(['2027-08-13']);
    expect(blackFriday(2026)).toBe('2026-11-27');
    expect(blackFriday(2027)).toBe('2027-11-26');
    expect(orthodoxEaster(2026)).toBe('2026-04-12');
    expect(orthodoxEaster(2027)).toBe('2027-05-02');
  });

  it('puts the Friday 13th flash day and Black Friday into the studio November, and Easter week into spring', async () => {
    const november = await datesBetween(ctx, 'studio', '2026-11-01', '2026-11-30');
    const friday = november.find((d) => d.date === '2026-11-13');
    expect(friday).toMatchObject({ title: 'Пятница, 13-е', tone: 'fun', weight: 3 });
    expect(friday?.note).toContain('флеш-день');
    expect(november.find((d) => d.title === 'Чёрная пятница')).toMatchObject({ date: '2026-11-27', tone: 'sell' });
    expect(november.find((d) => d.title === 'Осень — сезон больших работ')).toMatchObject({ date: '2026-09-01', until: '2026-11-30' });
    expect(mustCover(november).map((d) => d.title)).toEqual(['Пятница, 13-е']);

    const spring = await datesBetween(ctx, 'studio', '2026-02-01', '2026-04-30');
    expect(spring.find((d) => d.title === 'Масленица')).toMatchObject({ date: '2026-02-16', until: '2026-02-22' });
    expect(spring.find((d) => d.title === 'Пасха')?.date).toBe('2026-04-12');
    expect(spring.find((d) => d.date === '2026-02-14')?.note).toContain('парные тату');
    expect(mustCover(spring).map((d) => d.date)).toEqual(['2026-02-13', '2026-02-14', '2026-02-23', '2026-03-08', '2026-03-13']);

    const june = await datesBetween(ctx, 'studio', '2026-06-01', '2026-06-30');
    expect(mourningDays(june)).toEqual(['2026-06-22']);
    expect(mustCover(june).some((d) => d.date === '2026-06-22')).toBe(false);
    expect(datesText(june)).toContain('- 2026-06-22: День памяти и скорби [траур, важность 2]');
  });

  it('gives the personal blog no studio sales occasions and its own weights', async () => {
    const november = await datesBetween(ctx, 'author', '2026-11-01', '2026-12-31');
    expect(november.some((d) => d.title === 'Чёрная пятница')).toBe(false);
    expect(november.some((d) => d.title === 'Новогодние подарки')).toBe(false);
    expect(november.some((d) => d.title === 'День народного единства')).toBe(false);
    expect(november.find((d) => d.date === '2026-11-13')).toMatchObject({ title: 'Пятница, 13-е', weight: 2 });
    expect(november.find((d) => d.date === '2026-12-31')?.note).toBe('итоги года автора, поздравление');
    const february = await datesBetween(ctx, 'author', '2026-02-01', '2026-02-28');
    expect(february.find((d) => d.date === '2026-02-14')).toMatchObject({ weight: 2, note: 'про любовь и парные тату — история или мнение, без продаж' });
  });

  it('keeps own dates per profile: yearly and one-off, in the plan as must-cover', async () => {
    const studioId = await addOwnDate(ctx, 'studio', { day: '11-20', title: 'День рождения студии', note: 'итоги года студии' });
    await addOwnDate(ctx, 'author', { day: '2026-11-21', title: 'Мой день рождения' });
    await addOwnDate(ctx, 'author', { day: '02-29', title: 'Високосная дата' });
    await expect(addOwnDate(ctx, 'author', { day: '02-30', title: 'Нет такой' })).rejects.toMatchObject({ status: 400 });
    await expect(addOwnDate(ctx, 'author', { day: '2026-02-29', title: 'Нет такой' })).rejects.toMatchObject({ status: 400 });

    expect((await listOwnDates(ctx, 'studio')).map((d) => d.title)).toEqual(['День рождения студии']);
    expect((await listOwnDates(ctx, 'author')).map((d) => d.title)).toEqual(['Високосная дата', 'Мой день рождения']);

    const studio = await datesBetween(ctx, 'studio', '2026-11-15', '2027-11-25');
    expect(studio.filter((d) => d.own).map((d) => d.date)).toEqual(['2026-11-20', '2027-11-20']);
    expect(studio.find((d) => d.own)).toMatchObject({ title: 'День рождения студии', weight: 3, note: 'итоги года студии', id: studioId });
    expect(mustCover(studio).some((d) => d.title === 'День рождения студии')).toBe(true);

    const author = await datesBetween(ctx, 'author', '2026-11-15', '2027-11-25');
    expect(author.filter((d) => d.own).map((d) => `${d.date} ${d.title}`)).toEqual(['2026-11-21 Мой день рождения']);
    expect(author.find((d) => d.own)?.note).toBe('своя дата автора');
    expect(author.some((d) => d.title === 'День рождения студии')).toBe(false);

    expect(await removeOwnDate(ctx, 'author', studioId)).toBe(false);
    expect(await removeOwnDate(ctx, 'studio', studioId)).toBe(true);
    expect(await listOwnDates(ctx, 'studio')).toEqual([]);
  });
});

describe('SMM prompts, directions, style and craft knowledge', () => {
  it('parses directions line by line into short stable latin keys', () => {
    const directions = directionsOf({
      directions: '- Тату: работы, стили\n• Пирсинг: проколы\n\n1. Уход и заживление: памятки\n  Тату — второе\nЁлка, хвоя',
    });
    expect(directions).toEqual([
      { key: 'tatu', title: 'Тату: работы, стили' },
      { key: 'pirsing', title: 'Пирсинг: проколы' },
      { key: 'uhod-i-zazhivlenie', title: 'Уход и заживление: памятки' },
      { key: 'tatu-2', title: 'Тату — второе' },
      { key: 'elka', title: 'Ёлка, хвоя' },
    ]);
    expect(directionsOf({ directions: '' })).toEqual([]);
    const studio = directionsOf(DEFAULT_SMM_SETTINGS.studio).map((d) => d.key);
    expect(studio).toEqual(['tatu', 'pirsing', 'ukrasheniya', 'bezopasnost', 'uhod-i-zazhivlenie', 'studiya-i-mastera']);
    expect(directionsOf(DEFAULT_SMM_SETTINGS.author).map((d) => d.key)).toEqual(['tvorchestvo', 'lichnoe', 'vdohnovenie']);
    for (const key of studio) expect(key).toMatch(/^[a-z0-9-]{1,24}$/);
  });

  it('builds a studio and a personal-blog role, both with the safety rules', () => {
    const studio = systemPrompt('studio', 'MIKAN STUDIO');
    expect(studio).toContain('тату- и пирсинг-студии «MIKAN STUDIO»');
    expect(studio).toContain('только из раздела «Факты о студии»');
    const author = systemPrompt('author', 'Амина');
    expect(author).toContain('личного блога «Амина»');
    expect(author).toContain('Это личный блог, отдельный от работы');
    expect(author).not.toContain('Факты о студии');
    for (const prompt of [studio, author]) {
      expect(prompt).toContain(SAFETY_RULES);
      expect(prompt).toContain('никаких сосков');
      expect(prompt).toContain('не упоминай Meta');
      expect(prompt).toContain('«совсем не больно»');
      expect(prompt).toContain('«лучшие в городе»');
      expect(prompt).toContain('Картинка нейросети никогда не выдаётся за работу мастера');
    }
    expect(HOOK_FORMULAS.split('\n')).toHaveLength(21);
  });

  it('flags medical promises, superlatives and Instagram or Meta in Telegram', () => {
    const tg = lintText('<b>Первая тату</b>\nСовсем не больно, заживёт за неделю. Мы лучшие в городе!', 'telegram', 'post');
    expect(tg.some((i) => i.startsWith('обещание «не больно»'))).toBe(true);
    expect(tg.some((i) => i.startsWith('обещание срока заживления'))).toBe(true);
    expect(tg.some((i) => i.startsWith('превосходная степень'))).toBe(true);
    const insta = 'Новые лабреты из титана уже на витрине. Все фото — в нашем инстаграме.';
    expect(lintText(insta, 'telegram', 'post')).toContain('в Telegram нельзя звать в Instagram и упоминать Meta — убери упоминание');
    expect(lintText(insta, 'instagram', 'post').some((i) => i.includes('Meta'))).toBe(false);
    expect(lintText('Сеанс занял 4 часа, мастер работал в перчатках, иглы вскрыли при клиенте.', 'telegram', 'post')).toEqual([]);
    expect(humanize('Тату — это навсегда…')).toBe('Тату - это навсегда...');
  });

  it('carries the tattoo and piercing reference, short for plans and full for posts', () => {
    const brief = craftKnowledge('brief');
    const full = craftKnowledge('full');
    expect(brief.length).toBeLessThan(full.length);
    for (const fact of ['ASTM F136', 'пистолет', 'Пятница, 13-е', 'флеш', 'хеликс']) expect(brief.toLowerCase()).toContain(fact.toLowerCase());
    for (const fact of ['Блэкворк', 'кавер-ап', 'Противокозелок', 'Септум', 'Микродермал', '16G', 'Автоклав', 'Гостевой спот', 'плёнка', 'Рёбра']) {
      expect(full.toLowerCase()).toContain(fact.toLowerCase());
    }
    expect(CRAFT_SECTIONS.map((s) => s.title)).toHaveLength(12);
    expect(CRAFT_SECTIONS.every((s) => full.includes(s.text))).toBe(true);
  });
});
