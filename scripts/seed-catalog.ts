import type { ClientSession, Db } from 'mongodb';
import type { Logger } from '../src/shared/logger.ts';
import { createTaxonomyService } from '../src/modules/taxonomy/service.ts';
import { createAttributeService } from '../src/modules/attributes/service.ts';
import { createLocationService } from '../src/modules/locations/service.ts';
import type { AttributeField } from '../src/modules/attributes/models.ts';
import type { ListingMethod } from '../src/modules/taxonomy/models.ts';

/**
 * Representative catalogue seed.
 *
 * Two rules govern this data:
 *
 * 1. It is structure, not approval. A category existing here does not approve auctions,
 *    commission, or any commercial term for that category.
 * 2. Auctions are deliberately NOT enabled by the seed. Which categories may be sold at
 *    auction — and under which rules — is an open client decision (see
 *    `docs/OPEN_QUESTIONS.md`). The seed therefore grants the classifieds methods only;
 *    an admin can widen a category in the taxonomy screen once that decision is made.
 */
const METHODS: ListingMethod[] = ['fixed_price', 'enquiry'];

const ACTOR = { reference: 'system:seed', requestId: 'seed' } as const;

type CategorySeed = {
  key: string;
  parentKey: string | null;
  nameEn: string;
  nameAr: string;
  descriptionEn: string;
  icon: string;
  order: number;
  children?: Array<{ key: string; nameEn: string; nameAr: string; order: number }>;
};

export const CATEGORY_SEED: CategorySeed[] = [
  {
    key: 'vehicles',
    parentKey: null,
    nameEn: 'Vehicles',
    nameAr: 'مركبات',
    descriptionEn: 'Cars, motorcycles, boats and parts.',
    icon: 'car',
    order: 1,
    children: [
      { key: 'cars', nameEn: 'Cars', nameAr: 'سيارات', order: 1 },
      { key: 'motorcycles', nameEn: 'Motorcycles', nameAr: 'دراجات نارية', order: 2 },
      { key: 'boats', nameEn: 'Boats', nameAr: 'قوارب', order: 3 },
      { key: 'vehicle-parts', nameEn: 'Spare parts', nameAr: 'قطع غيار', order: 4 },
    ],
  },
  {
    key: 'property',
    parentKey: null,
    nameEn: 'Property',
    nameAr: 'عقارات',
    descriptionEn: 'Apartments, villas, land and offices.',
    icon: 'home',
    order: 2,
    children: [
      { key: 'apartments', nameEn: 'Apartments', nameAr: 'شقق', order: 1 },
      { key: 'villas', nameEn: 'Villas', nameAr: 'فلل', order: 2 },
      { key: 'land', nameEn: 'Land', nameAr: 'أراضي', order: 3 },
      { key: 'offices', nameEn: 'Offices', nameAr: 'مكاتب', order: 4 },
    ],
  },
  {
    key: 'electronics',
    parentKey: null,
    nameEn: 'Electronics',
    nameAr: 'إلكترونيات',
    descriptionEn: 'Phones, computers, cameras and accessories.',
    icon: 'device',
    order: 3,
    children: [
      { key: 'phones', nameEn: 'Phones', nameAr: 'هواتف', order: 1 },
      { key: 'computers', nameEn: 'Computers', nameAr: 'حواسيب', order: 2 },
      { key: 'cameras', nameEn: 'Cameras', nameAr: 'كاميرات', order: 3 },
    ],
  },
  {
    key: 'jobs',
    parentKey: null,
    nameEn: 'Jobs',
    nameAr: 'وظائف',
    descriptionEn: 'Hiring and service opportunities.',
    icon: 'briefcase',
    order: 4,
    children: [
      { key: 'drivers', nameEn: 'Drivers', nameAr: 'سائقون', order: 1 },
      { key: 'technicians', nameEn: 'Technicians', nameAr: 'فنيون', order: 2 },
      { key: 'office-roles', nameEn: 'Office roles', nameAr: 'وظائف مكتبية', order: 3 },
    ],
  },
  {
    key: 'general',
    parentKey: null,
    nameEn: 'General items',
    nameAr: 'منوعات',
    descriptionEn: 'Furniture, clothing, sports and everything else.',
    icon: 'tag',
    order: 5,
    children: [
      { key: 'furniture', nameEn: 'Furniture', nameAr: 'أثاث', order: 1 },
      { key: 'clothing', nameEn: 'Clothing', nameAr: 'ملابس', order: 2 },
      { key: 'sports', nameEn: 'Sports', nameAr: 'رياضة', order: 3 },
    ],
  },
];

function field(input: Partial<AttributeField> & Pick<AttributeField, 'key' | 'type' | 'labelEn'>): AttributeField {
  return {
    key: input.key,
    type: input.type,
    labelEn: input.labelEn,
    labelAr: input.labelAr ?? null,
    helpEn: input.helpEn ?? null,
    unit: input.unit ?? null,
    required: input.required ?? false,
    filterable: input.filterable ?? false,
    publicDisplay: input.publicDisplay ?? true,
    adminOnly: input.adminOnly ?? false,
    order: input.order ?? 0,
    options: input.options ?? [],
    constraints: input.constraints ?? {},
    dependsOn: input.dependsOn ?? null,
  };
}

export const SCHEMA_SEED: Record<string, AttributeField[]> = {
  vehicles: [
    field({ key: 'make', type: 'text', labelEn: 'Make', required: true, filterable: true, order: 1 }),
    field({ key: 'model', type: 'text', labelEn: 'Model', required: true, filterable: true, order: 2 }),
    field({ key: 'year', type: 'number', labelEn: 'Year', required: true, filterable: true, order: 3, constraints: { min: 1950, max: 2100, integer: true } }),
    field({
      key: 'condition',
      type: 'select',
      labelEn: 'Condition',
      required: true,
      filterable: true,
      order: 4,
      options: [
        { key: 'new', labelEn: 'New' },
        { key: 'used', labelEn: 'Used' },
      ],
    }),
    field({ key: 'mileage', type: 'number', labelEn: 'Mileage', unit: 'km', filterable: true, order: 5, constraints: { min: 0, integer: true }, dependsOn: { field: 'condition', equals: 'used' } }),
    field({ key: 'transmission', type: 'select', labelEn: 'Transmission', filterable: true, order: 6, options: [{ key: 'automatic', labelEn: 'Automatic' }, { key: 'manual', labelEn: 'Manual' }] }),
    field({ key: 'fuel', type: 'select', labelEn: 'Fuel', filterable: true, order: 7, options: [{ key: 'petrol', labelEn: 'Petrol' }, { key: 'diesel', labelEn: 'Diesel' }, { key: 'hybrid', labelEn: 'Hybrid' }, { key: 'electric', labelEn: 'Electric' }] }),
    field({ key: 'accident_history', type: 'text', labelEn: 'Accident history', publicDisplay: false, adminOnly: false, order: 8 }),
  ],
  property: [
    field({
      key: 'property_type',
      type: 'select',
      labelEn: 'Property type',
      required: true,
      filterable: true,
      order: 1,
      options: [
        { key: 'apartment', labelEn: 'Apartment' },
        { key: 'villa', labelEn: 'Villa' },
        { key: 'land', labelEn: 'Land' },
        { key: 'office', labelEn: 'Office' },
      ],
    }),
    field({ key: 'bedrooms', type: 'number', labelEn: 'Bedrooms', filterable: true, order: 2, constraints: { min: 0, max: 30, integer: true } }),
    field({ key: 'bathrooms', type: 'number', labelEn: 'Bathrooms', filterable: true, order: 3, constraints: { min: 0, max: 30, integer: true } }),
    field({ key: 'area', type: 'number', labelEn: 'Area', unit: 'm²', filterable: true, order: 4, constraints: { min: 0 } }),
    field({ key: 'furnished', type: 'boolean', labelEn: 'Furnished', filterable: true, order: 5 }),
    field({ key: 'title_deed_note', type: 'text', labelEn: 'Title deed note', publicDisplay: false, adminOnly: true, order: 6, helpEn: 'Internal note for verifying ownership documents.' }),
  ],
  electronics: [
    field({
      key: 'brand',
      type: 'select',
      labelEn: 'Brand',
      required: true,
      filterable: true,
      order: 1,
      options: [
        { key: 'apple', labelEn: 'Apple' },
        { key: 'samsung', labelEn: 'Samsung' },
        { key: 'other', labelEn: 'Other' },
      ],
    }),
    field({ key: 'model_name', type: 'text', labelEn: 'Model', required: true, filterable: true, order: 2 }),
    field({ key: 'storage', type: 'number', labelEn: 'Storage', unit: 'GB', filterable: true, order: 3, constraints: { min: 0, integer: true } }),
    field({ key: 'warranty_months', type: 'number', labelEn: 'Warranty', unit: 'months', order: 4, constraints: { min: 0, max: 120, integer: true } }),
    field({ key: 'accessories', type: 'multiselect', labelEn: 'Included accessories', order: 5, options: [{ key: 'charger', labelEn: 'Charger' }, { key: 'box', labelEn: 'Original box' }, { key: 'receipt', labelEn: 'Receipt' }] }),
  ],
  jobs: [
    field({
      key: 'employment_type',
      type: 'select',
      labelEn: 'Employment type',
      required: true,
      filterable: true,
      order: 1,
      options: [
        { key: 'full-time', labelEn: 'Full time' },
        { key: 'part-time', labelEn: 'Part time' },
        { key: 'contract', labelEn: 'Contract' },
      ],
    }),
    field({ key: 'experience_years', type: 'number', labelEn: 'Experience required', unit: 'years', filterable: true, order: 2, constraints: { min: 0, max: 50, integer: true } }),
    field({ key: 'salary_note', type: 'text', labelEn: 'Salary note', order: 3, helpEn: 'Free text; salary bands are not a published feature yet.' }),
    field({ key: 'start_date', type: 'date', labelEn: 'Start date', order: 4 }),
  ],
  general: [
    field({
      key: 'item_condition',
      type: 'select',
      labelEn: 'Condition',
      required: true,
      filterable: true,
      order: 1,
      options: [
        { key: 'new', labelEn: 'New' },
        { key: 'like-new', labelEn: 'Like new' },
        { key: 'used', labelEn: 'Used' },
      ],
    }),
    field({ key: 'brand_name', type: 'text', labelEn: 'Brand', filterable: true, order: 2 }),
    field({ key: 'dimensions_note', type: 'text', labelEn: 'Dimensions', order: 3 }),
    field({ key: 'delivery_available', type: 'boolean', labelEn: 'Delivery available', filterable: true, order: 4 }),
  ],
};

export const LOCATION_SEED: Array<{
  countryCode: string;
  cityKey: string;
  areaKey: string;
  labelEn: string;
  labelAr?: string;
  coordinates?: { lat: number; lng: number };
  publicPrecision?: 'city' | 'area' | 'exact';
  order?: number;
}> = [
  { countryCode: 'QA', cityKey: 'doha', areaKey: 'al-sadd', labelEn: 'Al Sadd, Doha', labelAr: 'السد، الدوحة', coordinates: { lat: 25.2762, lng: 51.5076 }, order: 1 },
  { countryCode: 'QA', cityKey: 'doha', areaKey: 'west-bay', labelEn: 'West Bay, Doha', labelAr: 'الخليج الغربي، الدوحة', coordinates: { lat: 25.3206, lng: 51.5294 }, order: 2 },
  { countryCode: 'QA', cityKey: 'doha', areaKey: 'the-pearl', labelEn: 'The Pearl, Doha', labelAr: 'اللؤلؤة، الدوحة', coordinates: { lat: 25.3722, lng: 51.5514 }, order: 3 },
  { countryCode: 'QA', cityKey: 'lusail', areaKey: 'marina', labelEn: 'Lusail Marina', labelAr: 'مرسى لوسيل', coordinates: { lat: 25.4349, lng: 51.4906 }, order: 4 },
  { countryCode: 'QA', cityKey: 'al-wakrah', areaKey: 'city-centre', labelEn: 'Al Wakrah', labelAr: 'الوكرة', order: 5 },
];

export type CatalogSeedSummary = {
  categoriesCreated: number;
  schemasPublished: number;
  locationsCreated: number;
};

/**
 * Idempotent: every record is created only when its stable key is still missing, so the
 * command can be re-run on an existing development database without duplicating anything.
 */
export async function seedCatalog(deps: {
  db: Db;
  logger: Logger;
  withTransaction: <T>(fn: (session: ClientSession) => Promise<T>) => Promise<T>;
}): Promise<CatalogSeedSummary> {
  const taxonomy = createTaxonomyService({ db: deps.db, logger: deps.logger, withTransaction: deps.withTransaction });
  const attributes = createAttributeService({ db: deps.db, logger: deps.logger, withTransaction: deps.withTransaction });
  const locations = createLocationService({ db: deps.db, logger: deps.logger });

  const summary: CatalogSeedSummary = { categoriesCreated: 0, schemasPublished: 0, locationsCreated: 0 };

  const createCategory = async (parentKey: string | null, seed: { key: string; nameEn: string; nameAr: string; descriptionEn?: string; icon?: string; order: number }): Promise<void> => {
    if (await taxonomy.getByKey(seed.key)) return;
    await taxonomy.create(
      {
        key: seed.key,
        parentKey,
        nameEn: seed.nameEn,
        nameAr: seed.nameAr,
        descriptionEn: seed.descriptionEn ?? null,
        icon: seed.icon ?? null,
        order: seed.order,
        active: true,
        listingMethods: METHODS,
      },
      ACTOR,
    );
    summary.categoriesCreated += 1;
  };

  for (const root of CATEGORY_SEED) {
    await createCategory(root.parentKey, root);
    for (const child of root.children ?? []) {
      await createCategory(root.key, { ...child, order: child.order });
    }
  }

  for (const [categoryKey, fields] of Object.entries(SCHEMA_SEED)) {
    // A published schema means this category is already seeded; drafts are left alone.
    if (await attributes.currentForCategory(categoryKey)) continue;
    const draft = await attributes.createDraft({ categoryKey, fields, notes: 'Representative seed schema' }, ACTOR);
    await attributes.publish(String(draft._id), ACTOR);
    summary.schemasPublished += 1;
  }

  const existing = new Set((await locations.list({ includeInactive: true })).map((location) => location.key));
  for (const seed of LOCATION_SEED) {
    const key = `${seed.countryCode.toLowerCase()}-${seed.cityKey}-${seed.areaKey}`;
    if (existing.has(key)) continue;
    await locations.create(
      {
        countryCode: seed.countryCode,
        cityKey: seed.cityKey,
        areaKey: seed.areaKey,
        labelEn: seed.labelEn,
        labelAr: seed.labelAr ?? null,
        coordinates: seed.coordinates ?? null,
        publicPrecision: seed.publicPrecision ?? 'city',
        order: seed.order ?? 0,
      },
      ACTOR,
    );
    summary.locationsCreated += 1;
  }

  return summary;
}
