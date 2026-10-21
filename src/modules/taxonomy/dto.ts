import type { CategoryDoc } from './models.ts';

export function categoryImageUrl(key: string, imageAssetId: string | null | undefined): string | null {
  return imageAssetId ? `/api/catalog/categories/${key}/image` : null;
}

function resolvedImageAssetId(category: CategoryDoc): string | null {
  return category.imageAssetId ?? null;
}

/** Public consumer view: only active categories, only publicly meaningful fields. */
export type PublicCategoryDto = {
  key: string;
  parentKey: string | null;
  depth: number;
  name: string;
  description: string | null;
  icon: string | null;
  imageUrl: string | null;
  order: number;
  listingMethods: CategoryDoc['listingMethods'];
  attributeSchemaVersion: number | null;
};

export type AdminCategoryDto = PublicCategoryDto & {
  imageAssetId: string | null;
  active: boolean;
  hierarchyVersion: number;
  labels: CategoryDoc['labels'];
  ancestors: string[];
  createdBy: string;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
};

export function toPublicCategoryDto(category: CategoryDoc, locale: 'en' | 'ar' = 'en'): PublicCategoryDto {
  const label = locale === 'ar' ? category.labels.ar ?? category.labels.en : category.labels.en;
  return {
    key: category.key,
    parentKey: category.parentKey,
    depth: category.depth,
    name: label.name,
    description: label.description ?? null,
    icon: category.icon,
    imageUrl: categoryImageUrl(category.key, resolvedImageAssetId(category)),
    order: category.order,
    listingMethods: category.listingMethods,
    attributeSchemaVersion: category.currentAttributeSchemaVersion,
  };
}

export function toAdminCategoryDto(category: CategoryDoc): AdminCategoryDto {
  return {
    ...toPublicCategoryDto(category),
    imageAssetId: resolvedImageAssetId(category),
    active: category.active,
    hierarchyVersion: category.hierarchyVersion,
    labels: category.labels,
    ancestors: category.ancestors,
    createdBy: category.createdBy,
    updatedBy: category.updatedBy,
    createdAt: category.createdAt.toISOString(),
    updatedAt: category.updatedAt.toISOString(),
    archivedAt: category.archivedAt ? category.archivedAt.toISOString() : null,
  };
}
