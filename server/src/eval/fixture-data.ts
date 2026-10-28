import type { ServiceVariant } from '../lib/serialize.js';
import type { ThreadType } from '../lib/jewelry.js';

/**
 * The made-up studio the AI quality check talks about. `server/eval/cases.json` checks answers against these facts —
 * change both together.
 */

export const STUDIO_FACTS = {
  name: 'MIKAN STUDIO',
  address: 'Томск, проспект Ленина, 100, 2 этаж',
  phone: '+7 (900) 000-00-00',
  workingHours: 'Ежедневно с 11:00 до 21:00, без выходных',
  timezone: 'Asia/Tomsk',
  about: 'Студия тату и пирсинга. Работаем только одноразовыми иглами, украшения для проколов — из имплантационного титана.',
};

export interface FixtureService {
  key: string;
  name: string;
  category: 'tattoo' | 'piercing';
  group: string;
  price: number;
  priceMax?: number;
  priceFrom?: boolean;
  durationMin: number;
  deposit?: number;
  description: string;
  variants?: ServiceVariant[];
  /** The service has a cover picture (so `show_service` works for it). */
  picture?: boolean;
}

const NO_JEWELRY = 'Цена без украшения — его выбирают отдельно из наличия.';
const TATTOO_PRICE = 'Итоговая стоимость зависит от объёма и сложности.';

export const FIXTURE_SERVICES: FixtureService[] = [
  {
    key: 'lobe',
    name: 'Мочка',
    category: 'piercing',
    group: 'Ухо',
    price: 1600,
    durationMin: 30,
    description: `Прокол мочки уха стерильной одноразовой иглой. ${NO_JEWELRY}`,
    variants: [
      { name: 'Один прокол', price: 1600, durationMin: 30 },
      { name: 'Пара (оба уха)', price: 2800, durationMin: 45 },
    ],
  },
  {
    key: 'helix',
    name: 'Хеликс',
    category: 'piercing',
    group: 'Ухо',
    price: 1800,
    durationMin: 40,
    description: `Прокол хряща в верхней части уха. ${NO_JEWELRY}`,
  },
  {
    key: 'tragus',
    name: 'Трагус',
    category: 'piercing',
    group: 'Ухо',
    price: 1900,
    durationMin: 40,
    description: `Прокол небольшого хряща перед слуховым проходом. ${NO_JEWELRY}`,
  },
  {
    key: 'nostril',
    name: 'Крыло носа',
    category: 'piercing',
    group: 'Лицо',
    price: 2000,
    durationMin: 30,
    description: `Прокол крыла носа (нострил). ${NO_JEWELRY}`,
  },
  {
    key: 'septum',
    name: 'Септум',
    category: 'piercing',
    group: 'Лицо',
    price: 2500,
    durationMin: 40,
    description: `Прокол носовой перегородки в мягкой ткани под хрящом. ${NO_JEWELRY}`,
  },
  {
    key: 'navel',
    name: 'Пупок',
    category: 'piercing',
    group: 'Тело',
    price: 2500,
    durationMin: 40,
    description: `Прокол над пупком. ${NO_JEWELRY}`,
    picture: true,
  },
  {
    key: 'jewelry-change',
    name: 'Замена украшения',
    category: 'piercing',
    group: 'Доп. услуги',
    price: 500,
    durationMin: 15,
    description: 'Мастер меняет или устанавливает украшение. Украшение оплачивается отдельно.',
  },
  {
    key: 'tattoo-consultation',
    name: 'Консультация по тату',
    category: 'tattoo',
    group: 'Тату',
    price: 0,
    durationMin: 30,
    description: 'Бесплатная консультация: идея, эскиз, размер, место и стоимость татуировки.',
  },
  {
    key: 'tattoo-mini',
    name: 'Мини тату до 5 см',
    category: 'tattoo',
    group: 'Тату',
    price: 2000,
    priceMax: 5000,
    durationMin: 60,
    deposit: 1000,
    description: `Татуировка размером до 5 см. ${TATTOO_PRICE}`,
  },
  {
    key: 'tattoo-medium',
    name: 'Тату до 10 см',
    category: 'tattoo',
    group: 'Тату',
    price: 0,
    priceMax: 10000,
    durationMin: 120,
    deposit: 2000,
    description: `Татуировка размером до 10 см. ${TATTOO_PRICE}`,
  },
  {
    key: 'tattoo-large',
    name: 'Большое тату от 15 см',
    category: 'tattoo',
    group: 'Тату',
    price: 12000,
    priceFrom: true,
    durationMin: 240,
    deposit: 3000,
    description: 'Татуировка от 15 см; крупные работы делаются в несколько сеансов. Итоговую стоимость мастер называет на консультации.',
  },
];

export interface FixtureJewelry {
  name: string;
  category: string;
  material: string;
  threadType?: ThreadType;
  thicknessMm: number;
  color?: string;
  stone?: string;
  description?: string;
  /** Keys of `FIXTURE_SERVICES` the piece suits. */
  suits: string[];
  sizes: Array<{ name: string; price: number; quantity: number }>;
  photo?: boolean;
}

export const FIXTURE_JEWELRY: FixtureJewelry[] = [
  {
    name: 'Лабрет с плоским диском',
    category: 'Лабреты',
    material: 'Титан ASTM F136',
    threadType: 'internal',
    thicknessMm: 1.2,
    description: 'Подходит для первичного прокола.',
    suits: ['lobe', 'helix', 'tragus'],
    sizes: [
      { name: '6 мм', price: 1500, quantity: 3 },
      { name: '8 мм', price: 1500, quantity: 2 },
      { name: '10 мм', price: 1500, quantity: 0 },
    ],
  },
  {
    name: 'Кольцо-кликер',
    category: 'Кольца',
    material: 'Титан ASTM F136',
    thicknessMm: 1.2,
    color: 'серебристый',
    suits: ['septum', 'helix', 'lobe'],
    sizes: [
      { name: '8 мм', price: 2200, quantity: 1 },
      { name: '10 мм', price: 2300, quantity: 4 },
    ],
  },
  {
    name: 'Банан для пупка с фианитом',
    category: 'Бананы',
    material: 'Титан ASTM F136',
    threadType: 'internal',
    thicknessMm: 1.6,
    stone: 'фианит',
    suits: ['navel'],
    sizes: [{ name: '10 мм', price: 2400, quantity: 2 }],
    photo: true,
  },
  {
    name: 'Нострил-гвоздик титановый',
    category: 'Нострилы',
    material: 'Титан ASTM F136',
    threadType: 'threadless',
    thicknessMm: 0.8,
    suits: ['nostril'],
    sizes: [{ name: '6 мм', price: 1400, quantity: 3 }],
  },
  {
    name: 'Нострил-гвоздик золотой',
    category: 'Нострилы',
    material: 'Золото 585',
    thicknessMm: 0.8,
    suits: ['nostril'],
    sizes: [{ name: '6 мм', price: 4500, quantity: 0 }],
  },
];

/** The knowledge base (replaces the seeded drafts). */
export const FIXTURE_KNOWLEDGE: Array<{ title: string; content: string }> = [
  {
    title: 'Противопоказания',
    content:
      'Татуировку и пирсинг не делаем при простуде, температуре и других острых инфекциях; при обострении хронических ' +
      'заболеваний; при воспалениях, высыпаниях и ожогах (в том числе солнечных) в зоне процедуры; в состоянии ' +
      'алкогольного или наркотического опьянения. При беременности и грудном вскармливании, диабете, нарушениях ' +
      'свёртываемости крови, эпилепсии, склонности к келоидам — только после консультации с врачом. Об аллергии ' +
      '(на никель, латекс, компоненты красок) предупредите мастера заранее.',
  },
  {
    title: 'Возраст',
    content:
      'Татуировки делаем только с 18 лет, при себе нужен паспорт; согласие родителей для тату не принимаем. Пирсинг ' +
      'с 14 до 18 лет — только в присутствии родителя или законного представителя с паспортом, письменное согласие ' +
      'подписывается в студии. Младше 14 лет — только прокол мочки, тоже с родителем.',
  },
  {
    title: 'Как подготовиться к сеансу',
    content:
      'Хорошо выспитесь, не пейте алкоголь за сутки до процедуры и плотно поешьте за 1–2 часа. На длинный сеанс тату ' +
      'возьмите воду и перекус. Не загорайте перед тату. Если заболели — перенесите запись, предупредив студию заранее.',
  },
  {
    title: 'Предоплата',
    content:
      'Предоплата нужна только при записи на татуировку: 1 000 ₽ за мини тату, 2 000 ₽ за тату до 10 см и 3 000 ₽ за ' +
      'большое. Она вносится по ссылке СБП и засчитывается в стоимость. На пирсинг и консультацию предоплата не нужна.',
  },
  {
    title: 'Обезболивание',
    content:
      'Для пирсинга обезболивающее не используем: прокол длится несколько секунд. Для тату по договорённости с мастером ' +
      'можно использовать обезболивающий крем — это обсуждается на консультации.',
  },
  {
    title: 'Оплата',
    content: 'Оплатить можно наличными, картой или по QR-коду СБП. Бонусами можно оплатить до 30% чека.',
  },
  {
    title: 'Коррекция татуировки',
    content: 'Одна коррекция в течение 2 месяцев после сеанса — бесплатно, если соблюдался уход.',
  },
  {
    title: 'Подарочные сертификаты',
    content:
      'Подарочный сертификат на любую сумму от 500 ₽ можно купить в студии. Действует 12 месяцев, им можно оплатить ' +
      'любые услуги и украшения.',
  },
  {
    title: 'Стерильность',
    content:
      'Иглы одноразовые, их вскрывают при клиенте. Инструменты стерилизуются в автоклаве. Для первичного прокола — ' +
      'только украшения из имплантационного титана ASTM F136.',
  },
];
