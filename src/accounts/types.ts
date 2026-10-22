// Accounts per tool (M8-3 §2.1). Metadata only: NOTHING here is secret, and nothing here is a path.
import type { ProviderId } from '../agents/providers/types.ts';
export type { LimitRule } from './limit-rule.ts';

/** id matches M8-1 ACCOUNT_RE (and `^<provider>-[a-z0-9-]+$` for named ones); name is cleaned, ≤ 40 code points. */
export interface AccountMeta {
  id: string;
  name: string;
}
/** Ordered (index 0 first); `default` is always present exactly once per tool. */
export type Accounts = Record<ProviderId, AccountMeta[]>;
/** What travels to providers: never a path, never a secret. */
export interface AccountRef {
  provider: ProviderId;
  id: string;
}
export const DEFAULT_ACCOUNT = 'default';
export const accountKey = (r: AccountRef): string => `${r.provider}:${r.id}`;
export const defaultRef = (provider: ProviderId): AccountRef => ({ provider, id: DEFAULT_ACCOUNT });
export const MAX_ACCOUNTS_PER_TOOL = 8;
export const ACCOUNT_NAME_MAX = 40;
