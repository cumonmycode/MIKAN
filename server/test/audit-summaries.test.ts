import { describe, expect, it } from 'vitest';
import { diffChanges, scrubSecrets } from '../src/domain/audit.js';
import { buildDraft, defaultDraft, type SummaryContext } from '../src/domain/audit-summaries.js';
import { dativeName, formatDayRange, weeklyText } from '../src/domain/audit-text.js';

const NOW = Date.parse('2026-10-15T09:00:00.000Z');

const context = (over: Partial<SummaryContext>): SummaryContext => ({
  method: 'POST',
  route: '/',
  path: '/',
  params: {},
  query: {},
  body: {},
  before: undefined,
  result: undefined,
  tz: 'Europe/Moscow',
  now: NOW,
  ...over,
});

const fatima = { employeeId: 3, name: 'Фатима', weekly: null };
const hours = { start: '11:00', end: '20:00', breaks: [{ start: '14:00', end: '14:30' }] };

describe('audit summaries of routes added in parallel (pure builders)', () => {
  it('describes a new weekly schedule with the change', () => {
    const weekly = [hours, hours, hours, hours, hours, null, null];
    const draft = buildDraft(
      context({
        method: 'PUT',
        route: '/employees/:id/schedule',
        path: '/employees/3/schedule',
        params: { id: '3' },
        body: { weekly },
        before: fatima,
        result: { employeeId: 3, weekly, days: [] },
      }),
    );
    expect(draft).toEqual({
      action: 'schedule.weekly',
      entity: 'schedule',
      entityId: 3,
      summary: 'График сотрудника «Фатима» изменён: пн–пт 11:00–20:00 (перерыв 14:00–14:30), сб–вс выходной',
      changes: { weekly: { from: null, to: weekly } },
    });
  });

  it('describes schedule exceptions set and removed', () => {
    const base = { route: '/employees/:id/schedule/days', path: '/employees/3/schedule/days', params: { id: '3' }, before: fatima };
    const off = buildDraft(context({ ...base, method: 'PUT', body: { from: '2026-10-23', to: '2026-10-25', off: true, note: 'Отпуск' } }));
    expect(off).toMatchObject({ action: 'schedule.days', entity: 'schedule', entityId: 3, summary: 'График сотрудника «Фатима»: 23–25 октября — выходной (Отпуск)' });
    const other = buildDraft(context({ ...base, method: 'PUT', body: { from: '2026-10-23', to: '2026-10-23', off: false, start: '12:00', end: '18:00' } }));
    expect(other.summary).toBe('График сотрудника «Фатима»: 23 октября — 12:00–18:00');
    const removed = buildDraft(context({ ...base, method: 'DELETE', query: { from: '2026-10-30', to: '2026-11-02' } }));
    expect(removed).toMatchObject({ action: 'schedule.days_reset', summary: 'График сотрудника «Фатима»: исключения на 30 октября – 2 ноября убраны' });
  });

  it('describes pay rules', () => {
    const rules = { salaryMonthly: 0, perDay: 1500, servicePercent: 40, categoryPercent: { tattoo: 50, piercing: null, other: null }, productPercent: 10, deductMaterials: true };
    const draft = buildDraft(
      context({
        method: 'PUT',
        route: '/employees/:id/pay-rules',
        path: '/employees/3/pay-rules',
        params: { id: '3' },
        body: { effectiveFrom: '2026-11-01', ...rules },
        before: { name: 'Фатима', rules: { ...rules, perDay: 1000 } },
        result: { current: rules, history: [] },
      }),
    );
    expect(draft).toEqual({
      action: 'payroll.rules',
      entity: 'payroll',
      entityId: 3,
      summary: 'Правила зарплаты сотрудника «Фатима» с 1 ноября: 1 500 ₽ за день, 40% с услуг (тату 50%), 10% с товаров, материалы вычитаются',
      changes: { perDay: { from: 1000, to: 1500 } },
    });
    const salary = buildDraft(
      context({ method: 'PUT', route: '/employees/:id/pay-rules', path: '/employees/3/pay-rules', params: { id: '3' }, body: { salaryMonthly: 30000 }, before: { name: 'Фатима', rules: null } }),
    );
    expect(salary.summary).toBe('Правила зарплаты сотрудника «Фатима» с 15 октября: оклад 30 000 ₽ в месяц');
  });

  it('describes payroll adjustments added and removed', () => {
    const adjustment = {
      id: 5, employee: { id: 3, name: 'Фатима', color: '#FF7A1A' }, date: '2026-10-15', kind: 'advance', amount: 20000,
      note: 'Аванс', cashOperationId: 31, createdBy: { id: 1, name: 'Админ', color: '#000000' }, createdAt: '2026-10-15T09:00:00.000Z',
    };
    const added = buildDraft(context({ route: '/payroll/adjustments', path: '/payroll/adjustments', body: { employeeId: 3, kind: 'advance', amount: 20000, fromCash: true }, result: adjustment }));
    expect(added).toEqual({ action: 'payroll.adjustment', entity: 'payroll', entityId: 3, summary: 'Аванс сотруднику «Фатима»: 20 000 ₽, из кассы', changes: null });
    const bonus = buildDraft(context({ route: '/payroll/adjustments', path: '/payroll/adjustments', result: { ...adjustment, kind: 'bonus', cashOperationId: null, note: 'За отзывы' } }));
    expect(bonus.summary).toBe('Премия сотруднику «Фатима»: 20 000 ₽ — За отзывы');
    const removed = buildDraft(
      context({ method: 'DELETE', route: '/payroll/adjustments/:id', path: '/payroll/adjustments/5', params: { id: '5' }, before: adjustment }),
    );
    expect(removed).toEqual({
      action: 'payroll.adjustment_delete',
      entity: 'payroll',
      entityId: 3,
      summary: 'Удалена запись зарплаты: аванс 20 000 ₽, сотрудник «Фатима»',
      changes: null,
    });
  });

  it('names a new role in the dative when the name allows it', () => {
    const employee = { id: 3, name: 'Фатима', login: 'fatima', phone: null, color: '#FF7A1A', isMaster: true, role: 'admin', active: true };
    const patch = (name: string, body: object) =>
      buildDraft(
        context({
          method: 'PATCH', route: '/employees/:id', path: '/employees/3', params: { id: '3' }, body,
          before: { ...employee, name }, result: { ...employee, name, role: 'master' },
        }),
      );
    expect(patch('Фатима', { role: 'master' })).toMatchObject({
      action: 'employee.role',
      summary: 'Фатиме назначена роль «Мастер»',
      changes: { role: { from: 'admin', to: 'master' } },
    });
    expect(patch('Нинель', { role: 'master', password: 'x' }).summary).toBe('Роль сотрудника «Нинель»: Администратор → Мастер; также изменено: пароль');
  });
});

describe('default audit entries', () => {
  it('gives an unknown route an entry from its path', () => {
    const c = context({ method: 'PUT', route: '/gift-cards/:id', path: '/gift-cards/12', params: { id: '12' } });
    expect(defaultDraft(c)).toEqual({ action: 'gift-card.update', entity: 'gift-card', entityId: 12, summary: 'Изменение: PUT /gift-cards/12' });
    expect(buildDraft({ ...c, before: { id: 12, title: 'А' }, result: { id: 12, title: 'Б' } }).changes).toEqual({ title: { from: 'А', to: 'Б' } });
    expect(defaultDraft(context({ method: 'POST', route: '/catalog/categories/order', path: '/catalog/categories/order' }))).toMatchObject({
      action: 'category.create',
      entity: 'category',
      entityId: null,
    });
  });

  it('falls back to the default entry when a summary cannot be built', () => {
    const draft = buildDraft(context({ method: 'PATCH', route: '/appointments/:id', path: '/appointments/5', params: { id: '5' }, result: { ok: true } }));
    expect(draft).toMatchObject({ action: 'appointment.update', entity: 'appointment', entityId: 5, summary: 'Изменение: PATCH /appointments/5' });
  });
});

describe('audit wording helpers', () => {
  it('puts first names in the dative only when sure', () => {
    expect(['Фатима', 'Мария', 'Иван', 'Андрей', 'Илья', 'Алеся'].map(dativeName)).toEqual(['Фатиме', 'Марии', 'Ивану', 'Андрею', 'Илье', 'Алесе']);
    expect(['Игорь', 'Anna', 'Анна Иванова', 'Нелли', ''].map(dativeName)).toEqual([null, null, null, null, null]);
  });

  it('writes a weekly schedule compactly and date ranges', () => {
    const a = { start: '11:00', end: '20:00', breaks: [] };
    const b = { start: '12:00', end: '21:00' };
    expect(weeklyText(null)).toBe('часы студии каждый день');
    expect(weeklyText([a, a, b, null, null, a, a])).toBe('пн–вт 11:00–20:00, ср 12:00–21:00, чт–пт выходной, сб–вс 11:00–20:00');
    expect(formatDayRange('2026-10-23', '2026-10-23', NOW)).toBe('23 октября');
    expect(formatDayRange('2027-01-02', '2027-01-05', NOW)).toBe('2–5 января 2027');
  });

  it('diffs snapshots by changed fields, compacting references and dropping secrets', () => {
    const client = { id: 1, name: 'Анна', lastName: 'Иванова', phone: '+79991234567', telegramLinked: false };
    const before = { id: 4, client, notes: 'a', passwordHash: 'h1', updatedAt: '1', status: 'scheduled' };
    const after = { id: 4, client: { ...client, id: 2, name: 'Борис', lastName: null }, notes: 'x'.repeat(400), passwordHash: 'h2', updatedAt: '2', status: 'scheduled' };
    const changes = diffChanges(before, after);
    expect(Object.keys(changes!)).toEqual(['client', 'notes']);
    expect(changes!.client).toEqual({ from: { id: 1, name: 'Анна Иванова' }, to: { id: 2, name: 'Борис' } });
    expect((changes!.notes!.to as string).length).toBe(300);
    expect(diffChanges(before, { ...before, updatedAt: '3' })).toBeNull();
    expect(diffChanges(undefined, after)).toBeNull();
    expect(scrubSecrets({ a: { token: 't', password: 'p', apiKey: 'k', b: [{ linkToken: 'x', c: 1 }] } })).toEqual({ a: { b: [{ c: 1 }] } });
  });
});
