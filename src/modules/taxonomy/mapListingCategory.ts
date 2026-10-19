export function mapListingCategory(
  audience: string | null,
  titleEn: string,
): { categoryKey: string } {
  void audience;
  const title = titleEn.toLowerCase();

  if (/misbah|tasbih|tasbeeh|مسباح|مسبحة/i.test(titleEn)) {
    return { categoryKey: 'misbah' };
  }
  if (/watch|ساعة/i.test(titleEn)) {
    return { categoryKey: 'watches' };
  }
  if (/cufflink|أزرار/i.test(titleEn)) {
    return { categoryKey: 'cufflinks' };
  }
  if (/abaya|عباية/i.test(titleEn)) {
    return { categoryKey: 'abaya' };
  }
  if (/supplement|مكمل/i.test(titleEn)) {
    return { categoryKey: 'supplements' };
  }
  if (/tea|coffee|شاي|قهوة/i.test(titleEn)) {
    return { categoryKey: 'tea-coffee' };
  }
  if (/leather|nappa|calfskin|lambskin|clutch|حقيبة/i.test(titleEn)) {
    return { categoryKey: 'natural-leather' };
  }
  if (/perfume|oud|bakhour|attar|عطر|عود|بخور/i.test(titleEn)) {
    return { categoryKey: 'perfume' };
  }
  if (/glass|sunglasses|نظارة/i.test(titleEn)) {
    return { categoryKey: 'glasses' };
  }
  if (/thobe|thoub|clothes|jacket|ثوب/i.test(title)) {
    return { categoryKey: 'clothes-thobes' };
  }
  return { categoryKey: 'clothes-thobes' };
}
