import type { Db, IndexDescription } from 'mongodb';

export const COLLECTIONS = {
  auditLogs: 'audit_logs',
  idempotencyRecords: 'idempotency_records',
  outboxEvents: 'outbox_events',
  durableJobs: 'durable_jobs',
  users: 'users',
  sessions: 'sessions',
  verificationChallenges: 'verification_challenges',
  rateLimits: 'rate_limits',
  systemCounters: 'system_counters',
  sellers: 'sellers',
  categories: 'categories',
  attributeSchemas: 'category_attribute_schemas',
  locations: 'locations',
  mediaAssets: 'media_assets',
  mediaReferences: 'media_references',
  listings: 'listings',
  auctions: 'auctions',
  bids: 'bids',
  orders: 'orders',
  financialEntries: 'financial_entries',
  enquiries: 'enquiries',
  emailLogs: 'email_logs',
  contentDocuments: 'content_documents',
} as const;

export type CollectionName = (typeof COLLECTIONS)[keyof typeof COLLECTIONS];

/**
 * Index specifications per collection. Documented here once so behaviour is
 * provable in tests and reproducible via `npm run indexes`.
 *
 * TTL indexes below are cleanup only. Session expiry is always checked in the
 * request path — a TTL delete is never an authorization mechanism.
 */
export const INDEX_SPECS: Record<CollectionName, IndexDescription[]> = {
  [COLLECTIONS.auditLogs]: [
    { key: { requestId: 1 }, name: 'rq_request_id' },
    { key: { targetType: 1, targetId: 1, timestamp: -1 }, name: 'rq_target' },
    { key: { actorId: 1, timestamp: -1 }, name: 'rq_actor' },
    { key: { timestamp: -1 }, name: 'rq_recent' },
  ],
  [COLLECTIONS.idempotencyRecords]: [
    { key: { scope: 1, actorId: 1, key: 1 }, name: 'uniq_scope_actor_key', unique: true },
    { key: { expiresAt: 1 }, name: 'ttl_expiry', expireAfterSeconds: 0 },
  ],
  [COLLECTIONS.outboxEvents]: [
    { key: { eventId: 1 }, name: 'uniq_event_id', unique: true },
    { key: { status: 1, runAfter: 1 }, name: 'rq_dispatchable' },
    { key: { aggregateType: 1, aggregateId: 1, aggregateVersion: 1 }, name: 'rq_aggregate_version' },
  ],
  [COLLECTIONS.durableJobs]: [
    { key: { type: 1, key: 1 }, name: 'uniq_type_key', unique: true },
    { key: { state: 1, runAfter: 1 }, name: 'rq_job_claim' },
    { key: { leaseUntil: 1 }, name: 'rq_job_lease' },
  ],
  [COLLECTIONS.users]: [
    {
      key: { phoneE164: 1 },
      name: 'uniq_phone',
      unique: true,
      partialFilterExpression: { phoneE164: { $type: 'string' } },
    },
    {
      key: { emailNormalized: 1 },
      name: 'uniq_email_present',
      unique: true,
      partialFilterExpression: { emailNormalized: { $type: 'string' } },
    },
    { key: { publicReference: 1 }, name: 'uniq_public_ref', unique: true },
    { key: { status: 1, createdAt: -1 }, name: 'rq_status_recent' },
    { key: { roles: 1 }, name: 'rq_roles' },
  ],
  [COLLECTIONS.sessions]: [
    { key: { tokenHash: 1 }, name: 'uniq_token_hash', unique: true },
    { key: { userId: 1, revokedAt: 1 }, name: 'rq_user_active' },
    { key: { absoluteExpiresAt: 1 }, name: 'ttl_absolute_expiry', expireAfterSeconds: 0 },
  ],
  [COLLECTIONS.verificationChallenges]: [
    { key: { tokenHash: 1 }, name: 'uniq_challenge_token', unique: true },
    { key: { userId: 1, purpose: 1, createdAt: -1 }, name: 'rq_user_purpose' },
    { key: { expiresAt: 1 }, name: 'ttl_challenge_expiry', expireAfterSeconds: 0 },
  ],
  [COLLECTIONS.rateLimits]: [{ key: { expiresAt: 1 }, name: 'ttl_rate_window', expireAfterSeconds: 0 }],
  [COLLECTIONS.systemCounters]: [],
  [COLLECTIONS.sellers]: [
    { key: { sellerReference: 1 }, name: 'uniq_seller_ref', unique: true },
    // Duplicate protection is a unique index, not a read-then-write check (that races).
    {
      key: { 'contact.phoneNormalized': 1 },
      name: 'uniq_seller_phone',
      unique: true,
      partialFilterExpression: { 'contact.phoneNormalized': { $type: 'string' } },
    },
    {
      key: { identityKey: 1 },
      name: 'uniq_seller_identity',
      unique: true,
      partialFilterExpression: { identityKey: { $type: 'string' } },
    },
    {
      key: { linkedUserId: 1 },
      name: 'uniq_seller_linked_user',
      unique: true,
      // `$exists: true` would also match the explicit null every offline seller stores,
      // making the index allow exactly one unlinked seller. Match a real ObjectId only.
      partialFilterExpression: { linkedUserId: { $type: 'objectId' } },
    },
    { key: { status: 1, createdAt: -1 }, name: 'rq_seller_status_recent' },
    { key: { displayNameNormalized: 1 }, name: 'rq_seller_name' },
  ],
  [COLLECTIONS.categories]: [
    { key: { key: 1 }, name: 'uniq_category_key', unique: true },
    { key: { parentKey: 1, order: 1 }, name: 'rq_category_parent_order' },
    { key: { active: 1, order: 1 }, name: 'rq_category_active' },
    { key: { ancestors: 1 }, name: 'rq_category_ancestors' },
  ],
  [COLLECTIONS.attributeSchemas]: [
    { key: { categoryId: 1, version: 1 }, name: 'uniq_schema_category_version', unique: true },
    { key: { categoryId: 1, status: 1 }, name: 'rq_schema_category_status' },
    { key: { 'fields.key': 1 }, name: 'rq_schema_field_key' },
  ],
  [COLLECTIONS.locations]: [
    { key: { key: 1 }, name: 'uniq_location_key', unique: true },
    { key: { countryCode: 1, cityKey: 1, areaKey: 1 }, name: 'uniq_location_geo', unique: true },
    { key: { countryCode: 1, cityKey: 1, active: 1 }, name: 'rq_location_city' },
  ],
  [COLLECTIONS.mediaAssets]: [
    { key: { assetId: 1 }, name: 'uniq_media_asset_id', unique: true },
    // Only finalised objects have a storage key. Rejected/failed uploads store an
    // explicit null, so the index must match real strings only — otherwise the
    // second rejected upload would collide and fail the request.
    {
      key: { storageKey: 1 },
      name: 'uniq_media_storage_key',
      unique: true,
      partialFilterExpression: { storageKey: { $type: 'string' } },
    },
    { key: { collectionKey: 1, position: 1 }, name: 'rq_media_collection_order' },
    { key: { status: 1, createdAt: -1 }, name: 'rq_media_status_recent' },
    { key: { checksum: 1 }, name: 'rq_media_checksum' },
  ],
  [COLLECTIONS.mediaReferences]: [
    { key: { assetId: 1, ownerType: 1, ownerId: 1 }, name: 'uniq_media_reference', unique: true },
    { key: { ownerType: 1, ownerId: 1 }, name: 'rq_media_owner' },
  ],
  [COLLECTIONS.listings]: [
    { key: { listingReference: 1 }, name: 'uniq_listing_reference', unique: true },
    {
      key: { slug: 1 },
      name: 'uniq_listing_slug',
      unique: true,
      partialFilterExpression: { slug: { $type: 'string' } },
    },
    // Public discovery: the visibility filter, then the deterministic sort tie-breaker.
    { key: { status: 1, 'moderation.state': 1, publishedAt: -1, listingReference: 1 }, name: 'rq_listing_public' },
    { key: { status: 1, audience: 1, publishedAt: -1 }, name: 'rq_listing_audience' },
    { key: { categoryPath: 1, status: 1 }, name: 'rq_listing_category' },
    { key: { listingMethod: 1, status: 1 }, name: 'rq_listing_method' },
    { key: { 'location.countryCode': 1, 'location.cityKey': 1, status: 1 }, name: 'rq_listing_location' },
    { key: { 'featured.featured': -1, 'featured.order': 1 }, name: 'rq_listing_featured' },
    { key: { sellerReference: 1, updatedAt: -1 }, name: 'rq_listing_seller' },
    { key: { updatedAt: -1, listingReference: 1 }, name: 'rq_listing_recent' },
    // Substring search keeps the first characters of an English title cheap; see the documented
    // search limitation (no Arabic-language text index exists in MongoDB).
    { key: { 'title.en': 1 }, name: 'rq_listing_title_en' },
  ],
  [COLLECTIONS.auctions]: [
    { key: { lotReference: 1 }, name: 'uniq_lot', unique: true },
    { key: { listingReference: 1 }, name: 'rq_auction_listing' },
    { key: { status: 1, startsAt: 1 }, name: 'rq_auction_start' },
    { key: { status: 1, endsAt: 1 }, name: 'rq_auction_end' },
    { key: { winningUserReference: 1 }, name: 'rq_auction_winner' },
    { key: { orderReference: 1 }, name: 'uniq_winning_order', unique: true, partialFilterExpression: { orderReference: { $type: 'string' } } },
  ],
  [COLLECTIONS.bids]: [
    { key: { auctionId: 1, sequence: 1 }, name: 'uniq_auction_sequence', unique: true },
    { key: { auctionId: 1, acceptedAt: -1, _id: -1 }, name: 'rq_bid_timeline' },
    { key: { userReference: 1, acceptedAt: -1 }, name: 'rq_bid_user' },
    { key: { idempotencyKey: 1, userReference: 1 }, name: 'uniq_bid_idem', unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } },
  ],
  [COLLECTIONS.orders]: [
    { key: { orderReference: 1 }, name: 'uniq_order', unique: true },
    {
      key: { lotReference: 1 },
      name: 'uniq_order_lot',
      unique: true,
      partialFilterExpression: { lotReference: { $type: 'string' } },
    },
    { key: { winnerUserReference: 1, createdAt: -1 }, name: 'rq_order_winner' },
  ],
  [COLLECTIONS.financialEntries]: [
    { key: { eventId: 1 }, name: 'uniq_financial_event', unique: true },
    { key: { orderReference: 1 }, name: 'rq_financial_order' },
  ],
  [COLLECTIONS.enquiries]: [
    { key: { reference: 1 }, name: 'uniq_enquiry', unique: true },
  ],
  [COLLECTIONS.emailLogs]: [
    { key: { createdAt: -1 }, name: 'rq_email_log_recent' },
    { key: { to: 1, createdAt: -1 }, name: 'rq_email_log_to_recent' },
  ],
  [COLLECTIONS.contentDocuments]: [
    { key: { key: 1 }, name: 'uniq_content_key', unique: true },
  ],
};

/** Create/refresh all indexes. Idempotent; safe to run repeatedly. */
export async function ensureIndexes(db: Db): Promise<void> {
  for (const name of Object.values(COLLECTIONS)) {
    const specs = INDEX_SPECS[name];
    // Collections such as system_counters rely on the default _id index only.
    if (specs.length === 0) continue;
    const collection = db.collection(name);
    if (name === COLLECTIONS.users) {
      const current = await collection.indexes().catch((err: { code?: number }) => (err.code === 26 ? [] : Promise.reject(err)));
      const phone = current.find((index) => index.name === 'uniq_phone');
      if (phone && !phone.partialFilterExpression) await collection.dropIndex('uniq_phone');
    }
    if (name === COLLECTIONS.orders) {
      const current = await collection.indexes().catch((err: { code?: number }) => (err.code === 26 ? [] : Promise.reject(err)));
      const lot = current.find((index) => index.name === 'uniq_order_lot');
      if (lot && !lot.partialFilterExpression) await collection.dropIndex('uniq_order_lot');
    }
    await collection.createIndexes(specs);
  }
}
