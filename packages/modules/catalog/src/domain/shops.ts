import type { CatalogVariant } from './northstar.js';

export type ShopSeed = {
  tenantId: string;
  slug: string;
  name: string;
  blurb: string;
  forbiddenMaterials: readonly string[];
  variants: CatalogVariant[];
};

/** Inclusive spend ceiling for directory demo shops so a full gift mix can check out. */
export const SEEDED_SHOP_HARD_CAP_MINOR = 1500000n;
export const SEEDED_SHOP_AUTONOMOUS_CAP_MINOR = 1500000n;
const STALE_SEEDED_HARD_CAP_MINOR = 500000n;
const STALE_SEEDED_AUTONOMOUS_CAP_MINOR = 250000n;

/** Directory ratings for published shops. */
export const DEMO_SHOP_METRICS: Readonly<
  Record<string, { ratingMilli: number; reviewCount: number }>
> = {
  'northstar-demo-in': { ratingMilli: 4800, reviewCount: 128 },
  'indigo-desk-in': { ratingMilli: 4600, reviewCount: 54 },
  'harbor-spice-in': { ratingMilli: 4200, reviewCount: 36 },
  'sable-atelier-in': { ratingMilli: 4700, reviewCount: 89 },
  'lotus-gifting-in': { ratingMilli: 4500, reviewCount: 112 },
  'marigold-home-in': { ratingMilli: 4400, reviewCount: 67 },
};

/** Published shop profile copy. */
export const DEMO_SHOP_PROFILES: Readonly<
  Record<string, { gstin: string; addressLine: string; refundPolicy: string }>
> = {
  'northstar-demo-in': {
    gstin: '29AAAAA0000A1Z5',
    addressLine: '12 Brigade Road, Bengaluru 560001',
    refundPolicy:
      'Unused kit in original packaging within 7 days of capture. Return shipping is on the shopper.',
  },
  'indigo-desk-in': {
    gstin: '27AAAAA0000A1Z5',
    addressLine: '4 Bandra West, Mumbai 400050',
    refundPolicy: 'Unopened stationery within 7 days of capture.',
  },
  'harbor-spice-in': {
    gstin: '33AAAAA0000A1Z5',
    addressLine: '8 T. Nagar, Chennai 600017',
    refundPolicy: 'Sealed packets within 7 days of capture.',
  },
  'sable-atelier-in': {
    gstin: '29BBBBB0000B1Z5',
    addressLine: '22 Indiranagar 100 Feet Road, Bengaluru 560038',
    refundPolicy: 'Unworn garments with tags within 7 days of capture.',
  },
  'lotus-gifting-in': {
    gstin: '07CCCCC0000C1Z5',
    addressLine: '15 Khan Market, New Delhi 110003',
    refundPolicy: 'Unopened gift sets within 7 days of capture.',
  },
  'marigold-home-in': {
    gstin: '27DDDDD0000D1Z5',
    addressLine: '9 Koregaon Park, Pune 411001',
    refundPolicy: 'Unused home goods in original packaging within 7 days of capture.',
  },
};

export const INDIGO_DESK: ShopSeed = {
  tenantId: 'indigo-desk-in',
  slug: 'indigo-desk',
  name: 'Indigo Desk',
  blurb: 'Stationery, notebooks, pens, and a lamp for a small office.',
  forbiddenMaterials: [],
  variants: [
    {
      sku: 'note.ruled-a5',
      title: 'Ruled notebook, A5',
      priceMinor: 19900n,
      stock: 40,
      material: 'paper',
      published: true,
      aliases: ['notebook', 'copy', 'stationery', 'office', 'paper'],
    },
    {
      sku: 'mat.desk-cork',
      title: 'Cork desk mat',
      priceMinor: 89900n,
      stock: 14,
      material: 'other',
      published: true,
      aliases: ['mat', 'desk', 'stationery'],
    },
    {
      sku: 'tape.washi-set',
      title: 'Washi tape set',
      priceMinor: 24900n,
      stock: 20,
      material: 'paper',
      published: true,
      aliases: ['tape', 'washi', 'stationery'],
    },
    {
      sku: 'tray.letter',
      title: 'Letter tray',
      priceMinor: 59900n,
      stock: 9,
      material: 'other',
      published: true,
      aliases: ['tray', 'inbox', 'office'],
    },
    {
      sku: 'pen.fineliner-set',
      title: 'Fine liner set',
      priceMinor: 34900n,
      stock: 18,
      material: 'other',
      published: true,
      aliases: ['pens', 'markers', 'stationery'],
    },
    {
      sku: 'lamp.desk-arm',
      title: 'Desk lamp',
      priceMinor: 129900n,
      stock: 6,
      material: 'other',
      published: true,
      aliases: ['lamp', 'light'],
    },
    {
      sku: 'clip.binder-24',
      title: 'Binder clips, 24 pack',
      priceMinor: 8900n,
      stock: 0,
      material: 'other',
      published: true,
      aliases: ['clips'],
    },
  ],
};

export const HARBOR_SPICE: ShopSeed = {
  tenantId: 'harbor-spice-in',
  slug: 'harbor-spice',
  name: 'Harbor Spice',
  blurb: 'Everyday masala and tea. Glass jars are not sold.',
  forbiddenMaterials: ['glass'],
  variants: [
    {
      sku: 'spice.garam-100',
      title: 'Garam masala, 100 g',
      priceMinor: 14900n,
      stock: 50,
      material: 'other',
      published: true,
      aliases: ['masala', 'garam'],
    },
    {
      sku: 'spice.cumin-200',
      title: 'Whole cumin, 200 g',
      priceMinor: 11900n,
      stock: 35,
      material: 'other',
      published: true,
      aliases: ['jeera', 'cumin'],
    },
    {
      sku: 'spice.turmeric-100',
      title: 'Turmeric, 100 g',
      priceMinor: 12900n,
      stock: 40,
      material: 'other',
      published: true,
      aliases: ['haldi', 'turmeric'],
    },
    {
      sku: 'spice.chili-100',
      title: 'Red chili, 100 g',
      priceMinor: 13900n,
      stock: 38,
      material: 'other',
      published: true,
      aliases: ['chili', 'chilli', 'mirch'],
    },
    {
      sku: 'tea.assam-200',
      title: 'Assam tea, 200 g',
      priceMinor: 29900n,
      stock: 24,
      material: 'other',
      published: true,
      aliases: ['tea', 'chai'],
    },
    {
      sku: 'mill.cast-iron',
      title: 'Cast iron mill',
      priceMinor: 89900n,
      stock: 7,
      material: 'other',
      published: true,
      aliases: ['grinder', 'mill'],
    },
    {
      sku: 'jar.glass-spice',
      title: 'Glass spice jar',
      priceMinor: 24900n,
      stock: 12,
      material: 'glass',
      published: true,
      aliases: ['jar', 'glass jar'],
    },
  ],
};

export const SABLE_ATELIER: ShopSeed = {
  tenantId: 'sable-atelier-in',
  slug: 'sable-atelier',
  name: 'Sable Atelier',
  blurb: 'Quiet cotton tees, scarves, and a tote for everyday wear.',
  forbiddenMaterials: [],
  variants: [
    {
      sku: 'tee.crew-cotton',
      title: 'Cotton crew tee',
      priceMinor: 129900n,
      stock: 24,
      material: 'other',
      published: true,
      aliases: ['tshirt', 't-shirt', 'tee', 'shirt', 'top'],
    },
    {
      sku: 'scarf.silk-sand',
      title: 'Sand silk scarf',
      priceMinor: 249900n,
      stock: 9,
      material: 'other',
      published: true,
      aliases: ['scarf', 'gift', 'silk'],
    },
    {
      sku: 'tote.canvas-day',
      title: 'Canvas day tote',
      priceMinor: 189900n,
      stock: 14,
      material: 'other',
      published: true,
      aliases: ['bag', 'tote', 'gift'],
    },
    {
      sku: 'shirt.linen-sand',
      title: 'Sand linen shirt',
      priceMinor: 219900n,
      stock: 11,
      material: 'other',
      published: true,
      aliases: ['linen', 'shirt', 'top', 'gift'],
    },
    {
      sku: 'beanie.wool-oat',
      title: 'Oat wool beanie',
      priceMinor: 89900n,
      stock: 16,
      material: 'other',
      published: true,
      aliases: ['beanie', 'hat', 'wool', 'gift'],
    },
    {
      sku: 'sock.cotton-crew',
      title: 'Cotton crew socks',
      priceMinor: 49900n,
      stock: 28,
      material: 'other',
      published: true,
      aliases: ['socks', 'gift'],
    },
  ],
};

export const LOTUS_GIFTING: ShopSeed = {
  tenantId: 'lotus-gifting-in',
  slug: 'lotus-gifting',
  name: 'Lotus Gifting',
  blurb: 'Wrapped sets for birthdays, anniversaries, and someone you like.',
  forbiddenMaterials: ['glass'],
  variants: [
    {
      sku: 'gift.chocolate-box',
      title: 'Assorted chocolate box',
      priceMinor: 79900n,
      stock: 30,
      material: 'other',
      published: true,
      aliases: ['gift', 'chocolate', 'present', 'gf', 'girlfriend'],
    },
    {
      sku: 'gift.dried-flowers',
      title: 'Dried flower bunch',
      priceMinor: 64900n,
      stock: 18,
      material: 'other',
      published: true,
      aliases: ['flowers', 'bouquet', 'gift', 'girlfriend'],
    },
    {
      sku: 'gift.brass-diya',
      title: 'Brass diya set',
      priceMinor: 54900n,
      stock: 22,
      material: 'other',
      published: true,
      aliases: ['diya', 'gift', 'brass'],
    },
    {
      sku: 'gift.tea-hamper',
      title: 'Tea hamper',
      priceMinor: 99900n,
      stock: 12,
      material: 'other',
      published: true,
      aliases: ['hamper', 'tea', 'gift'],
    },
    {
      sku: 'gift.note-card',
      title: 'Handmade note card',
      priceMinor: 19900n,
      stock: 40,
      material: 'paper',
      published: true,
      aliases: ['card', 'note', 'gift'],
    },
    {
      sku: 'gift.photo-frame',
      title: 'Oak photo frame',
      priceMinor: 79900n,
      stock: 15,
      material: 'other',
      published: true,
      aliases: ['frame', 'photo', 'gift'],
    },
  ],
};

export const MARIGOLD_HOME: ShopSeed = {
  tenantId: 'marigold-home-in',
  slug: 'marigold-home',
  name: 'Marigold Home',
  blurb: 'Candles, throws, and a mug for a quieter room.',
  forbiddenMaterials: ['glass'],
  variants: [
    {
      sku: 'home.soy-candle',
      title: 'Soy candle, sandalwood',
      priceMinor: 89900n,
      stock: 16,
      material: 'other',
      published: true,
      aliases: ['candle', 'gift', 'home'],
    },
    {
      sku: 'home.cotton-throw',
      title: 'Cotton throw',
      priceMinor: 219900n,
      stock: 8,
      material: 'other',
      published: true,
      aliases: ['throw', 'blanket', 'gift'],
    },
    {
      sku: 'home.ceramic-mug',
      title: 'Speckled ceramic mug',
      priceMinor: 49900n,
      stock: 20,
      material: 'other',
      published: true,
      aliases: ['mug', 'cup', 'gift'],
    },
    {
      sku: 'home.incense-sandal',
      title: 'Sandal incense',
      priceMinor: 34900n,
      stock: 26,
      material: 'other',
      published: true,
      aliases: ['incense', 'agarbatti', 'gift'],
    },
    {
      sku: 'home.ceramic-vase',
      title: 'Ceramic bud vase',
      priceMinor: 129900n,
      stock: 10,
      material: 'other',
      published: true,
      aliases: ['vase', 'home', 'gift'],
    },
    {
      sku: 'home.napkin-set',
      title: 'Linen napkin set',
      priceMinor: 69900n,
      stock: 18,
      material: 'other',
      published: true,
      aliases: ['napkin', 'linen', 'table'],
    },
  ],
};

export const SEEDED_SHOPS: readonly ShopSeed[] = [
  INDIGO_DESK,
  HARBOR_SPICE,
  SABLE_ATELIER,
  LOTUS_GIFTING,
  MARIGOLD_HOME,
];

export function isSeededDirectoryShop(tenantId: string): boolean {
  return SEEDED_SHOPS.some((row) => row.tenantId === tenantId);
}

export function liftStaleSeededShopCaps<
  T extends { hardCapMinor: bigint; autonomousCapMinor: bigint },
>(tenantId: string, authority: T): T {
  if (!isSeededDirectoryShop(tenantId)) {
    return authority;
  }
  if (
    authority.hardCapMinor === STALE_SEEDED_HARD_CAP_MINOR &&
    authority.autonomousCapMinor === STALE_SEEDED_AUTONOMOUS_CAP_MINOR
  ) {
    return {
      ...authority,
      hardCapMinor: SEEDED_SHOP_HARD_CAP_MINOR,
      autonomousCapMinor: SEEDED_SHOP_AUTONOMOUS_CAP_MINOR,
    };
  }
  return authority;
}
