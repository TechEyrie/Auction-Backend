export const CATEGORY_ICON_KEYS = [
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
  'tag',
  'shirt',
  'bag',
  'watch',
  'sparkle',
  'home',
  'car',
  'phone',
  'gem',
  'folder',
] as const;

export type CategoryIconKey = (typeof CATEGORY_ICON_KEYS)[number];

export const CATEGORY_ICONS: Array<{ key: CategoryIconKey; label: string }> = [
  { key: 'glasses', label: 'Glasses' },
  { key: 'tea-coffee', label: 'Tea & coffee' },
  { key: 'abaya', label: 'Abaya' },
  { key: 'natural-leather', label: 'Leather' },
  { key: 'perfume', label: 'Perfume' },
  { key: 'supplements', label: 'Supplements' },
  { key: 'misbah', label: 'Misbah' },
  { key: 'watches', label: 'Watches' },
  { key: 'clothes-thobes', label: 'Clothes / thobes' },
  { key: 'cufflinks', label: 'Cufflinks' },
  { key: 'tag', label: 'Tag' },
  { key: 'shirt', label: 'Shirt' },
  { key: 'bag', label: 'Bag' },
  { key: 'watch', label: 'Watch' },
  { key: 'sparkle', label: 'Sparkle' },
  { key: 'home', label: 'Home' },
  { key: 'car', label: 'Car' },
  { key: 'phone', label: 'Phone' },
  { key: 'gem', label: 'Gem' },
  { key: 'folder', label: 'Folder' },
];

const ICON_SET = new Set<string>(CATEGORY_ICON_KEYS);

export function isCategoryIcon(key: string): key is CategoryIconKey {
  return ICON_SET.has(key);
}

export const DEFAULT_CATEGORY_ICON: CategoryIconKey = 'tag';
