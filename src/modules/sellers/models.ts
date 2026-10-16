import type { ObjectId } from 'mongodb';

export type SellerType = 'individual' | 'company';
export type SellerStatus = 'active' | 'inactive' | 'archived';
export type SellerVerificationState = 'unverified' | 'pending' | 'verified' | 'rejected';

/** Evidence is a reference to a manually checked document; we never store the file itself. */
export type SellerEvidence = { kind: string; reference: string; note: string | null; addedAt: Date; addedBy: string };

/** Private contact details. Never present in a public DTO. */
export type SellerContact = {
  contactName: string | null;
  phone: string;
  phoneNormalized: string;
  email: string | null;
  /** Comparison key for duplicate detection, derived from the phone. */
  phoneKey: string | null;
};

/** Private address. Never present in a public DTO; the public view uses location labels only. */
export type SellerAddress = {
  line1: string | null;
  line2: string | null;
  locationKey: string | null;
  postalCode: string | null;
  /** What public consumers may be shown: never the street line unless explicitly exact. */
  publicPrecision: 'hidden' | 'city' | 'exact';
};

/** Restricted settlement data. Only returned to holders of the settlement capability. */
export type SellerSettlement = {
  method: 'bank_transfer' | 'cheque' | 'cash' | 'not_set';
  accountName: string | null;
  bankName: string | null;
  iban: string | null;
  notes: string | null;
  updatedAt: Date | null;
  updatedBy: string | null;
};

export type SellerDoc = {
  sellerReference: string;
  type: SellerType;
  displayName: string;
  displayNameNormalized: string;
  legalName: string | null;
  legalNameNormalized: string | null;
  contact: SellerContact;
  address: SellerAddress;
  status: SellerStatus;
  verification: {
    state: SellerVerificationState;
    evidence: SellerEvidence[];
    lastActor: string | null;
    lastChangedAt: Date | null;
    rejectionReason: string | null;
  };
  settlement: SellerSettlement;
  /** Internal operations notes. Never in a public or customer DTO. */
  internalNotes: string | null;
  /**
   * Optional link to an existing user account. Linking never creates an account and
   * an offline seller is a first-class record without one.
   */
  linkedUserId: ObjectId | null;
  /** Company identity key (normalized legal name + country); null for individuals. */
  identityKey: string | null;
  createdBy: string;
  updatedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
  archivedAt: Date | null;
};

export type SellerWithId = SellerDoc & { _id: ObjectId };
