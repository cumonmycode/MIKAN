import type { Config } from '../config.js';
import type { EmployeeRow } from '../lib/serialize.js';

/**
 * The built-in administrator account (login `ADMIN_LOGIN`, created on first start) is listed only to itself: other
 * employees never see it in staff lists, master pickers or the calendar. Returns a filter for the viewer.
 */
export function visibleTo(
  config: Pick<Config, 'admin'>,
  viewer: Pick<EmployeeRow, 'id'>,
): (employee: Pick<EmployeeRow, 'id' | 'login'>) => boolean {
  const adminLogin = config.admin.login.trim().toLowerCase();
  return (employee) => employee.login !== adminLogin || employee.id === viewer.id;
}
