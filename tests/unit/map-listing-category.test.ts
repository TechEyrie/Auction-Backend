import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mapListingCategory } from '../../src/modules/taxonomy/mapListingCategory.ts';

test('mapListingCategory maps tasbih titles to misbah', () => {
  assert.deepEqual(mapListingCategory('men', 'Vintage Tasbih beads'), { categoryKey: 'misbah' });
});

test('mapListingCategory maps leather titles to natural-leather regardless of audience', () => {
  assert.deepEqual(mapListingCategory('women', 'Nappa leather clutch'), { categoryKey: 'natural-leather' });
});

test('mapListingCategory defaults unmatched titles to clothes-thobes', () => {
  assert.deepEqual(mapListingCategory('men', 'Plain listing title'), { categoryKey: 'clothes-thobes' });
});
