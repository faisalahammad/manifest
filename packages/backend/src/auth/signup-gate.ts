import { isSelfHosted } from '../common/utils/detect-self-hosted';

/**
 * Whether a new user may be created right now.
 *
 * A self-hosted super admin can close sign-up from the Instance settings page.
 * The flag lives in the database, not in Better Auth's boot-time options, so it
 * changes without a restart and holds on every replica. It is checked from a
 * Better Auth `user.create.before` hook, which every sign-up path runs through
 * (email and password, Google, GitHub, Discord).
 *
 * The very first user is always allowed: the setup wizard creates the admin
 * through the same sign-up call. Cloud never closes sign-up.
 *
 * Leaf module on purpose: Jest cannot load Better Auth's ESM build, so the
 * decision lives here and `auth.instance.ts` only wires it in.
 */
export const SIGNUP_GATE_SQL = `
  SELECT
    EXISTS (SELECT 1 FROM "user") AS has_users,
    (SELECT "signup_enabled" FROM "install_metadata" WHERE "id" = 'singleton') AS signup_enabled
`;

export const SIGNUP_DISABLED_MESSAGE =
  'Sign-up is turned off on this TierGate install. Ask the admin to turn it back on.';

export type SignupGateQuery = (
  sql: string,
) => Promise<Array<{ has_users: boolean | null; signup_enabled: boolean | null }>>;

export async function isSignUpAllowed(query: SignupGateQuery): Promise<boolean> {
  if (!isSelfHosted()) return true;
  const row = (await query(SIGNUP_GATE_SQL))[0];
  if (!row?.has_users) return true;
  return row.signup_enabled !== false;
}
