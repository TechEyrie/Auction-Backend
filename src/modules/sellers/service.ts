import { ObjectId, type Db } from 'mongodb';
import type { Logger } from '../../shared/logger.ts';
import { AppError, conflict, notFound } from '../../shared/errors.ts';
import { duplicateKeyIndex, isDuplicateKeyError } from '../../shared/mongoErrors.ts';
import { randomToken } from '../../shared/crypto.ts';
import { normalizeEmail, normalizePhoneE164 } from '../../shared/normalize.ts';
import { recordAudit } from '../audit/repository.ts';
import type { Capability } from '../auth/roles.ts';
import { toAdminSellerDto, toPublicSellerDto, type AdminSellerDto, type PublicSellerDto } from './dto.ts';
import type {
  SellerAddress,
  SellerContact,
  SellerDoc,
  SellerEvidence,
  SellerSettlement,
  SellerType,
  SellerVerificationState,
  SellerWithId,
} from './models.ts';
import * as repo from './repository.ts';

export type SellerInput = {
  type: SellerType;
  displayName: string;
  legalName?: string | null;
  contact: { contactName?: string | null; phone: string; email?: string | null };
  address?: {
    line1?: string | null;
    line2?: string | null;
    locationKey?: string | null;
    postalCode?: string | null;
    publicPrecision?: SellerAddress['publicPrecision'];
  };
  internalNotes?: string | null;
  linkedUserReference?: string | null;
  settlement?: {
    method?: SellerSettlement['method'];
    accountName?: string | null;
    bankName?: string | null;
    iban?: string | null;
    notes?: string | null;
  };
};

export type SellerServiceDeps = { db: Db; logger: Logger };

function normalizeName(value: string): string {
  return String(value ?? '').trim().replace(/\s+/g, ' ');
}

function slugKey(value: string): string {
  return normalizeName(value).toLowerCase();
}

function assertDisplayName(value: string): string {
  const name = normalizeName(value);
  if (name.length < 2 || name.length > 160) {
    throw new AppError('VALIDATION_ERROR', 'Enter a valid seller name', {
      fieldErrors: { displayName: 'must be 2-160 characters' },
    });
  }
  return name;
}

function assertIban(value: string | null | undefined): string | null {
  const raw = String(value ?? '').replace(/\s+/g, '').toUpperCase();
  if (!raw) return null;
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(raw)) {
    throw new AppError('VALIDATION_ERROR', 'Enter a valid IBAN', {
      fieldErrors: { iban: 'invalid IBAN' },
    });
  }
  return raw;
}

/**
 * Server-side normalization. Everything used for uniqueness, storage or display is
 * derived here so a client cannot smuggle a second representation of the same value.
 */
function buildContact(input: SellerInput['contact']): SellerContact {
  const phone = normalizePhoneE164(input.phone);
  return {
    contactName: input.contactName ? normalizeName(input.contactName) : null,
    phone,
    phoneNormalized: phone,
    email: normalizeEmail(input.email ?? null),
    phoneKey: phone,
  };
}

function buildAddress(input: SellerInput['address']): SellerAddress {
  const precision = input?.publicPrecision ?? 'hidden';
  if (!['hidden', 'city', 'exact'].includes(precision)) {
    throw new AppError('VALIDATION_ERROR', 'Invalid public precision', {
      fieldErrors: { publicPrecision: 'must be hidden, city or exact' },
    });
  }
  return {
    line1: input?.line1 ? normalizeName(input.line1) : null,
    line2: input?.line2 ? normalizeName(input.line2) : null,
    locationKey: input?.locationKey ? String(input.locationKey).trim() : null,
    postalCode: input?.postalCode ? String(input.postalCode).trim() : null,
    publicPrecision: precision,
  };
}

export function createSellerService(deps: SellerServiceDeps) {
  const { db, logger } = deps;

  async function resolveLinkedUser(reference: string | null | undefined): Promise<ObjectId | null> {
    if (!reference) return null;
    const user = await db.collection('users').findOne({ publicReference: reference });
    if (!user) {
      throw new AppError('VALIDATION_ERROR', 'Linked user does not exist', {
        fieldErrors: { linkedUserReference: 'unknown user' },
      });
    }
    // Linking never creates an account; the reference must already exist.
    return user._id as ObjectId;
  }

  return {
    async create(input: SellerInput, actor: { reference: string; requestId: string }): Promise<SellerWithId> {
      const displayName = assertDisplayName(input.displayName);
      const legalName = input.legalName ? normalizeName(input.legalName) : null;
      if (input.type === 'company' && !legalName) {
        throw new AppError('VALIDATION_ERROR', 'Company sellers need a legal name', {
          fieldErrors: { legalName: 'required for company sellers' },
        });
      }
      const now = new Date();
      const doc: SellerDoc = {
        sellerReference: `s_${randomToken(9)}`,
        type: input.type,
        displayName,
        displayNameNormalized: slugKey(displayName),
        legalName,
        legalNameNormalized: legalName ? slugKey(legalName) : null,
        contact: buildContact(input.contact),
        address: buildAddress(input.address),
        status: 'active',
        verification: { state: 'unverified', evidence: [], lastActor: null, lastChangedAt: null, rejectionReason: null },
        settlement: {
          method: input.settlement?.method ?? 'not_set',
          accountName: input.settlement?.accountName ? normalizeName(input.settlement.accountName) : null,
          bankName: input.settlement?.bankName ? normalizeName(input.settlement.bankName) : null,
          iban: assertIban(input.settlement?.iban),
          notes: input.settlement?.notes ?? null,
          updatedAt: input.settlement ? now : null,
          updatedBy: input.settlement ? actor.reference : null,
        },
        internalNotes: input.internalNotes ?? null,
        linkedUserId: await resolveLinkedUser(input.linkedUserReference),
        // Company identity duplication guard: same legal name twice is a data-entry mistake.
        identityKey: input.type === 'company' && legalName ? `company:${slugKey(legalName)}` : null,
        createdBy: actor.reference,
        updatedBy: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
      };

      let created: SellerWithId;
      try {
        created = await repo.insertSeller(db, doc);
      } catch (err) {
        if (isDuplicateKeyError(err)) {
          const index = duplicateKeyIndex(err) ?? '';
          const message = index.includes('phone')
            ? 'A seller with this phone number already exists'
            : index.includes('identity')
              ? 'A company seller with this identity already exists'
              : index.includes('linked_user')
                ? 'This user account is already linked to another seller'
                : 'That seller already exists';
          throw conflict(message, { index });
        }
        throw err;
      }

      // Settlement details are sensitive: record a settlement audit entry, not the values.
      if (input.settlement) {
        await recordAudit(db, {
          actorId: actor.reference,
          action: 'seller.settlement.updated',
          targetType: 'seller',
          targetId: created.sellerReference,
          requestId: actor.requestId,
          changeSummary: { method: created.settlement.method, ibanSet: created.settlement.iban !== null },
          reason: 'settlement details provided at creation',
        });
      }
      await recordAudit(db, {
        actorId: actor.reference,
        action: 'seller.created',
        targetType: 'seller',
        targetId: created.sellerReference,
        requestId: actor.requestId,
        changeSummary: { type: created.type, status: created.status, linkedUser: created.linkedUserId !== null },
        reason: null,
      });
      logger.info('seller created', { sellerReference: created.sellerReference, type: created.type });
      return created;
    },

    async list(query: repo.SellerListQuery): Promise<repo.Paged<SellerWithId>> {
      return repo.listSellers(db, query);
    },

    async get(reference: string): Promise<SellerWithId> {
      const seller = await repo.findSellerByReference(db, reference);
      if (!seller) throw notFound('Seller not found');
      return seller;
    },

    async getPublic(reference: string): Promise<PublicSellerDto> {
      const seller = await this.get(reference);
      if (seller.status === 'archived') throw notFound('Seller not found');
      return toPublicSellerDto(seller);
    },

    async update(
      reference: string,
      input: Partial<SellerInput>,
      actor: { reference: string; requestId: string },
    ): Promise<SellerWithId> {
      const current = await this.get(reference);
      const patch: Partial<SellerDoc> = { updatedAt: new Date(), updatedBy: actor.reference };

      if (input.displayName !== undefined) {
        const displayName = assertDisplayName(input.displayName);
        patch.displayName = displayName;
        patch.displayNameNormalized = slugKey(displayName);
      }
      if (input.legalName !== undefined) {
        const legalName = input.legalName ? normalizeName(input.legalName) : null;
        patch.legalName = legalName;
        patch.legalNameNormalized = legalName ? slugKey(legalName) : null;
        if (current.type === 'company' && !legalName) {
          throw new AppError('VALIDATION_ERROR', 'Company sellers need a legal name', {
            fieldErrors: { legalName: 'required for company sellers' },
          });
        }
        patch.identityKey = current.type === 'company' && legalName ? `company:${slugKey(legalName)}` : null;
      }
      if (input.contact) patch.contact = buildContact(input.contact);
      if (input.address) patch.address = buildAddress(input.address);
      if (input.internalNotes !== undefined) patch.internalNotes = input.internalNotes;
      if (input.linkedUserReference !== undefined) {
        patch.linkedUserId = await resolveLinkedUser(input.linkedUserReference);
      }
      if (input.type !== undefined && input.type !== current.type) {
        // Changing the legal shape of a seller rewrites its identity key; keep them consistent.
        const legalName = input.legalName !== undefined ? input.legalName : current.legalName;
        if (input.type === 'company' && !legalName) {
          throw new AppError('VALIDATION_ERROR', 'Company sellers need a legal name', {
            fieldErrors: { legalName: 'required for company sellers' },
          });
        }
        patch.type = input.type;
        patch.identityKey = input.type === 'company' && legalName ? `company:${slugKey(legalName)}` : null;
      }
      if (input.settlement) {
        patch.settlement = {
          method: input.settlement.method ?? current.settlement.method,
          accountName: input.settlement.accountName === undefined
            ? current.settlement.accountName
            : (input.settlement.accountName ? normalizeName(input.settlement.accountName) : null),
          bankName: input.settlement.bankName === undefined
            ? current.settlement.bankName
            : (input.settlement.bankName ? normalizeName(input.settlement.bankName) : null),
          iban: input.settlement.iban === undefined ? current.settlement.iban : assertIban(input.settlement.iban),
          notes: input.settlement.notes === undefined ? current.settlement.notes : input.settlement.notes,
          updatedAt: new Date(),
          updatedBy: actor.reference,
        };
      }

      let updated: SellerWithId | null;
      try {
        updated = await repo.updateSeller(db, reference, patch);
      } catch (err) {
        if (isDuplicateKeyError(err)) {
          throw conflict('That change collides with an existing seller record', { index: duplicateKeyIndex(err) });
        }
        throw err;
      }
      if (!updated) throw notFound('Seller not found');

      if (input.settlement) {
        await recordAudit(db, {
          actorId: actor.reference,
          action: 'seller.settlement.updated',
          targetType: 'seller',
          targetId: reference,
          requestId: actor.requestId,
          changeSummary: { method: updated.settlement.method, ibanSet: updated.settlement.iban !== null },
          reason: 'settlement instructions changed',
        });
      }
      await recordAudit(db, {
        actorId: actor.reference,
        action: 'seller.updated',
        targetType: 'seller',
        targetId: reference,
        requestId: actor.requestId,
        // Field names only — values may contain private contact data.
        changeSummary: { fields: Object.keys(patch).filter((k) => k !== 'updatedAt' && k !== 'updatedBy') },
        reason: null,
      });
      return updated;
    },

    async setVerification(
      reference: string,
      input: {
        state: SellerVerificationState;
        reason: string;
        evidence?: Array<{ kind: string; reference: string; note?: string | null }>;
      },
      actor: { reference: string; requestId: string },
    ): Promise<SellerWithId> {
      const current = await this.get(reference);
      if (input.state === 'verified' && current.verification.evidence.length === 0 && !(input.evidence && input.evidence.length > 0)) {
        throw new AppError('VALIDATION_ERROR', 'Verification needs at least one evidence reference', {
          fieldErrors: { evidence: 'required' },
        });
      }
      const now = new Date();
      const evidence: SellerEvidence[] = [
        ...current.verification.evidence,
        ...(input.evidence ?? []).map((e) => ({
          kind: e.kind,
          reference: e.reference,
          note: e.note ?? null,
          addedAt: now,
          addedBy: actor.reference,
        })),
      ];
      const updated = await repo.updateSeller(db, reference, {
        verification: {
          state: input.state,
          evidence,
          lastActor: actor.reference,
          lastChangedAt: now,
          rejectionReason: input.state === 'rejected' ? input.reason : null,
        },
        updatedAt: now,
        updatedBy: actor.reference,
      });
      if (!updated) throw notFound('Seller not found');
      await recordAudit(db, {
        actorId: actor.reference,
        action: 'seller.verification.changed',
        targetType: 'seller',
        targetId: reference,
        requestId: actor.requestId,
        changeSummary: { from: current.verification.state, to: input.state, evidenceAdded: (input.evidence ?? []).length },
        reason: input.reason,
      });
      return updated;
    },

    async setStatus(
      reference: string,
      status: SellerDoc['status'],
      reason: string,
      actor: { reference: string; requestId: string },
    ): Promise<SellerWithId> {
      const current = await this.get(reference);
      const now = new Date();
      const updated = await repo.updateSeller(db, reference, {
        status,
        // Archiving is reversible state, never a delete: history and references survive.
        archivedAt: status === 'archived' ? now : null,
        updatedAt: now,
        updatedBy: actor.reference,
      });
      if (!updated) throw notFound('Seller not found');
      await recordAudit(db, {
        actorId: actor.reference,
        action: status === 'archived' ? 'seller.archived' : 'seller.status.changed',
        targetType: 'seller',
        targetId: reference,
        requestId: actor.requestId,
        changeSummary: { from: current.status, to: status },
        reason,
      });
      return updated;
    },

    toAdminDto(seller: SellerWithId, capabilities: ReadonlySet<Capability>): AdminSellerDto {
      return toAdminSellerDto(seller, capabilities);
    },

    toPublicDto(seller: SellerWithId): PublicSellerDto {
      return toPublicSellerDto(seller);
    },
  };
}

export type SellerService = ReturnType<typeof createSellerService>;
