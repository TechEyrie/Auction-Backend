export type MediaStatus = 'staging' | 'ready' | 'rejected' | 'failed' | 'deleted';

export type MediaAssetDoc = {
  /** Stable public identity. Object keys and signed URLs are never used as identity. */
  assetId: string;
  storageKey: string | null;
  /** Absolute CDN URL when stored on ImageKit; null for local-only objects. */
  publicUrl: string | null;
  /** Where the original bytes wait until validation completes. */
  stagingKey: string | null;
  collectionKey: string;
  position: number;
  isCover: boolean;
  declaredMime: string;
  mime: string | null;
  bytes: number;
  checksum: string | null;
  image: { width: number; height: number } | null;
  status: MediaStatus;
  /** Why an upload was rejected or failed; shown to the operator verbatim. */
  statusReason: string | null;
  metadataStripped: boolean;
  source: 'upload';
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
};

/** A non-expiring link from an asset to whatever owns it (a listing in Phase 05). */
export type MediaReferenceDoc = {
  assetId: string;
  ownerType: string;
  ownerId: string;
  addedAt: Date;
  addedBy: string;
};
