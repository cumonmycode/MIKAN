import type Anthropic from '@anthropic-ai/sdk';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import type { DbOrTx } from '../db/client.js';
import { portfolioPhotos, services } from '../db/schema.js';
import { onlineMasters } from '../domain/online-booking-slots.js';
import { portfolioCovers, type PortfolioRow } from '../domain/portfolio.js';
import { getStudioSettings } from '../domain/settings.js';
import type { EmployeeRow, ServiceRow } from '../lib/serialize.js';
import { pluralWord, TELEGRAM_MAX_CAPTION, truncate } from '../lib/text.js';
import type { PhotoSource } from './gateway.js';
import { photoSourceFor } from './media.js';
import type { ToolHandler, ToolResult, ToolScope, ToolSink } from './tools.js';

/**
 * `show_portfolio`: the AI sends photos of masters' work (docs/API.md «Portfolio»), and the client prompt lists the
 * masters with their ids and how many works each has.
 */

export const MAX_PORTFOLIO_SHOTS = 5;
/** Photos looked at before the readable ones are picked (a master has at most 100). */
const CANDIDATES = 200;
const CAPTION_TEXT_MAX = 300;

/** A photo to send after the reply. */
export interface PortfolioShot {
  id: number;
  source: PhotoSource;
  caption: string;
  masterName: string;
}

export const SHOW_PORTFOLIO_TOOL: Anthropic.Tool = {
  name: 'show_portfolio',
  description:
    `Отправляет клиенту фото работ мастеров студии (до ${MAX_PORTFOLIO_SHOTS}) с короткой подписью: мастер и услуга. ` +
    'Вызывай, когда клиент просит показать работы, примеры, портфолио: конкретного мастера — masterId из раздела ' +
    '«Мастера»; по услуге — serviceId из «Услуги и цены»; можно оба; без них — последние работы студии. Фото придут ' +
    'сразу после твоего ответа: не описывай их и не придумывай работ, которых нет.',
  input_schema: {
    type: 'object',
    properties: {
      masterId: { type: 'integer', description: 'id мастера из раздела «Мастера»' },
      serviceId: { type: 'integer', description: 'id услуги из раздела «Услуги и цены»' },
    },
  },
};

const input = z.object({ masterId: z.number().int().positive().nullish(), serviceId: z.number().int().positive().nullish() });

const error = (content: string): ToolResult => ({ content, isError: true });
const worksText = (n: number) => `${n} ${pluralWord(n, 'работа', 'работы', 'работ')}`;

/** «Мастер: **Фатима** · Хеликс» and the photo's own caption on the next line. */
export function portfolioCaption(masterName: string, serviceName: string | null, caption: string | null): string {
  const title = `Мастер: **${masterName}**${serviceName ? ` · ${serviceName}` : ''}`;
  const text = caption?.trim();
  return truncate(text ? `${title}\n${truncate(text, CAPTION_TEXT_MAX)}` : title, TELEGRAM_MAX_CAPTION);
}

/** «## Мастера» of the client prompt: who clients can book, by id, and their works. */
export function mastersSection(db: DbOrTx): string | null {
  const masters = onlineMasters(db);
  if (masters.length === 0) return null;
  const covers = portfolioCovers(db, masters.map((m) => m.id));
  const lines = masters.map((m) => {
    const photos = covers.get(m.id)?.photos ?? 0;
    return `• [id ${m.id}] ${m.name} · ${photos > 0 ? `в портфолио ${worksText(photos)}` : 'работ в портфолио пока нет'}`;
  });
  return (
    `## Мастера\n${lines.join('\n')}\n` +
    'Клиент просит показать работы (мастера, по услуге или вообще) — вызови show_portfolio с masterId и/или serviceId: ' +
    'фото с подписью придут сразу после твоего ответа. Работ нет — так и скажи, не придумывай.'
  );
}

interface Selection {
  rows: PortfolioRow[];
  /** The master had no works of that service: their other works are shown. */
  fellBack: boolean;
}

function select(db: DbOrTx, masterIds: number[], q: { masterId: number | null; serviceId: number | null }): Selection {
  if (masterIds.length === 0) return { rows: [], fellBack: false };
  if (q.masterId !== null) {
    const byMaster = (serviceId: number | null) =>
      db
        .select()
        .from(portfolioPhotos)
        .where(and(eq(portfolioPhotos.employeeId, q.masterId!), serviceId === null ? undefined : eq(portfolioPhotos.serviceId, serviceId)))
        .orderBy(asc(portfolioPhotos.sort), asc(portfolioPhotos.id))
        .limit(CANDIDATES)
        .all();
    const rows = byMaster(q.serviceId);
    if (rows.length > 0 || q.serviceId === null) return { rows, fellBack: false };
    const others = byMaster(null);
    return { rows: others, fellBack: others.length > 0 };
  }
  const rows = db
    .select()
    .from(portfolioPhotos)
    .where(
      and(
        inArray(portfolioPhotos.employeeId, masterIds),
        q.serviceId === null ? undefined : eq(portfolioPhotos.serviceId, q.serviceId),
      ),
    )
    .orderBy(desc(portfolioPhotos.createdAt), desc(portfolioPhotos.id))
    .limit(CANDIDATES)
    .all();
  return { rows, fellBack: false };
}

function shotsOf(ctx: AppContext, rows: PortfolioRow[], masters: Map<number, EmployeeRow>): PortfolioShot[] {
  const serviceIds = [...new Set(rows.map((r) => r.serviceId).filter((id): id is number => id !== null))];
  const names = new Map(
    serviceIds.length
      ? ctx.db
          .select({ id: services.id, name: services.name })
          .from(services)
          .where(and(inArray(services.id, serviceIds), eq(services.active, true)))
          .all()
          .map((s) => [s.id, s.name])
      : [],
  );
  return rows.flatMap((r) => {
    const master = masters.get(r.employeeId);
    const source = photoSourceFor(ctx.config.dataDir, r.imageUrl);
    if (!master || !source) return [];
    const serviceName = r.serviceId === null ? null : (names.get(r.serviceId) ?? null);
    return [{ id: r.id, source, caption: portfolioCaption(master.name, serviceName, r.caption), masterName: master.name }];
  });
}

function nothingText(master: EmployeeRow | null, service: ServiceRow | null): string {
  const tail = ' — скажи об этом клиенту и не описывай работы сам.';
  if (master) return `У мастера ${master.name} пока нет фото работ${tail}`;
  if (service) return `По услуге «${service.name}» фото работ пока нет${tail}`;
  return `Фото работ студии пока нет${tail}`;
}

export function buildPortfolioToolHandler(ctx: AppContext, scope: ToolScope, sink: ToolSink): ToolHandler {
  return async (raw) => {
    const parsed = input.safeParse(raw ?? {});
    if (!parsed.success) return error('Некорректные данные: masterId и serviceId — целые id из разделов «Мастера» и «Услуги и цены».');
    const masterId = parsed.data.masterId ?? null;
    const serviceId = parsed.data.serviceId ?? null;
    const masters = new Map(onlineMasters(ctx.db).map((m) => [m.id, m]));
    const master = masterId === null ? null : (masters.get(masterId) ?? null);
    if (masterId !== null && !master) return error('Такого мастера нет. Возьми id из раздела «Мастера».');
    const service =
      serviceId === null
        ? null
        : (ctx.db.select().from(services).where(and(eq(services.id, serviceId), eq(services.active, true))).get() ?? null);
    if (serviceId !== null && !service) return error('Такой услуги нет в прайсе. Возьми id из раздела «Услуги и цены».');

    const selection = select(ctx.db, [...masters.keys()], { masterId, serviceId });
    const readable = shotsOf(ctx, selection.rows, masters);
    if (readable.length === 0) return { content: nothingText(master, selection.fellBack ? null : service) };
    // At most MAX_PORTFOLIO_SHOTS photos follow one answer, however many calls asked for them.
    const room = MAX_PORTFOLIO_SHOTS - sink.portfolio.length;
    if (room <= 0) return { content: `После этого ответа уже уйдут ${MAX_PORTFOLIO_SHOTS} фото — больше за один ответ не отправляю.` };
    const fresh = readable.filter((shot) => !sink.portfolio.some((queued) => queued.id === shot.id)).slice(0, room);
    if (fresh.length === 0) return { content: 'Эти фото уже будут отправлены клиенту после твоего ответа — не вызывай show_portfolio повторно.' };
    sink.portfolio.push(...fresh);
    const who = [...new Set(fresh.map((s) => s.masterName))].join(', ');
    if (scope.mode === 'test') sink.notes.push(`показаны бы работы: ${fresh.length} фото (${who})`);

    const count = readable.length > fresh.length ? `${fresh.length} из ${readable.length}` : String(fresh.length);
    const notes = [
      `Фото работ (${count}) будут отправлены клиенту после твоего ответа: ${master ? `мастер ${who}` : `мастера: ${who}`}.`,
      'Подписи с мастером и услугой придут вместе с фото — не описывай их.',
      selection.fellBack && service ? `У мастера ${master?.name} по услуге «${service.name}» работ нет — отправлю другие работы мастера, скажи об этом клиенту.` : null,
      readable.length > fresh.length && getStudioSettings(ctx.db).onlineBooking.enabled
        ? 'Все работы клиент увидит при онлайн-записи (кнопка «📅 Записаться» в меню чата) на шаге выбора мастера.'
        : null,
    ];
    return { content: notes.filter(Boolean).join(' ') };
  };
}
