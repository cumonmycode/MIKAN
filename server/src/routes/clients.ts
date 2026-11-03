import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import {
  CLIENT_NOTES_MAX,
  cleanTelegramNick,
  clientHistory,
  clientStats,
  createClient,
  issueLinkToken,
  searchClients,
  updateClient,
} from '../domain/clients.js';
import { findClientChat, serializeChat } from '../domain/bot-chats.js';
import { dismissDuplicates, listDuplicates } from '../domain/client-duplicates.js';
import { mergeClients } from '../domain/client-merge.js';
import { historyEntries } from '../domain/history.js';
import { clientLoyalty } from '../domain/loyalty.js';
import { getClientRow, serializeAppointments, serializeSales } from '../domain/refs.js';
import { conflict } from '../lib/errors.js';
import { clientOut, type ClientRow } from '../lib/serialize.js';
import {
  birthdayDate,
  idParams,
  nonNull,
  nullableText,
  pagination,
  parse,
  phoneInput,
  queryBool,
  requiredText,
} from '../lib/validation.js';

/** Telegram username rules: Latin letters, digits and "_"; "@nick" and t.me links are accepted. */
const TELEGRAM_NICK = /^[A-Za-z0-9_]{4,32}$/;

const telegramNick = nullableText(200).transform((value, ctx) => {
  const nick = cleanTelegramNick(value);
  if (nick != null && !TELEGRAM_NICK.test(nick)) {
    ctx.addIssue({ code: 'custom', message: 'латинские буквы, цифры и «_», от 4 до 32 символов (например, @ivan_petrov)' });
    return z.NEVER;
  }
  return nick;
});

const fields = {
  lastName: nullableText(200),
  phone: phoneInput,
  instagram: nullableText(100),
  telegramNick,
  birthday: birthdayDate,
  notes: nullableText(CLIENT_NOTES_MAX),
  source: nullableText(100),
};

const createBody = z.object({
  name: requiredText(200),
  ...fields,
  // Required for new clients; older rows without a phone stay valid (see updateClient).
  phone: phoneInput.refine((phone) => phone != null, { message: 'обязательное поле' }),
  botEnabled: nonNull(z.boolean()),
  marketingOptOut: nonNull(z.boolean()),
});
const patchBody = z.object({
  name: nonNull(requiredText(200)),
  ...fields,
  botEnabled: nonNull(z.boolean()),
  marketingOptOut: nonNull(z.boolean()),
  archived: nonNull(z.boolean()),
});
const clientId = z.number().int().positive();
const mergeBody = z.object({ intoId: clientId });
/** Distinct ids of the cards that are different people (a group of the duplicates list). */
const dismissBody = z.object({
  clientIds: z
    .array(clientId)
    .min(2)
    .max(500)
    .refine((ids) => new Set(ids).size === ids.length, { message: 'карточки не должны повторяться' }),
});
const listQuery = pagination.extend({
  search: z.string().trim().max(100).optional(),
  archived: queryBool,
});

export function clientRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db } = ctx;
  /** The client card: with its stats and loyalty (lists leave both out). */
  const card = (row: ClientRow) => clientOut(row, clientStats(db, row.id), clientLoyalty(db, row));

  app.get('/clients', async (request) => {
    const q = parse(listQuery, request.query);
    const { rows, total } = searchClients(db, { search: q.search, archived: q.archived ?? false, limit: q.limit, offset: q.offset });
    return { items: rows.map((r) => clientOut(r)), total };
  });

  app.get('/clients/duplicates', async () => ({ items: listDuplicates(db) }));

  app.post('/clients/duplicates/dismiss', async (request, reply) => {
    const input = parse(dismissBody, request.body);
    dismissDuplicates(db, input.clientIds);
    return reply.code(204).send();
  });

  app.post('/clients/:id/merge', async (request) => {
    const { id } = parse(idParams, request.params);
    const input = parse(mergeBody, request.body);
    return card(mergeClients(db, id, input.intoId));
  });

  app.get('/clients/:id', async (request) => {
    const { id } = parse(idParams, request.params);
    return card(getClientRow(db, id));
  });

  app.post('/clients', async (request) => {
    const input = parse(createBody, request.body);
    return card(createClient(db, input));
  });

  app.patch('/clients/:id', async (request) => {
    const { id } = parse(idParams, request.params);
    const input = parse(patchBody, request.body);
    return card(updateClient(db, id, input));
  });

  app.get('/clients/:id/history', async (request) => {
    const { id } = parse(idParams, request.params);
    getClientRow(db, id);
    const { appts, saleRows } = clientHistory(db, id);
    return {
      items: historyEntries(db, { clientId: id }),
      appointments: serializeAppointments(db, appts),
      sales: serializeSales(db, saleRows),
    };
  });

  app.get('/clients/:id/chat', async (request) => {
    const { id } = parse(idParams, request.params);
    const chat = findClientChat(db, getClientRow(db, id));
    return { chat: chat ? serializeChat(db, chat) : null };
  });

  app.post('/clients/:id/telegram-link', async (request) => {
    const { id } = parse(idParams, request.params);
    const username = ctx.gateway.username();
    if (!username) {
      throw conflict('Telegram-бот ещё не подключён: проверьте токен бота и что бот запущен');
    }
    const token = issueLinkToken(db, id);
    return { url: `https://t.me/${username}?start=c${token}` };
  });
}
