import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import {
  addPortfolioPhoto,
  assertManagesPortfolio,
  deletePortfolioPhoto,
  getPortfolioRow,
  listPortfolio,
  MAX_PORTFOLIO_CAPTION,
  MAX_PORTFOLIO_PHOTOS,
  orderPortfolio,
  updatePortfolioPhoto,
} from '../domain/portfolio.js';
import { idParams, nullableText, parse } from '../lib/validation.js';

const id = z.number().int().positive();
const queryId = z.coerce.number().int().positive().optional();
/** Only a file uploaded through `POST /uploads`: the booking page shows nothing from other sites. */
const UPLOAD_PATH = /^\/uploads\/[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/;
const uploadedImage = z
  .string()
  .trim()
  .refine((v) => UPLOAD_PATH.test(v) && !v.includes('..'), { message: 'нужна ссылка на загруженное фото (/uploads/…)' });

const listQuery = z.object({ employeeId: queryId, serviceId: queryId });
const createBody = z.object({
  employeeId: id,
  imageUrl: uploadedImage,
  serviceId: id.nullish(),
  caption: nullableText(MAX_PORTFOLIO_CAPTION),
});
const patchBody = z.object({ serviceId: id.nullish(), caption: nullableText(MAX_PORTFOLIO_CAPTION) });
const orderBody = z.object({ employeeId: id, ids: z.array(id).max(MAX_PORTFOLIO_PHOTOS) });

/** Masters' portfolio (docs/API.md «Portfolio»): every role reads; a master changes only their own. */
export function portfolioRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db } = ctx;

  app.get('/portfolio', async (request) => {
    const q = parse(listQuery, request.query);
    return { items: listPortfolio(db, q) };
  });

  app.post('/portfolio', async (request) => {
    const input = parse(createBody, request.body);
    assertManagesPortfolio(request.employee, input.employeeId);
    return addPortfolioPhoto(db, input, request.employee.id);
  });

  app.patch('/portfolio/:id', async (request) => {
    const params = parse(idParams, request.params);
    const input = parse(patchBody, request.body);
    assertManagesPortfolio(request.employee, getPortfolioRow(db, params.id).employeeId);
    return updatePortfolioPhoto(db, params.id, input);
  });

  app.put('/portfolio/order', async (request) => {
    const input = parse(orderBody, request.body);
    assertManagesPortfolio(request.employee, input.employeeId);
    return { items: orderPortfolio(db, input.employeeId, input.ids) };
  });

  app.delete('/portfolio/:id', async (request, reply) => {
    const params = parse(idParams, request.params);
    assertManagesPortfolio(request.employee, getPortfolioRow(db, params.id).employeeId);
    deletePortfolioPhoto(db, params.id);
    return reply.code(204).send();
  });
}
