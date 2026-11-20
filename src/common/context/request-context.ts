import { AsyncLocalStorage } from 'async_hooks';

/**
 * The authenticated staff user. Deliberately carries no role name: business
 * rules ask AccessService.can() about permissions, never about roles.
 */
export interface CurrentUser {
  id: number;
  uniqueId: string;
  email: string;
  employeeId: number;
  departmentId: number;
  preferredLocale: string;
  sessionId?: string;
}

interface Context {
  user?: CurrentUser;
  requestId?: string;
  ipAddress?: string;
  /** Set when the action is allowed only through a delegation. */
  onBehalfOfUserId?: number;
}

const storage = new AsyncLocalStorage<Context>();

export const RequestContext = {
  run: (ctx: Context, fn: () => void) => storage.run(ctx, fn),
  get: (): Context | undefined => storage.getStore(),
  getUser: (): CurrentUser | undefined => storage.getStore()?.user,
  // Internal numeric id — matches the createdById/updatedById/deletedById columns.
  getUserId: (): number | undefined => storage.getStore()?.user?.id,
  getUserUniqueId: (): string | undefined => storage.getStore()?.user?.uniqueId,
  getRequestId: (): string | undefined => storage.getStore()?.requestId,
  getIpAddress: (): string | undefined => storage.getStore()?.ipAddress,
  getOnBehalfOf: (): number | undefined => storage.getStore()?.onBehalfOfUserId,
  /** Record that the current action relies on a delegated grant. */
  setOnBehalfOf: (userId: number) => {
    const store = storage.getStore();
    if (store) store.onBehalfOfUserId = userId;
  },
};
