export const CAPABILITIES = [
  'admin.access',
  'inventory.manage',
  'auctions.manage',
  'users.view',
  'users.manage',
  'finance.view',
  'finance.manage',
  'settlements.manage',
  'content.manage',
  'settings.manage',
  'audit.view',
  'roles.manage',
] as const;

export type Capability = (typeof CAPABILITIES)[number];

export const ROLES = [
  'customer',
  'auction_manager',
  'finance_manager',
  'support_content_manager',
  'super_admin',
] as const;

export type Role = (typeof ROLES)[number];

/**
 * Customers have no admin access. Every staff role is a full admin.
 * The old role names still exist on accounts created earlier; they no longer limit permissions.
 */
export const ROLE_CAPABILITIES: Record<Role, readonly Capability[]> = {
  customer: [],
  auction_manager: CAPABILITIES,
  finance_manager: CAPABILITIES,
  support_content_manager: CAPABILITIES,
  super_admin: CAPABILITIES,
};

export const STAFF_ROLES: readonly Role[] = ROLES.filter((r) => r !== 'customer');

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

export function capabilitiesFor(roles: readonly Role[]): Set<Capability> {
  const set = new Set<Capability>();
  for (const role of roles) {
    for (const cap of ROLE_CAPABILITIES[role] ?? []) set.add(cap);
  }
  return set;
}

export function isStaff(roles: readonly Role[]): boolean {
  return roles.some((role) => role !== 'customer');
}
