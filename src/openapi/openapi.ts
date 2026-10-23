export type OpenApiDocument = {
  openapi: string;
  info: { title: string; version: string; description?: string };
  paths: Record<string, Record<string, unknown>>;
  components?: Record<string, unknown>;
};

const errorResponse = {
  description: 'Standard error envelope',
  content: {
    'application/json': {
      schema: {
        type: 'object',
        required: ['error'],
        properties: {
          error: {
            type: 'object',
            required: ['code', 'message', 'fieldErrors', 'requestId', 'details'],
            properties: {
              code: { type: 'string' },
              message: { type: 'string' },
              fieldErrors: { type: 'object' },
              requestId: { type: 'string' },
              details: { type: 'object' },
            },
          },
        },
      },
    },
  },
} as const;

/** Foundation document. Later phases add their module paths here. */
export const openApiDocument: OpenApiDocument = {
  openapi: '3.1.0',
  info: {
    title: 'Araq & Kahraman Auctions API',
    version: '0.1.0',
    description: 'Backend foundation endpoints. Business endpoints are added in later phases.',
  },
  paths: {
    '/healthz': {
      get: {
        summary: 'Liveness probe',
        responses: {
          '200': { description: 'Process is up' },
        },
      },
    },
    '/readyz': {
      get: {
        summary: 'Readiness probe (checks MongoDB)',
        responses: {
          '200': { description: 'Ready' },
          '503': { description: 'A dependency is unavailable' },
        },
      },
    },
    '/api/openapi.json': {
      get: {
        summary: 'This OpenAPI document',
        responses: {
          '200': { description: 'OpenAPI 3.1 document' },
        },
      },
    },

    // ---- Phase 03: identity, session and administration ----
    '/api/auth/session': {
      get: {
        summary: 'Current session (also issues the CSRF cookie)',
        responses: { '200': { description: 'Session, capabilities and CSRF token' } },
      },
    },
    '/api/auth/register': {
      post: {
        summary: 'Register a customer account (verification email only; no session)',
        responses: {
          '201': { description: 'Account created' },
          '422': errorResponse,
        },
      },
    },
    '/api/auth/login': {
      post: {
        summary: 'Sign in',
        responses: {
          '200': { description: 'Session issued; loginOtpSent when email OTP is required' },
          '401': errorResponse,
          '422': errorResponse,
        },
      },
    },
    '/api/auth/login/otp': {
      post: {
        summary: 'Complete sign-in with the emailed 6-digit login OTP',
        responses: { '200': { description: 'MFA satisfied; session rotated' }, '422': errorResponse },
      },
    },
    '/api/auth/login/otp/resend': {
      post: {
        summary: 'Resend the login OTP email',
        responses: { '200': { description: 'New code sent' }, '422': errorResponse, '429': errorResponse },
      },
    },
    '/api/auth/logout': {
      post: { summary: 'Sign out', responses: { '200': { description: 'Session revoked' }, '403': errorResponse } },
    },
    '/api/auth/email/verify': {
      post: {
        summary: 'Verify email with a one-time token from the registration email',
        responses: { '200': { description: 'Email verified' }, '422': errorResponse, '429': errorResponse },
      },
    },
    '/api/auth/email/resend': {
      post: {
        summary: 'Resend the email verification message (authenticated or public body.email)',
        responses: { '200': { description: 'Verification email sent' }, '409': errorResponse, '403': errorResponse },
      },
    },
    '/api/auth/mfa/enroll': {
      post: { summary: 'Begin MFA enrollment', responses: { '200': { description: 'TOTP secret' }, '403': errorResponse, '409': errorResponse } },
    },
    '/api/auth/mfa/enroll/confirm': {
      post: { summary: 'Confirm MFA enrollment with a TOTP code', responses: { '200': { description: 'MFA enabled' }, '422': errorResponse } },
    },
    '/api/auth/mfa/disable': {
      post: { summary: 'Turn off authenticator app MFA', responses: { '200': { description: 'MFA disabled' }, '422': errorResponse, '409': errorResponse } },
    },
    '/api/auth/mfa/challenge': {
      post: { summary: 'Answer the MFA challenge', responses: { '200': { description: 'Privilege unlocked' }, '401': errorResponse } },
    },
    '/api/admin/users': {
      get: { summary: 'List users (users.view)', responses: { '200': { description: 'User page' }, '403': errorResponse } },
    },
    '/api/admin/users/{ref}/roles': {
      patch: { summary: 'Change roles (roles.manage)', responses: { '200': { description: 'Updated user' }, '409': errorResponse } },
    },
    '/api/admin/me': {
      get: { summary: 'Admin identity and capabilities', responses: { '200': { description: 'Admin profile' }, '403': errorResponse } },
    },

    // ---- Phase 04: sellers ----
    '/api/admin/sellers': {
      get: {
        summary: 'List offline sellers (inventory.manage)',
        parameters: [
          { name: 'search', in: 'query', schema: { type: 'string' } },
          { name: 'status', in: 'query', schema: { type: 'string', enum: ['active', 'inactive', 'archived'] } },
          { name: 'type', in: 'query', schema: { type: 'string', enum: ['individual', 'company'] } },
          { name: 'verification', in: 'query', schema: { type: 'string', enum: ['unverified', 'pending', 'verified', 'rejected'] } },
          { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1 } },
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100 } },
        ],
        responses: { '200': { description: 'Seller page' }, '401': errorResponse, '403': errorResponse },
      },
      post: { summary: 'Create an offline seller (never creates a login)', responses: { '201': { description: 'Seller created' }, '409': errorResponse } },
    },
    '/api/admin/sellers/{ref}': {
      get: { summary: 'Read one seller (admin DTO)', responses: { '200': { description: 'Seller' }, '404': errorResponse } },
      patch: {
        summary: 'Update a seller; settlement fields need settlements.manage',
        responses: { '200': { description: 'Updated seller' }, '403': errorResponse, '409': errorResponse },
      },
    },
    '/api/admin/sellers/{ref}/verification': {
      patch: { summary: 'Set verification state with evidence and reason', responses: { '200': { description: 'Updated seller' }, '422': errorResponse } },
    },
    '/api/admin/sellers/{ref}/status': {
      patch: { summary: 'Change seller status', responses: { '200': { description: 'Updated seller' }, '422': errorResponse } },
    },
    '/api/catalog/sellers/{ref}': {
      get: { summary: 'Public seller identity (no contact, address or notes)', responses: { '200': { description: 'Public seller DTO' }, '404': errorResponse } },
    },

    // ---- Phase 04: taxonomy ----
    '/api/catalog/categories': {
      get: {
        summary: 'Active category tree (same records the admin edits)',
        parameters: [{ name: 'locale', in: 'query', schema: { type: 'string', enum: ['en', 'ar'] } }],
        responses: { '200': { description: 'Public categories (imageUrl when a photo is set)' } },
      },
    },
    '/api/catalog/categories/{key}/image': {
      get: {
        summary: 'Public category photo bytes (active category with a ready asset only)',
        responses: { '200': { description: 'Image bytes' }, '404': errorResponse },
      },
    },
    '/api/admin/categories': {
      get: { summary: 'List categories, optionally including inactive', responses: { '200': { description: 'Admin categories' }, '403': errorResponse } },
      post: { summary: 'Create a category (validates parent, depth and key)', responses: { '201': { description: 'Category created' }, '409': errorResponse } },
    },
    '/api/admin/categories/{key}': {
      patch: {
        summary: 'Update a category; expectedHierarchyVersion prevents lost updates',
        responses: { '200': { description: 'Updated category' }, '409': errorResponse },
      },
    },
    '/api/admin/categories/{key}/archive': {
      post: { summary: 'Archive a category (refuses to strand active children)', responses: { '200': { description: 'Archived category' }, '409': errorResponse } },
    },
    '/api/admin/categories/{key}/restore': {
      post: { summary: 'Restore an archived category', responses: { '200': { description: 'Restored category' } } },
    },
    '/api/admin/categories/{key}/image': {
      post: {
        summary: 'Upload or replace the category photo (raw image body, jpeg/png/webp)',
        responses: { '201': { description: 'Category with imageAssetId and imageUrl' }, '404': errorResponse },
      },
      delete: {
        summary: 'Clear the category photo and delete the stored asset',
        responses: { '200': { description: 'Category with image cleared' }, '404': errorResponse },
      },
    },

    // ---- Phase 04: versioned attribute schemas ----
    '/api/admin/attribute-schemas': {
      get: {
        summary: 'List schema versions for a category (every version stays readable)',
        parameters: [{ name: 'categoryKey', in: 'query', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Schema versions' }, '422': errorResponse },
      },
      post: { summary: 'Create the next draft version', responses: { '201': { description: 'Draft created' }, '422': errorResponse } },
    },
    '/api/admin/attribute-schemas/{id}': {
      get: { summary: 'Read any schema version, including archived history', responses: { '200': { description: 'Schema version' }, '404': errorResponse } },
      patch: { summary: 'Update a draft (published versions are immutable)', responses: { '200': { description: 'Updated draft' }, '409': errorResponse } },
    },
    '/api/admin/attribute-schemas/{id}/publish': {
      post: { summary: 'Publish a draft as the current version', responses: { '200': { description: 'Published schema' }, '409': errorResponse } },
    },
    '/api/admin/attribute-schemas/{categoryKey}/validate': {
      post: {
        summary: 'Validate values against the current (or a named) schema version',
        responses: { '200': { description: 'Values accepted' }, '422': errorResponse },
      },
    },
    '/api/catalog/attribute-schemas/{categoryKey}/current': {
      get: { summary: 'Public schema: admin-only fields are stripped', responses: { '200': { description: 'Public schema or null' } } },
    },

    // ---- Phase 04: locations ----
    '/api/catalog/locations': {
      get: {
        summary: 'Public locations, precision policy applied server-side',
        parameters: [
          { name: 'country', in: 'query', schema: { type: 'string' } },
          { name: 'city', in: 'query', schema: { type: 'string' } },
        ],
        responses: { '200': { description: 'Public locations' } },
      },
    },
    '/api/admin/locations': {
      get: { summary: 'List all locations including inactive', responses: { '200': { description: 'Locations' }, '403': errorResponse } },
      post: { summary: 'Create a location (validates country, slugs and coordinates)', responses: { '201': { description: 'Location created' }, '422': errorResponse } },
    },
    '/api/admin/locations/{key}': {
      patch: { summary: 'Update labels, precision, coordinates or order', responses: { '200': { description: 'Updated location' }, '404': errorResponse } },
    },

    // ---- Phase 04: media ----
    '/api/admin/media/upload': {
      post: {
        summary: 'Upload one image (raw body, content signature validated)',
        parameters: [{ name: 'x-collection-key', in: 'header', schema: { type: 'string' } }],
        responses: {
          '201': { description: 'Asset stored' },
          '401': errorResponse,
          '403': errorResponse,
          '413': errorResponse,
          '422': errorResponse,
          '503': errorResponse,
        },
      },
    },
    '/api/admin/media': {
      get: {
        summary: 'List a collection with its configured limits',
        parameters: [{ name: 'collectionKey', in: 'query', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Assets and limits' }, '422': errorResponse },
      },
    },
    '/api/admin/media/{assetId}/file': {
      get: { summary: 'Authorized preview bytes, served non-executably', responses: { '200': { description: 'Image bytes' }, '401': errorResponse, '403': errorResponse, '404': errorResponse } },
    },
    '/api/admin/media/{assetId}/retry': {
      post: { summary: 'Retry a failed upload from its staged copy', responses: { '200': { description: 'Promoted asset' }, '409': errorResponse, '503': errorResponse } },
    },
    '/api/admin/media/{assetId}': {
      delete: { summary: 'Soft-delete an asset; refused while referenced', responses: { '200': { description: 'Removed' }, '409': errorResponse } },
    },
    '/api/admin/media/collection/{collectionKey}/order': {
      patch: { summary: 'Reorder a collection', responses: { '200': { description: 'Ordered assets' }, '422': errorResponse } },
    },
    '/api/admin/media/collection/{collectionKey}/cover': {
      patch: { summary: 'Choose the cover asset', responses: { '200': { description: 'Updated assets' }, '409': errorResponse } },
    },
    '/api/admin/media/cleanup': {
      post: { summary: 'Dry-run or apply orphan cleanup (referenced assets are never touched)', responses: { '200': { description: 'Candidates or removals' } } },
    },

    // ---- Phase 05: public discovery ----
    '/api/auction-calendar': {
      get: {
        summary: 'Sparse month grid of auction end dates grouped by parent category (Qatar civil month)',
        parameters: [
          { name: 'year', in: 'query', schema: { type: 'integer', minimum: 2000, maximum: 2100 } },
          { name: 'month', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 12 } },
          { name: 'locale', in: 'query', schema: { type: 'string', enum: ['en', 'ar'], default: 'en' } },
        ],
        responses: { '200': { description: 'Calendar month payload' }, '422': errorResponse },
      },
    },
    '/api/listings': {
      get: {
        summary: 'Published, visible listings only — drafts and archived records are never returned',
        parameters: [
          { name: 'q', in: 'query', schema: { type: 'string' } },
          { name: 'category', in: 'query', schema: { type: 'string' } },
          { name: 'method', in: 'query', schema: { type: 'string', enum: ['auction', 'fixed_price', 'enquiry'] } },
          { name: 'condition', in: 'query', schema: { type: 'string' } },
          { name: 'city', in: 'query', schema: { type: 'string' } },
          { name: 'area', in: 'query', schema: { type: 'string' } },
          { name: 'featured', in: 'query', schema: { type: 'string', enum: ['true'] } },
          { name: 'sort', in: 'query', schema: { type: 'string', enum: ['recent', 'title', 'featured'] } },
          { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1, default: 1 } },
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 60, default: 12 } },
          { name: 'endsOn', in: 'query', schema: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' }, description: 'Qatar civil date (YYYY-MM-DD); auction lots ending that day' },
        ],
        responses: { '200': { description: 'Paged public listings' }, '422': errorResponse },
      },
    },
    '/api/listings/{ref}': {
      get: { summary: 'One published listing as a public DTO (no admin notes, no private media)', responses: { '200': { description: 'Public listing' }, '404': errorResponse } },
    },
    '/api/listings/{ref}/media/{assetId}/file': {
      get: {
        summary: 'Image of a visible published listing; every other asset resolves to the same 404',
        parameters: [
          { name: 'ref', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'assetId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: { '200': { description: 'Image bytes' }, '404': errorResponse },
      },
    },

    // ---- Phase 05: admin inventory ----
    '/api/admin/listings': {
      get: {
        summary: 'Inventory records with status, category, seller and moderation filters',
        parameters: [
          { name: 'status', in: 'query', schema: { type: 'string', enum: ['draft', 'published', 'archived'] } },
          { name: 'categoryKey', in: 'query', schema: { type: 'string' } },
          { name: 'sellerReference', in: 'query', schema: { type: 'string' } },
          { name: 'search', in: 'query', schema: { type: 'string' } },
          { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1, default: 1 } },
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 } },
        ],
        responses: { '200': { description: 'Paged admin listings' }, '403': errorResponse },
      },
      post: {
        summary: 'Create a draft (a draft may be incomplete; required values are enforced at publish)',
        responses: { '201': { description: 'Draft created' }, '403': errorResponse, '422': errorResponse },
      },
    },
    '/api/admin/listings/{ref}': {
      get: { summary: 'One record plus the current schema, for the wizard', responses: { '200': { description: 'Admin listing + schema' }, '404': errorResponse } },
      patch: {
        summary: 'Versioned update; a stale expectedVersion is a 409, never a silent overwrite',
        responses: { '200': { description: 'Updated listing + reconciliation report' }, '403': errorResponse, '409': errorResponse, '422': errorResponse },
      },
    },
    '/api/admin/listings/{ref}/publish': {
      post: {
        summary: 'Server-validated publication: seller, category, schema, attributes, location and media',
        responses: { '200': { description: 'Published listing + public URL' }, '403': errorResponse, '409': errorResponse, '422': errorResponse },
      },
    },
    '/api/admin/listings/{ref}/archive': {
      post: {
        summary: 'Archive with a reason: history is preserved and public visibility is revoked',
        responses: { '200': { description: 'Archived listing' }, '403': errorResponse, '409': errorResponse, '422': errorResponse },
      },
    },
    '/api/admin/listings/{ref}/duplicate': {
      post: {
        summary: 'Duplicate as a new unsold draft; the source listing is unchanged',
        responses: { '201': { description: 'Cloned listing' }, '403': errorResponse, '404': errorResponse, '422': errorResponse },
      },
    },
  },
  components: {
    schemas: {
      ErrorEnvelope: {
        type: 'object',
        required: ['error'],
        properties: {
          error: {
            type: 'object',
            required: ['code', 'message', 'fieldErrors', 'requestId', 'details'],
            properties: {
              code: { type: 'string' },
              message: { type: 'string' },
              fieldErrors: { type: 'object', additionalProperties: { type: 'string' } },
              requestId: { type: 'string' },
              details: { type: 'object' },
            },
          },
        },
      },
    },
  },
};

const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'options', 'head'];

/** Lightweight structural validation — enough to catch a malformed contract in CI. */
export function validateOpenApiDocument(doc: OpenApiDocument): string[] {
  const issues: string[] = [];
  if (!/^3\./.test(doc.openapi ?? '')) issues.push('openapi version must be 3.x');
  if (!doc.info?.title) issues.push('info.title is required');
  if (!doc.info?.version) issues.push('info.version is required');
  const paths = doc.paths ?? {};
  if (Object.keys(paths).length === 0) issues.push('paths must not be empty');
  for (const [path, operations] of Object.entries(paths)) {
    if (!path.startsWith('/')) issues.push(`path ${path} must start with "/"`);
    const verbs = Object.keys(operations ?? {});
    if (verbs.length === 0) issues.push(`path ${path} has no operations`);
    for (const verb of verbs) {
      if (!METHODS.includes(verb)) issues.push(`path ${path} has unknown method ${verb}`);
    }
  }
  // Every documented path should advertise an error response where one is plausible.
  if (errorResponse === undefined) issues.push('error response definition missing');
  return issues;
}
