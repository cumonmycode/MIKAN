import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { publicMasterPortfolio, publicServicePortfolio } from '../domain/portfolio.js';
import { idParams, parse } from '../lib/validation.js';

/** Reads limit of the public booking API (routes/public-booking.ts): per IP, a minute. */
const READ_LIMIT = { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } };
const serviceQuery = z.object({ serviceId: z.coerce.number().int().positive() });

/**
 * Masters' works on the booking page and in the Mini App (docs/API.md «Portfolio»): no auth, under
 * `/public/booking`. They answer while online booking is off, like the catalog.
 */
export function publicPortfolioRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/masters/:id/portfolio', READ_LIMIT, async (request) => {
    const { id } = parse(idParams, request.params);
    return { items: publicMasterPortfolio(ctx.db, id) };
  });

  app.get('/portfolio', READ_LIMIT, async (request) => {
    const { serviceId } = parse(serviceQuery, request.query);
    return { items: publicServicePortfolio(ctx.db, serviceId) };
  });
}
