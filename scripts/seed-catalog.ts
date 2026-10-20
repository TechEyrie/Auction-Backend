import type { ClientSession, Db } from 'mongodb';
import type { Logger } from '../src/shared/logger.ts';
import { createTaxonomyService } from '../src/modules/taxonomy/service.ts';
import { createAttributeService } from '../src/modules/attributes/service.ts';
import { createLocationService } from '../src/modules/locations/service.ts';
import type { AttributeField } from '../src/modules/attributes/models.ts';
import type { ListingMethod } from '../src/modules/taxonomy/models.ts';
import { backfillCategoryIcons } from '../src/modules/taxonomy/backfillCategoryIcons.ts';

const METHODS: ListingMethod[] = ['auction', 'fixed_price', 'enquiry'];

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
  { key: 'glasses', parentKey: null, nameEn: 'Glasses', nameAr: 'نظارات', descriptionEn: 'Eyewear and sunglasses.', icon: 'glasses', order: 1 },
  { key: 'tea-coffee', parentKey: null, nameEn: 'Tea & Coffee', nameAr: 'شاي وقهوة', descriptionEn: 'Tea, coffee and related accessories.', icon: 'tea-coffee', order: 2 },
  { key: 'abaya', parentKey: null, nameEn: 'Abaya', nameAr: 'عباية', descriptionEn: 'Abayas and related garments.', icon: 'abaya', order: 3 },
  { key: 'natural-leather', parentKey: null, nameEn: 'Natural Leather', nameAr: 'جلد طبيعي', descriptionEn: 'Leather goods and accessories.', icon: 'natural-leather', order: 4 },
  { key: 'perfume', parentKey: null, nameEn: 'Perfume', nameAr: 'عطور', descriptionEn: 'Perfumes, oud and fragrances.', icon: 'perfume', order: 5 },
  { key: 'supplements', parentKey: null, nameEn: 'Supplements', nameAr: 'مكملات', descriptionEn: 'Health and nutritional supplements.', icon: 'supplements', order: 6 },
  { key: 'misbah', parentKey: null, nameEn: 'Misbah', nameAr: 'مسباح', descriptionEn: 'Prayer beads and misbah.', icon: 'misbah', order: 7 },
  { key: 'watches', parentKey: null, nameEn: 'Watches', nameAr: 'ساعات', descriptionEn: 'Watches and timepieces.', icon: 'watches', order: 8 },
  { key: 'clothes-thobes', parentKey: null, nameEn: 'Clothes and Thobes', nameAr: 'ملابس وثياب', descriptionEn: 'Clothing, thobes and apparel.', icon: 'clothes-thobes', order: 9 },
  { key: 'cufflinks', parentKey: null, nameEn: 'Cufflinks', nameAr: 'أزرار أكمام', descriptionEn: 'Cufflinks and formal accessories.', icon: 'cufflinks', order: 10 },
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

const LEAF_FIELDS: AttributeField[] = [
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
];

const LEAF_CATEGORY_KEYS = [
  'glasses',
  'tea-coffee',
  'abaya',
  'natural-leather',
  'perfume',
  'supplements',
  'misbah',
  'watches',
  'clothes-thobes',
  'cufflinks',
] as const;

export const SCHEMA_SEED: Record<string, AttributeField[]> = Object.fromEntries(
  LEAF_CATEGORY_KEYS.map((key) => [key, LEAF_FIELDS]),
);

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
  { countryCode: 'QA', cityKey: 'doha', areaKey: 'al-sadd', labelEn: 'Al Sadd, Doha', labelAr: 'السد، الدوحة', coordinates: { lat: 25.2762, lng: 51.5076 }, publicPrecision: 'area', order: 1 },
  { countryCode: 'QA', cityKey: 'doha', areaKey: 'west-bay', labelEn: 'West Bay, Doha', labelAr: 'الخليج الغربي، الدوحة', coordinates: { lat: 25.3206, lng: 51.5294 }, publicPrecision: 'area', order: 2 },
  { countryCode: 'QA', cityKey: 'doha', areaKey: 'the-pearl', labelEn: 'The Pearl, Doha', labelAr: 'اللؤلؤة، الدوحة', coordinates: { lat: 25.3722, lng: 51.5514 }, publicPrecision: 'area', order: 3 },
  { countryCode: 'QA', cityKey: 'lusail', areaKey: 'marina', labelEn: 'Lusail Marina', labelAr: 'مرسى لوسيل', coordinates: { lat: 25.4349, lng: 51.4906 }, publicPrecision: 'area', order: 4 },
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
        icon: seed.icon,
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

  await backfillCategoryIcons(deps.db);

  return summary;
}
