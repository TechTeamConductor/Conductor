// Roles and their configuration (M2). A role is a job; providers are who may do it, in order.
import type { ProviderId } from './providers/types.ts';

export const ROLES = ['requirements', 'context', 'planning', 'architecture', 'implementation', 'review', 'verification', 'debugging', 'documentation', 'research'] as const;
export type Role = (typeof ROLES)[number];
export type Complexity = 'S' | 'M' | 'L';
export const COMPLEXITIES: readonly Complexity[] = ['S', 'M', 'L'];

/**
 * What a role REQUIRES of a provider. Exhaustive on purpose: adding a role without an entry here does not compile
 * (Security condition 6 — `documentation` writes files, so it is build-class).
 */
export const ROLE_NEEDS: Readonly<Record<Role, { build?: true; research?: true }>> = Object.freeze({
  requirements: {},
  context: {},
  planning: {},
  architecture: {},
  implementation: { build: true },
  review: {},
  verification: {},
  debugging: { build: true },
  documentation: { build: true },
  research: { research: true },
});

export const ROLE_LABEL: Readonly<Record<Role, string>> = Object.freeze({
  requirements: 'Requirements',
  context: 'Context',
  planning: 'Planning',
  architecture: 'Architecture',
  implementation: 'Implementation',
  review: 'Review',
  verification: 'Verification',
  debugging: 'Debugging',
  documentation: 'Documentation',
  research: 'Research',
});

export interface RoleConfig {
  /** Ordered: the first healthy, eligible provider runs; the next ones are the fallbacks. */
  providers: ProviderId[];
  /** Per plan complexity, a provider to try FIRST (never lowers the isolation tier; must itself be eligible). */
  autoByComplexity?: Partial<Record<Complexity, ProviderId>>;
}
export type Roles = Record<Role, RoleConfig>;

export const isRole = (x: unknown): x is Role => typeof x === 'string' && Object.hasOwn(ROLE_NEEDS, x);
export const isComplexity = (x: unknown): x is Complexity => x === 'S' || x === 'M' || x === 'L';

/**
 * Defaults reproduce v1 exactly: Claude plans/reviews/verifies (Cursor takes over read-only stages when Claude is limited — v1's
 * default `onClaudeLimit: 'cursor'`), Cursor builds. Codex is in NO default chain (D8).
 */
export function defaultRoles(opts: { cursorTakesOverReadOnly?: boolean } = {}): Roles {
  const ro: ProviderId[] = opts.cursorTakesOverReadOnly === false ? ['claude'] : ['claude', 'cursor'];
  return {
    requirements: { providers: ['claude'] },
    context: { providers: ['claude'] },
    planning: { providers: [...ro] },
    architecture: { providers: ['claude'] },
    implementation: { providers: ['cursor'] },
    review: { providers: [...ro] },
    verification: { providers: [...ro] },
    debugging: { providers: ['cursor'] },
    documentation: { providers: ['cursor'] },
    research: { providers: ['claude'] },
  };
}
