import type { Db } from 'mongodb';
import { COLLECTIONS } from '../../db/indexes.ts';
import { BUSINESS_TIMEZONE, toIsoUtc } from '../../shared/time.ts';
import { qatarMonthUtcBounds } from '../../shared/qatarCalendar.ts';
import { publicVisibilityFilter } from '../listings/repository.ts';
import { CATALOGUE_ROOTS } from '../taxonomy/models.ts';

type Locale = 'en' | 'ar';

export type CalendarGroup = {
  parentCategoryKey: string;
  parentCategoryName: string;
  listingCount: number;
  endsAt: string;
  live: boolean;
};

export type CalendarDay = {
  date: string;
  groups: CalendarGroup[];
};

export type AuctionCalendarPayload = {
  month: { year: number; month: number };
  timezone: string;
  days: CalendarDay[];
};

type AggRow = {
  _id: { date: string; parentCategoryKey: string };
  listingRefs: string[];
  endsAt: Date;
  liveCount: number;
};

function categoryName(
  labels: { en?: { name?: string }; ar?: { name?: string } | null } | undefined,
  locale: Locale,
  key: string,
): string {
  const picked = locale === 'ar' ? labels?.ar ?? labels?.en : labels?.en;
  const name = picked?.name?.trim();
  return name || key;
}

export async function getAuctionCalendar(
  db: Db,
  year: number,
  month: number,
  locale: Locale,
): Promise<AuctionCalendarPayload> {
  const now = new Date();
  const { start, endExclusive } = qatarMonthUtcBounds(year, month);
  const visibility = publicVisibilityFilter();

  const rows = await db.collection(COLLECTIONS.auctions).aggregate<AggRow>([
    {
      $match: {
        status: { $in: ['live', 'scheduled'] },
        endsAt: { $gte: start, $lt: endExclusive },
      },
    },
    {
      $lookup: {
        from: COLLECTIONS.listings,
        let: { listingRef: '$listingReference' },
        pipeline: [
          {
            $match: {
              $expr: { $eq: ['$listingReference', '$$listingRef'] },
              ...visibility,
              listingMethod: 'auction',
            },
          },
          {
            $project: {
              categoryPath: 1,
              listingReference: 1,
              _id: 0,
            },
          },
        ],
        as: 'listing',
      },
    },
    { $unwind: { path: '$listing', preserveNullAndEmptyArrays: false } },
    {
      $addFields: {
        qatarDate: {
          $dateToString: { format: '%Y-%m-%d', date: '$endsAt', timezone: BUSINESS_TIMEZONE },
        },
        parentCategoryKey: { $arrayElemAt: ['$listing.categoryPath', 0] },
        isCurrentlyLive: {
          $and: [
            { $eq: ['$status', 'live'] },
            { $lte: ['$startsAt', now] },
            { $gt: ['$endsAt', now] },
          ],
        },
      },
    },
    {
      $match: {
        parentCategoryKey: { $type: 'string', $nin: [null, ''] },
      },
    },
    { $sort: { endsAt: 1 } },
    {
      $group: {
        _id: { date: '$qatarDate', parentCategoryKey: '$parentCategoryKey' },
        listingRefs: { $addToSet: '$listing.listingReference' },
        endsAt: { $min: '$endsAt' },
        liveCount: { $sum: { $cond: ['$isCurrentlyLive', 1, 0] } },
      },
    },
  ]).toArray();

  const categoryKeys = [...new Set(rows.map((row) => row._id.parentCategoryKey))];
  const categories = categoryKeys.length
    ? await db.collection(COLLECTIONS.categories)
      .find({ key: { $in: categoryKeys } })
      .project({ key: 1, labels: 1, _id: 0 })
      .toArray()
    : [];
  const nameByKey = new Map(
    categories.map((cat) => [
      String(cat.key),
      categoryName(cat.labels as { en?: { name?: string }; ar?: { name?: string } | null }, locale, String(cat.key)),
    ]),
  );

  const byDate = new Map<string, CalendarGroup[]>();
  for (const row of rows) {
    const key = row._id.parentCategoryKey;
    const groups = byDate.get(row._id.date) ?? [];
    groups.push({
      parentCategoryKey: key,
      parentCategoryName: nameByKey.get(key) ?? key,
      listingCount: row.listingRefs.length,
      endsAt: toIsoUtc(row.endsAt),
      live: row.liveCount > 0,
    });
    byDate.set(row._id.date, groups);
  }

  const days: CalendarDay[] = [...byDate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, groups]) => ({
      date,
      groups: groups
        .filter((group) => (CATALOGUE_ROOTS as readonly string[]).includes(group.parentCategoryKey))
        .sort((left, right) => {
          const byEnd = left.endsAt.localeCompare(right.endsAt);
          if (byEnd !== 0) return byEnd;
          return left.parentCategoryKey.localeCompare(right.parentCategoryKey);
        }),
    }));

  return {
    month: { year, month },
    timezone: BUSINESS_TIMEZONE,
    days,
  };
}
