import { z } from 'zod';
import {
  ABOUT_LABEL_FIELDS,
  ACCOUNT_LABEL_FIELDS,
  AUCTIONS_LABEL_FIELDS,
  BROWSE_LABEL_FIELDS,
  CALENDAR_LABEL_FIELDS,
  CATEGORIES_LABEL_FIELDS,
  CONTACT_LABEL_FIELDS,
  HELP_LABEL_FIELDS,
  HOME_LABEL_FIELDS,
  LEGAL_LABEL_FIELDS,
  LOT_LABEL_FIELDS,
  PRODUCT_LABEL_FIELDS,
} from './content-page-fields.ts';

export {
  ABOUT_LABEL_FIELDS,
  ACCOUNT_LABEL_FIELDS,
  AUCTIONS_LABEL_FIELDS,
  BROWSE_LABEL_FIELDS,
  CALENDAR_LABEL_FIELDS,
  CATEGORIES_LABEL_FIELDS,
  CONTACT_LABEL_FIELDS,
  HELP_LABEL_FIELDS,
  HOME_LABEL_FIELDS,
  LEGAL_LABEL_FIELDS,
  LOT_LABEL_FIELDS,
  PRODUCT_LABEL_FIELDS,
} from './content-page-fields.ts';

/** Fixed label keys for site header chrome (must match frontend `siteChrome.ts`). */
export const HEADER_LABEL_FIELDS = [
  'nav.auction',
  'nav.accessories',
  'nav.sell',
  'nav.how',
  'nav.shop',
  'nav.menu.liveAuctions.title',
  'nav.menu.liveAuctions.desc',
  'nav.menu.auctionCalendar.title',
  'nav.menu.auctionCalendar.desc',
  'nav.menu.auctionListings.title',
  'nav.menu.auctionListings.desc',
  'nav.menu.howBidding.title',
  'nav.menu.howBidding.desc',
  'nav.menu.browseAccessories.title',
  'nav.menu.browseAccessories.desc',
  'nav.menu.allCategories.title',
  'nav.menu.allCategories.desc',
  'nav.menu.forMen.title',
  'nav.menu.forMen.desc',
  'nav.menu.forWomen.title',
  'nav.menu.forWomen.desc',
  'nav.menu.forUnisex.title',
  'nav.menu.forUnisex.desc',
  'nav.menu.contactToSell.title',
  'nav.menu.contactToSell.desc',
  'nav.menu.aboutUs.title',
  'nav.menu.aboutUs.desc',
  'nav.menu.auctionProcess.title',
  'nav.menu.auctionProcess.desc',
  'nav.menu.helpCentre.title',
  'nav.menu.helpCentre.desc',
  'nav.menu.contact.title',
  'nav.menu.contact.desc',
  'nav.menu.allListings.title',
  'nav.menu.allListings.desc',
  'nav.menu.fixedPrice.title',
  'nav.menu.fixedPrice.desc',
  'nav.menu.auctions.title',
  'nav.menu.auctions.desc',
  'nav.menu.categories.title',
  'nav.menu.categories.desc',
  'header.search',
  'header.register',
  'header.account',
  'header.admin',
  'header.menu',
  'header.openMenu',
  'header.closeMenu',
  'header.siteMenu',
  'header.switchLanguage',
  'header.selectLanguage',
  'header.selectCity',
  'header.mainNav',
  'header.mobileNav',
  'header.brandHome',
  'header.brandName',
  'header.brandSub',
  'header.langName',
  'header.langCode',
  'header.searchOverlay',
  'header.closeSearch',
  'header.searchPlaceholder',
  'header.trending',
  'header.popularCategories',
  'header.popularCategoriesLoading',
  'header.popularCategoriesEmpty',
  'browse.allCities',
] as const;

/** Fixed label keys for site footer chrome (must match frontend `siteChrome.ts`). */
export const FOOTER_LABEL_FIELDS = [
  'footer.tagline',
  'footer.marketplace',
  'footer.allCategories',
  'footer.liveAuctions',
  'footer.latestProducts',
  'footer.company',
  'footer.about',
  'footer.contact',
  'footer.help',
  'footer.helpCentre',
  'footer.safetyTips',
  'footer.terms',
  'footer.privacy',
  'footer.rights',
  'footer.languages',
  'footer.developedBy',
  'footer.brandName',
  'footer.brandSub',
] as const;

/** Fixed label keys for customer auth chrome (must match frontend `siteChrome.ts`). */
export const AUTH_LABEL_FIELDS = [
  'auth.pageTitle.signin',
  'auth.logoAlt',
  'auth.tablistAria',
  'auth.hero.welcome',
  'auth.hero.tagline',
  'auth.hero.bullet1',
  'auth.hero.bullet2',
  'auth.hero.bullet3',
  'auth.emailVerify.heading',
  'auth.verifyAndContinue',
  'auth.mfa.title',
  'auth.mfa.intro',
  'auth.mfa.recoveryCode',
  'auth.mfa.verificationCode',
  'auth.mfa.useAuthenticatorInstead',
  'auth.mfa.useRecoveryInstead',
  'auth.mfa.recoveryAccepted',
  'auth.tab.signIn',
  'auth.tab.createAccount',
  'auth.signIn.heading',
  'auth.signIn.submit',
  'auth.field.email',
  'auth.field.emailPlaceholder',
  'auth.field.password',
  'auth.field.fullName',
  'auth.forgotPassword',
  'auth.password.show',
  'auth.password.hide',
  'auth.keepSignedIn',
  'auth.register.heading',
  'auth.terms.prefix',
  'auth.terms.link',
  'auth.terms.and',
  'auth.terms.privacy',
  'auth.terms.suffix',
  'auth.register.submit',
  'auth.switch.newHere',
  'auth.switch.alreadyHave',
  'auth.switch.createAccount',
  'auth.switch.signIn',
  'auth.pleaseWait',
  'auth.login',
  'auth.signOut',
  'auth.backToSignIn',
  'auth.forgot.pageTitle',
  'auth.forgot.hero.title',
  'auth.forgot.hero.lead',
  'auth.forgot.success.title',
  'auth.forgot.success.body',
  'auth.forgot.form.title',
  'auth.forgot.submit',
  'auth.reset.pageTitle',
  'auth.reset.hero.title',
  'auth.reset.hero.lead',
  'auth.reset.loading',
  'auth.reset.invalid.title',
  'auth.reset.invalid.body',
  'auth.reset.requestNewLink',
  'auth.reset.form.title',
  'auth.reset.confirmPassword',
  'auth.reset.mismatch',
  'auth.reset.submit',
  'auth.account.mfa.title',
  'auth.account.mfa.enabledIntro',
  'auth.account.mfa.replace',
  'auth.account.mfa.currentCodeLabel',
  'auth.account.mfa.continue',
  'auth.account.mfa.cancel',
  'auth.account.mfa.qrAlt',
  'auth.account.mfa.manualKeyPrefix',
  'auth.account.mfa.newCodeLabel',
  'auth.account.mfa.confirmNew',
  'auth.account.mfa.saveRecovery',
  'auth.account.mfa.done',
] as const;

export const CHROME_DOC_KEYS = [
  'header',
  'footer',
  'auth',
  'home',
  'browse',
  'auctions',
  'calendar',
  'help',
  'about',
  'legal',
  'contact',
  'categories',
  'product',
  'lot',
  'account',
] as const;

export type ChromeDocKey = (typeof CHROME_DOC_KEYS)[number];

const LABEL_MAX = 1500;

export const chromePublishSchema = z.object({
  key: z.enum(CHROME_DOC_KEYS),
  en: z.record(z.string(), z.string().max(LABEL_MAX)),
  ar: z.record(z.string(), z.string().max(LABEL_MAX)),
}).strict().superRefine((value, ctx) => {
  const allowed = new Set(chromeFieldsForKey(value.key));
  for (const locale of ['en', 'ar'] as const) {
    for (const field of Object.keys(value[locale])) {
      if (!allowed.has(field)) {
        ctx.addIssue({ code: 'custom', message: `Unknown label field: ${field}`, path: [locale, field] });
      }
    }
  }
});

export type ChromeLocaleLabels = Partial<Record<string, string>>;
export type ChromeBody = { en: ChromeLocaleLabels; ar: ChromeLocaleLabels };

function mergeLocale(existing: unknown, patch: ChromeLocaleLabels): ChromeLocaleLabels {
  const next: ChromeLocaleLabels = { ...(existing && typeof existing === 'object' ? existing as ChromeLocaleLabels : {}) };
  for (const [field, value] of Object.entries(patch)) {
    if (value?.trim()) next[field] = value.trim();
    else delete next[field];
  }
  return next;
}

/** Patch one chrome locale map without dropping keys from other Site labels tabs. */
export function mergeChromeBody(existing: unknown, patch: ChromeBody): ChromeBody {
  const current = existing && typeof existing === 'object' ? existing as ChromeBody : { en: {}, ar: {} };
  return { en: mergeLocale(current.en, patch.en), ar: mergeLocale(current.ar, patch.ar) };
}

export function chromeFieldsForKey(key: ChromeDocKey): readonly string[] {
  switch (key) {
    case 'header': return HEADER_LABEL_FIELDS;
    case 'footer': return FOOTER_LABEL_FIELDS;
    case 'auth': return AUTH_LABEL_FIELDS;
    case 'home': return HOME_LABEL_FIELDS;
    case 'browse': return BROWSE_LABEL_FIELDS;
    case 'auctions': return AUCTIONS_LABEL_FIELDS;
    case 'calendar': return CALENDAR_LABEL_FIELDS;
    case 'help': return HELP_LABEL_FIELDS;
    case 'about': return ABOUT_LABEL_FIELDS;
    case 'legal': return LEGAL_LABEL_FIELDS;
    case 'contact': return CONTACT_LABEL_FIELDS;
    case 'categories': return CATEGORIES_LABEL_FIELDS;
    case 'product': return PRODUCT_LABEL_FIELDS;
    case 'lot': return LOT_LABEL_FIELDS;
    case 'account': return ACCOUNT_LABEL_FIELDS;
  }
}
