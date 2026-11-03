import { z } from 'zod';
import { badRequest } from './errors.js';
import { isStoredBirthday } from './birthday.js';
import { normalizePhone, isPlausiblePhone } from './phone.js';
import { isValidCalendarDate, parseInstant } from './time.js';

const FIELD_LABELS: Record<string, string> = {
  name: 'Название / имя',
  login: 'Логин',
  password: 'Пароль',
  phone: 'Телефон',
  color: 'Цвет',
  isMaster: 'Мастер',
  active: 'Активность',
  price: 'Цена',
  priceFrom: 'Цена «от»',
  cost: 'Себестоимость',
  quantity: 'Количество',
  discount: 'Скидка',
  startsAt: 'Начало',
  endsAt: 'Окончание',
  clientId: 'Клиент',
  masterId: 'Мастер',
  serviceId: 'Услуга',
  productId: 'Товар',
  appointmentId: 'Запись',
  items: 'Позиции',
  payments: 'Оплата',
  cash: 'Наличные',
  card: 'Карта',
  transfer: 'Перевод',
  qr: 'QR-код',
  openingCash: 'Наличные на начало смены',
  closingCash: 'Наличные в кассе',
  amount: 'Сумма',
  employeeId: 'Сотрудник',
  date: 'Дата',
  fromCash: 'Выдать из кассы',
  effectiveFrom: 'Действует с',
  salaryMonthly: 'Оклад в месяц',
  perDay: 'Оплата за рабочий день',
  servicePercent: 'Процент с услуг',
  categoryPercent: 'Процент по разделу',
  tattoo: 'Тату',
  piercing: 'Пирсинг',
  productPercent: 'Процент с продажи товаров',
  deductMaterials: 'Вычитать расходники',
  reason: 'Причина',
  text: 'Текст',
  title: 'Заголовок',
  caption: 'Подпись',
  content: 'Текст',
  steps: 'Шаги',
  dayOffset: 'День',
  category: 'Категория',
  kind: 'Тип',
  type: 'Тип',
  status: 'Статус',
  durationMin: 'Длительность',
  birthday: 'Дата рождения',
  timezone: 'Часовой пояс',
  workdayStart: 'Начало рабочего дня',
  workdayEnd: 'Конец рабочего дня',
  cancellation: 'Отмена и предоплата',
  freeHours: 'Бесплатная отмена, часов',
  lateRetainPercent: 'Удержание при поздней отмене, %',
  noShowRetainPercent: 'Удержание при неявке, %',
  autoRetain: 'Удерживать автоматически',
  reviewLinks: 'Ссылки на отзывы',
  yandex: 'Яндекс Карты',
  twogis: '2ГИС',
  google: 'Google',
  aftercareHour: 'Час отправки памяток',
  reminderHoursBefore: 'За сколько часов напоминать',
  reminderOffsets: 'Напоминания',
  minQuantity: 'Минимальный остаток',
  initialQuantity: 'Начальный остаток',
  from: 'Начало периода',
  to: 'Конец периода',
  dateFrom: 'Даты с',
  dateTo: 'Даты по',
  limit: 'Лимит',
  offset: 'Смещение',
  sku: 'Артикул',
  unit: 'Единица',
  photoUrl: 'Фото',
  deposit: 'Предоплата',
  depositRequired: 'Предоплата',
  depositAmount: 'Предоплата',
  delivery: 'Способ отправки',
  method: 'Способ оплаты',
  chatId: 'Чат',
  instagram: 'Instagram',
  lastName: 'Фамилия',
  telegramNick: 'Ник в Telegram',
  notes: 'Заметки',
  note: 'Комментарий',
  source: 'Источник',
  aiPaused: 'Пауза ИИ',
  greeting: 'Приветствие',
  consumables: 'Расходники',
  aftercareTemplateId: 'Памятка по уходу',
  sort: 'Порядок',
  sendAftercare: 'Отправить памятку',
  restock: 'Вернуть на склад',
  sendAt: 'Время отправки',
  group: 'Группа',
  priceMax: 'Максимальная цена',
  photos: 'Фото',
  variants: 'Варианты',
  masterPrices: 'Цены мастеров',
  imageUrl: 'Картинка',
  imagePrompt: 'Описание картинки',
  prompt: 'Описание картинки',
  services: 'Услуги',
  material: 'Материал',
  threadType: 'Резьба',
  thicknessMm: 'Толщина',
  stone: 'Камень',
  supplier: 'Поставщик',
  unitCost: 'Цена закупки за штуку',
  search: 'Поиск',
  pos: 'Касса',
  sendReceipt: 'Отправлять чек клиенту в Telegram',
  size: 'Размер',
  serviceIds: 'Подходящие услуги',
  variantId: 'Размер',
  lines: 'Размеры',
  description: 'Описание',
  freshProcedure: 'Свежий прокол / свежее тату',
  healingCheckDays: 'Спросить, как заживает',
  jewelryChangeWeeks: 'Напомнить о замене украшения',
  section: 'Раздел',
  serviceCategory: 'Раздел услуг',
  ids: 'Категории',
  intoId: 'Категория',
  jewelryIds: 'Совместимые украшения',
  stockMode: 'Учёт',
  presenceStatus: 'Наличие',
  counts: 'Пересчёт',
  presence: 'Наличие',
  onlineBooking: 'Онлайн-запись',
  enabled: 'Включено',
  leadMinutes: 'Запись не раньше чем через, мин',
  horizonDays: 'Запись вперёд, дней',
  holdMinutes: 'Время на оплату предоплаты, мин',
  stepMinutes: 'Шаг времени записи, мин',
  confirmationHours: 'Отклонять неподтверждённые через, ч',
  variant: 'Вариант',
  comment: 'Комментарий',
  bonus: 'Бонусы',
  certificates: 'Сертификаты',
  code: 'Код сертификата',
  recipientName: 'Кому',
  expiresAt: 'Действует до',
  marketingOptOut: 'Не присылать новости',
  segment: 'Получатели',
  button: 'Кнопка',
  url: 'Ссылка',
  at: 'Время отправки',
  lastVisitMonthsAgoMin: 'Последний визит — от, месяцев назад',
  lastVisitMonthsAgoMax: 'Последний визит — до, месяцев назад',
  neverVisited: 'Ещё не были в студии',
  categories: 'Разделы услуг',
  masterIds: 'Мастера',
  minVisits: 'Визитов не меньше',
  birthdayMonth: 'Месяц рождения',
  hasBonuses: 'Есть бонусы',
  createdWithinDays: 'Новые клиенты, дней',
};

function fieldLabel(path: PropertyKey[]): string | null {
  const keys = path.filter((p): p is string => typeof p === 'string');
  const index = path.find((p): p is number => typeof p === 'number');
  const key = keys[keys.length - 1];
  if (!key) return null;
  const label = FIELD_LABELS[key] ?? key;
  return index === undefined ? label : `${label} (№${index + 1})`;
}

function describeIssue(issue: z.core.$ZodIssue): string {
  switch (issue.code) {
    case 'invalid_type': {
      const missing =
        'input' in issue ? issue.input === undefined || issue.input === null : /received (undefined|null)/.test(issue.message);
      if (missing) return 'обязательное поле';
      const expected: Record<string, string> = {
        number: 'должно быть числом',
        int: 'должно быть целым числом',
        string: 'должно быть строкой',
        boolean: 'должно быть «да» или «нет»',
        array: 'должно быть списком',
        object: 'должно быть объектом',
      };
      return expected[issue.expected] ?? 'неверный тип значения';
    }
    case 'too_small': {
      const min = Number(issue.minimum);
      if (issue.origin === 'string') return min <= 1 ? 'не может быть пустым' : `минимум ${min} символов`;
      if (issue.origin === 'array') return `нужно указать хотя бы ${min}`;
      return issue.inclusive ? `должно быть не меньше ${min}` : `должно быть больше ${min}`;
    }
    case 'too_big': {
      const max = Number(issue.maximum);
      if (issue.origin === 'string') return `максимум ${max} символов`;
      if (issue.origin === 'array') return `не больше ${max} элементов`;
      return issue.inclusive ? `должно быть не больше ${max}` : `должно быть меньше ${max}`;
    }
    case 'invalid_value':
      return `недопустимое значение (допустимо: ${issue.values.map(String).join(', ')})`;
    case 'invalid_format':
      return 'неверный формат';
    case 'custom':
      return issue.message;
    default:
      return 'некорректное значение';
  }
}

export function formatZodError(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return 'Некорректные данные';
  const label = fieldLabel(issue.path);
  const text = describeIssue(issue);
  if (issue.code === 'custom' && !label) return text;
  return label ? `«${label}»: ${text}` : `Некорректные данные: ${text}`;
}

/** Validates input, throwing a 400 `validation_error` with a Russian message. */
export function parse<S extends z.ZodType>(schema: S, data: unknown): z.output<S> {
  const result = schema.safeParse(data ?? {}, { reportInput: true });
  if (!result.success) throw badRequest(formatZodError(result.error));
  return result.data;
}

// ---------- reusable field schemas ----------

/** Treats `null` as "absent" — for non-nullable fields on PATCH/POST. */
export const nonNull = <T extends z.ZodType>(schema: T) =>
  z.preprocess((v) => (v === null ? undefined : v), schema.optional());

/** Optional text that may be cleared: undefined = untouched, null/"" = clear. */
export const nullableText = (max = 2000) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => (v === '' ? null : v));

export const requiredText = (max = 200) => z.string().trim().min(1).max(max);

export const money = z.number().int().min(0).max(100_000_000);

export const instant = z.string().transform((value, ctx) => {
  const ms = parseInstant(value);
  if (ms === null) {
    ctx.addIssue({ code: 'custom', message: 'неверный формат даты и времени' });
    return z.NEVER;
  }
  return ms;
});

export const calendarDate = z
  .string()
  .trim()
  .refine((v) => v === '' || isValidCalendarDate(v), { message: 'дата должна быть в формате ГГГГ-ММ-ДД' })
  .nullish()
  .transform((v) => (v === '' ? null : v));

/** A birthday `YYYY-MM-DD`: a real date, or day and month with the year 1900 («year unknown», 29 February too). */
export const birthdayDate = z
  .string()
  .trim()
  .refine((v) => v === '' || isStoredBirthday(v), { message: 'дата должна быть в формате ГГГГ-ММ-ДД' })
  .nullish()
  .transform((v) => (v === '' ? null : v));

/** Phone input → normalized "+7…" (null when cleared). */
export const phoneInput = z
  .string()
  .trim()
  .max(40)
  .nullish()
  .transform((value, ctx) => {
    if (value == null) return value;
    if (value === '') return null;
    const normalized = normalizePhone(value);
    if (!normalized || !isPlausiblePhone(normalized)) {
      ctx.addIssue({ code: 'custom', message: 'некорректный номер телефона' });
      return z.NEVER;
    }
    return normalized;
  });

export const hexColor = z
  .string()
  .trim()
  .regex(/^#[0-9A-Fa-f]{6}$/, { message: 'цвет должен быть в формате #RRGGBB' })
  .transform((v) => v.toUpperCase());

export const idParams = z.object({ id: z.coerce.number().int().positive() });

export const queryBool = z
  .enum(['true', 'false', '1', '0'])
  .optional()
  .transform((v) => (v === undefined ? undefined : v === 'true' || v === '1'));

export const queryId = z.coerce.number().int().positive().optional();

export const pagination = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const queryInstant = z
  .string()
  .optional()
  .transform((value, ctx) => {
    if (value === undefined || value === '') return undefined;
    const ms = parseInstant(value);
    if (ms === null) {
      ctx.addIssue({ code: 'custom', message: 'неверный формат даты и времени' });
      return z.NEVER;
    }
    return ms;
  });

/** Escapes LIKE wildcards; use with `ESCAPE '\\'`. */
export function likePattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}
