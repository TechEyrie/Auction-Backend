import type { Db } from 'mongodb';
import { COLLECTIONS } from '../../db/indexes.ts';
import { DEFAULT_CATEGORY_ICON, isCategoryIcon } from './icons.ts';
import type { CategoryDoc } from './models.ts';

export function resolveCategoryIcon(
  category: Pick<CategoryDoc, 'key' | 'icon' | 'parentKey'>,
  parentResolvedIcon: string | null,
): string {
  if (category.icon && isCategoryIcon(category.icon)) return category.icon;
  if (isCategoryIcon(category.key)) return category.key;
  if (parentResolvedIcon && isCategoryIcon(parentResolvedIcon)) return parentResolvedIcon;
  return DEFAULT_CATEGORY_ICON;
}

/** Idempotent: normalises missing or invalid `icon` on every category document. */
export async function backfillCategoryIcons(db: Db): Promise<{ updated: number }> {
  const collection = db.collection<CategoryDoc>(COLLECTIONS.categories);
  const all = await collection.find({}).toArray();
  const byKey = new Map(all.map((doc) => [doc.key, doc]));
  const resolved = new Map<string, string>();
  let updated = 0;

  for (const category of [...all].sort((a, b) => a.depth - b.depth)) {
    const parentResolved =
      category.parentKey && byKey.has(category.parentKey) ? resolved.get(category.parentKey) ?? null : null;
    const icon = resolveCategoryIcon(category, parentResolved);
    resolved.set(category.key, icon);
    if (category.icon !== icon) {
      await collection.updateOne({ key: category.key }, { $set: { icon } });
      updated += 1;
    }
  }

  return { updated };
}
