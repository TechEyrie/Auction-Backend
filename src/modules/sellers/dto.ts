import type { Capability } from '../auth/roles.ts';
import type { SellerDoc } from './models.ts';

/**
 * Three deliberate views of one seller record:
 *  - public: what a marketplace visitor may see (no contact, address, settlement or notes)
 *  - admin:  the working view for inventory staff (contact/address/verification/notes)
 *  - finance: adds the restricted settlement instructions
 *
 * A DTO is chosen by capability, never by the caller asking for more fields.
 */
export type PublicSellerDto = {
  sellerReference: string;
  type: SellerDoc['type'];
  displayName: string;
  verificationBadge: boolean;
  memberSince: string;
};

export type AdminSellerDto = PublicSellerDto & {
  status: SellerDoc['status'];
  legalName: string | null;
  contact: { contactName: string | null; phone: string; email: string | null };
  address: {
    line1: string | null;
    line2: string | null;
    locationKey: string | null;
    postalCode: string | null;
    publicPrecision: SellerDoc['address']['publicPrecision'];
  };
  verification: {
    state: SellerDoc['verification']['state'];
    evidence: Array<{ kind: string; reference: string; note: string | null; addedAt: string; addedBy: string }>;
    lastActor: string | null;
    lastChangedAt: string | null;
    rejectionReason: string | null;
  };
  internalNotes: string | null;
  linkedUser: boolean;
  /** Null unless the caller holds a settlement/finance capability. */
  settlement: FinanceSellerDto['settlement'] | null;
  createdBy: string;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
};

export type FinanceSellerDto = {
  settlement: {
    method: SellerDoc['settlement']['method'];
    accountName: string | null;
    bankName: string | null;
    /** Masked: the full IBAN is never returned, not even to finance, once stored. */
    ibanMasked: string | null;
    notes: string | null;
    updatedAt: string | null;
    updatedBy: string | null;
  };
};

function maskIban(iban: string | null): string | null {
  if (!iban) return null;
  const compact = iban.replace(/\s+/g, '');
  if (compact.length <= 4) return '••••';
  return `${'•'.repeat(Math.max(0, compact.length - 4))}${compact.slice(-4)}`;
}

export function toPublicSellerDto(seller: SellerDoc): PublicSellerDto {
  return {
    sellerReference: seller.sellerReference,
    type: seller.type,
    displayName: seller.displayName,
    verificationBadge: seller.verification.state === 'verified',
    memberSince: seller.createdAt.toISOString(),
  };
}

export function toFinanceSellerDto(seller: SellerDoc): FinanceSellerDto {
  return {
    settlement: {
      method: seller.settlement.method,
      accountName: seller.settlement.accountName,
      bankName: seller.settlement.bankName,
      ibanMasked: maskIban(seller.settlement.iban),
      notes: seller.settlement.notes,
      updatedAt: seller.settlement.updatedAt ? seller.settlement.updatedAt.toISOString() : null,
      updatedBy: seller.settlement.updatedBy,
    },
  };
}

/** Admin view. Settlement and internal notes are added only for the capabilities that own them. */
export function toAdminSellerDto(seller: SellerDoc, capabilities: ReadonlySet<Capability>): AdminSellerDto {
  const maySeeSettlement = capabilities.has('settlements.manage') || capabilities.has('finance.manage');
  return {
    ...toPublicSellerDto(seller),
    status: seller.status,
    legalName: seller.legalName,
    contact: {
      contactName: seller.contact.contactName,
      phone: seller.contact.phone,
      email: seller.contact.email,
    },
    address: {
      line1: seller.address.line1,
      line2: seller.address.line2,
      locationKey: seller.address.locationKey,
      postalCode: seller.address.postalCode,
      publicPrecision: seller.address.publicPrecision,
    },
    verification: {
      state: seller.verification.state,
      evidence: seller.verification.evidence.map((e) => ({
        kind: e.kind,
        reference: e.reference,
        note: e.note,
        addedAt: e.addedAt.toISOString(),
        addedBy: e.addedBy,
      })),
      lastActor: seller.verification.lastActor,
      lastChangedAt: seller.verification.lastChangedAt ? seller.verification.lastChangedAt.toISOString() : null,
      rejectionReason: seller.verification.rejectionReason,
    },
    // Internal notes are inventory-staff material; finance-only staff do not get them.
    internalNotes: capabilities.has('inventory.manage') ? seller.internalNotes : null,
    linkedUser: seller.linkedUserId !== null,
    settlement: maySeeSettlement ? toFinanceSellerDto(seller).settlement : null,
    createdBy: seller.createdBy,
    updatedBy: seller.updatedBy,
    createdAt: seller.createdAt.toISOString(),
    updatedAt: seller.updatedAt.toISOString(),
    archivedAt: seller.archivedAt ? seller.archivedAt.toISOString() : null,
  };
}
