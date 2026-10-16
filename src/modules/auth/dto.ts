import type { Capability } from './roles.ts';
import { capabilitiesFor, STAFF_ROLES } from './roles.ts';
import type { UserDoc } from './models.ts';

/** Public/customer view. Never includes passwordHash, MFA secret, or recovery hashes. */
export type UserDto = {
  publicReference: string;
  fullName: string;
  phone: string | null;
  email: string | null;
  status: UserDoc['status'];
  roles: UserDoc['roles'];
  preferredLocale: string;
  phoneVerified: boolean;
  emailVerified: boolean;
  termsVersion: string | null;
  createdAt: string;
  lastLoginAt: string | null;
};

/** Admin view: adds suspension metadata. Still no secrets. */
export type AdminUserDto = UserDto & {
  capabilities: Capability[];
  mfaEnabled: boolean;
  suspension: UserDoc['suspension'];
};

export function toUserDto(user: UserDoc): UserDto {
  return {
    publicReference: user.publicReference,
    fullName: user.fullName,
    phone: user.phoneE164,
    email: user.emailNormalized,
    status: user.status,
    roles: user.roles,
    preferredLocale: user.preferredLocale,
    phoneVerified: user.phoneVerifiedAt !== null,
    emailVerified: user.emailVerifiedAt !== null,
    termsVersion: user.termsVersion,
    createdAt: user.createdAt.toISOString(),
    lastLoginAt: user.lastLoginAt ? user.lastLoginAt.toISOString() : null,
  };
}

export function toAdminUserDto(user: UserDoc): AdminUserDto {
  return {
    ...toUserDto(user),
    capabilities: [...capabilitiesFor(user.roles)],
    mfaEnabled: user.mfa.enabled,
    suspension: user.suspension,
  };
}

export function staffRolesOf(user: UserDoc): boolean {
  return user.roles.some((role) => STAFF_ROLES.includes(role));
}
