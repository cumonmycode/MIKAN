import { and, count, eq, ne } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import type { DbOrTx } from '../db/client.js';
import { appointments, employees } from '../db/schema.js';
import { AppError, badRequest } from '../lib/errors.js';
import type { EmployeeRow } from '../lib/serialize.js';

/** What an employee may do (docs/API.md «Roles»). */
export const ROLES = ['owner', 'admin', 'master'] as const;
export type Role = (typeof ROLES)[number];

export const OWNER_ONLY_MESSAGE = 'Это доступно владельцу студии';
export const MANAGERS_MESSAGE = 'Это доступно владельцу и администратору';
export const OWN_APPOINTMENTS_MESSAGE = 'Можно менять только свои записи';
export const LAST_OWNER_MESSAGE = 'В студии должен остаться хотя бы один владелец';
export const OWN_ROLE_MESSAGE = 'Нельзя изменить собственную роль';
export const SELF_DEACTIVATION_MESSAGE = 'Нельзя отключить собственную учётную запись';
/** What the staff bot answers a master asking for analytics. */
export const REPORTS_MESSAGE = 'Отчёты доступны владельцу и администратору';

export const forbidden = (message: string): AppError => new AppError('forbidden', message);

const OWNER: readonly Role[] = ['owner'];
const MANAGERS: readonly Role[] = ['owner', 'admin'];

/** The employee's role; anything unexpected in the database counts as the most limited one. */
export function roleOf(employee: Pick<EmployeeRow, 'role'>): Role {
  return (ROLES as readonly string[]).includes(employee.role) ? (employee.role as Role) : 'master';
}

/** `403` with the Russian message the app shows unless the employee has one of `roles`. */
export function assertRole(employee: Pick<EmployeeRow, 'role'>, roles: readonly Role[]): void {
  if (roles.includes(roleOf(employee))) return;
  throw forbidden(roles.includes('admin') ? MANAGERS_MESSAGE : OWNER_ONLY_MESSAGE);
}

/**
 * Routes limited to some roles: `METHOD /pattern` (Fastify's route pattern without `/api`) → who may call it.
 * Every route not listed is open to every role. `PATCH /employees/:id` checks itself (anyone edits their own profile);
 * work schedules, payroll and the audit log enforce their own rules.
 */
const RESTRICTED_ROUTES: ReadonlyMap<string, readonly Role[]> = new Map([
  ['POST /employees', OWNER],
  // Catalog and warehouse: masters only read them.
  ['POST /services', MANAGERS],
  ['PATCH /services/:id', MANAGERS],
  ['POST /services/:id/image/generate', MANAGERS],
  ['POST /aftercare-templates', MANAGERS],
  ['PATCH /aftercare-templates/:id', MANAGERS],
  ['DELETE /aftercare-templates/:id', MANAGERS],
  ['POST /catalog/categories', MANAGERS],
  ['PATCH /catalog/categories/:id', MANAGERS],
  ['PUT /catalog/categories/order', MANAGERS],
  ['POST /catalog/categories/:id/merge', MANAGERS],
  ['DELETE /catalog/categories/:id', MANAGERS],
  ['POST /products', MANAGERS],
  ['PATCH /products/:id', MANAGERS],
  ['DELETE /products/:id', MANAGERS],
  ['POST /products/:id/movements', MANAGERS],
  ['POST /products/:id/movements/batch', MANAGERS],
  ['POST /products/:id/purchases', MANAGERS],
  ['POST /stock/revisions', MANAGERS],
  ['POST /stock/deliveries', MANAGERS],
  // Finding and merging duplicate client cards.
  ['GET /clients/duplicates', MANAGERS],
  ['POST /clients/duplicates/dismiss', MANAGERS],
  ['POST /clients/:id/merge', MANAGERS],
  // Loyalty: paying with bonuses and selling or redeeming certificates are till actions (every role).
  ['POST /clients/:id/bonuses', MANAGERS],
  ['POST /certificates/:id/cancel', OWNER],
  // Reports and analytics.
  ['GET /reports/summary', MANAGERS],
  ['GET /reports/analytics', MANAGERS],
  ['GET /reports/growth', MANAGERS],
  // Settings, the knowledge base, staff chat binding and the bot test.
  ['PUT /settings/studio', MANAGERS],
  ['PUT /settings/retention', MANAGERS],
  ['PUT /settings/bot', MANAGERS],
  ['POST /knowledge', MANAGERS],
  ['PATCH /knowledge/:id', MANAGERS],
  ['DELETE /knowledge/:id', MANAGERS],
  ['PUT /bot/chats/:chatId/employee', MANAGERS],
  ['DELETE /bot/chats/:chatId/employee', MANAGERS],
  ['POST /bot/test', MANAGERS],
  // Telegram campaigns.
  ['GET /campaigns', MANAGERS],
  ['GET /campaigns/:id', MANAGERS],
  ['POST /campaigns', MANAGERS],
  ['PATCH /campaigns/:id', MANAGERS],
  ['POST /campaigns/preview', MANAGERS],
  ['POST /campaigns/:id/test', MANAGERS],
  ['POST /campaigns/:id/send', MANAGERS],
  ['POST /campaigns/:id/cancel', MANAGERS],
  ['DELETE /campaigns/:id', MANAGERS],
]);

/**
 * A master creates appointments only for themselves and changes only their own (and their prepayments).
 * `POST /appointments/:id/complete` is open to every role: completing a visit is a till action (checkout).
 */
const NEW_APPOINTMENT = 'POST /appointments';
const EDIT_APPOINTMENT = 'PATCH /appointments/:id';
const OWN_APPOINTMENT_ROUTES: ReadonlySet<string> = new Set([
  NEW_APPOINTMENT,
  EDIT_APPOINTMENT,
  'POST /appointments/:id/deposit',
  'POST /appointments/:id/deposit/refund',
  'POST /appointments/:id/deposit/retain',
  'POST /appointments/:id/deposit/qr',
  'POST /appointments/:id/deposit/remind',
  'POST /appointments/:id/online/confirm',
  'POST /appointments/:id/online/reject',
]);

const API_PREFIX = '/api';

/** `GET /reports/summary` for the matched route; HEAD runs the GET handler, so it counts as GET. */
function routeKey(request: FastifyRequest): string | null {
  const url = request.routeOptions.url;
  if (!url) return null;
  const method = request.method === 'HEAD' ? 'GET' : request.method;
  return `${method} ${url.startsWith(API_PREFIX) ? url.slice(API_PREFIX.length) : url}`;
}

/** Unknown or malformed ids pass: the route answers them with `404` / `400` as before. */
function assertOwnAppointment(db: DbOrTx, request: FastifyRequest, key: string): void {
  const me = request.employee.id;
  if (key === NEW_APPOINTMENT || key === EDIT_APPOINTMENT) {
    const masterId = (request.body as { masterId?: unknown } | null | undefined)?.masterId;
    if (typeof masterId === 'number' && masterId !== me) throw forbidden(OWN_APPOINTMENTS_MESSAGE);
  }
  if (key === NEW_APPOINTMENT) return;
  const id = Number((request.params as { id?: unknown }).id);
  if (!Number.isSafeInteger(id) || id <= 0) return;
  const row = db.select({ masterId: appointments.masterId }).from(appointments).where(eq(appointments.id, id)).get();
  if (row && row.masterId !== me) throw forbidden(OWN_APPOINTMENTS_MESSAGE);
}

/** `preHandler` of the secured scope: the role table, then a master's own appointments. */
export function authorize(db: DbOrTx) {
  return async (request: FastifyRequest): Promise<void> => {
    const key = routeKey(request);
    if (!key) return;
    const roles = RESTRICTED_ROUTES.get(key);
    if (roles) assertRole(request.employee, roles);
    if (roleOf(request.employee) === 'master' && OWN_APPOINTMENT_ROUTES.has(key)) assertOwnAppointment(db, request, key);
  };
}

export interface EmployeeChanges {
  login?: string;
  isMaster?: boolean;
  role?: Role;
  active?: boolean;
}

/**
 * The owner changes everything of others; anyone changes their own name, phone, color and password; nobody changes
 * their own role or deactivates themselves. A field resent with its current value (the app sends the whole card)
 * counts as untouched.
 */
export function assertEmployeeChangeAllowed(actor: EmployeeRow, target: EmployeeRow, input: EmployeeChanges): void {
  const self = actor.id === target.id;
  if (self && input.active === false) throw badRequest(SELF_DEACTIVATION_MESSAGE);
  if (self && input.role !== undefined && input.role !== target.role) throw badRequest(OWN_ROLE_MESSAGE);
  if (roleOf(actor) === 'owner') return;
  if (!self) throw forbidden(OWNER_ONLY_MESSAGE);
  const changesAccount =
    (input.login !== undefined && input.login !== target.login) ||
    (input.isMaster !== undefined && input.isMaster !== target.isMaster) ||
    (input.active !== undefined && input.active !== target.active);
  if (changesAccount) throw forbidden(OWNER_ONLY_MESSAGE);
}

/** Demoting or deactivating an active owner must leave another active owner. */
export function assertOwnerRemains(db: DbOrTx, current: EmployeeRow, next: { role: string; active: boolean }): void {
  const wasActiveOwner = current.active && roleOf(current) === 'owner';
  if (!wasActiveOwner || (next.active && next.role === 'owner')) return;
  const others =
    db
      .select({ n: count() })
      .from(employees)
      .where(and(eq(employees.role, 'owner'), eq(employees.active, true), ne(employees.id, current.id)))
      .get()?.n ?? 0;
  if (others === 0) throw badRequest(LAST_OWNER_MESSAGE);
}
