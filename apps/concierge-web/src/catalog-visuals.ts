export type CatalogVisualItem = {
  sku: string;
  title: string;
  priceDisplay?: string;
  stock?: number;
  material?: string;
};

export function visualHue(seed: string): number {
  let hash = 0;
  for (const char of seed) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }
  return hash % 360;
}

export function visualKind(label: string, seed: string): string {
  const hay = `${seed} ${label}`.toLowerCase();
  if (/chocolate/.test(hay)) {
    return 'chocolate';
  }
  if (/flower|bouquet/.test(hay)) {
    return 'flowers';
  }
  if (/diya/.test(hay)) {
    return 'diya';
  }
  if (/scarf|silk/.test(hay)) {
    return 'scarf';
  }
  if (/tote|bag/.test(hay)) {
    return 'tote';
  }
  if (/beanie|wool/.test(hay) && !/throw/.test(hay)) {
    return 'beanie';
  }
  if (/sock/.test(hay)) {
    return 'socks';
  }
  if (/linen/.test(hay) && /shirt/.test(hay)) {
    return 'shirt';
  }
  if (/tee|t-shirt/.test(hay)) {
    return 'tee';
  }
  if (/\bshirt\b/.test(hay)) {
    return 'shirt';
  }
  if (/hamper/.test(hay)) {
    return 'hamper';
  }
  if (/note card|card/.test(hay) && !/clip/.test(hay)) {
    return 'card';
  }
  if (/frame/.test(hay)) {
    return 'frame';
  }
  if (/incense|agarbatti/.test(hay)) {
    return 'incense';
  }
  if (/vase/.test(hay)) {
    return 'vase';
  }
  if (/napkin/.test(hay)) {
    return 'napkin';
  }
  if (/turmeric|haldi/.test(hay)) {
    return 'turmeric';
  }
  if (/chili|chilli|mirch/.test(hay)) {
    return 'chili';
  }
  if (/\btea\b|chai/.test(hay) && !/hamper/.test(hay)) {
    return 'tea';
  }
  if (/beans|coffee beans/.test(hay)) {
    return 'beans';
  }
  if (/desk mat|cork/.test(hay)) {
    return 'mat';
  }
  if (/washi|tape/.test(hay)) {
    return 'tape';
  }
  if (/tray/.test(hay)) {
    return 'tray';
  }
  if (/filter/.test(hay)) {
    return 'filters';
  }
  if (/kettle/.test(hay)) {
    return 'kettle';
  }
  if (/pro/.test(hay) && /grinder/.test(hay)) {
    return 'grinder-pro';
  }
  if (/press|trailpress/.test(hay)) {
    return 'press';
  }
  if (/grinder/.test(hay)) {
    return 'grinder';
  }
  if (/pour-over|pour over|cleargo/.test(hay) || (/glass/.test(hay) && /brew|pour/.test(hay))) {
    return 'pourover';
  }
  if (/notebook|ruled/.test(hay)) {
    return 'notebook';
  }
  if (/pen|fineliner|marker/.test(hay)) {
    return 'pens';
  }
  if (/lamp/.test(hay)) {
    return 'lamp';
  }
  if (/clip/.test(hay)) {
    return 'clips';
  }
  if (/garam|masala/.test(hay)) {
    return 'masala';
  }
  if (/cumin|jeera/.test(hay)) {
    return 'cumin';
  }
  if (/mill/.test(hay)) {
    return 'mill';
  }
  if (/jar/.test(hay)) {
    return 'jar';
  }
  if (/candle/.test(hay)) {
    return 'candle';
  }
  if (/throw|blanket/.test(hay)) {
    return 'throw';
  }
  if (/mug|cup/.test(hay)) {
    return 'mug';
  }
  if (/desk|indigo/.test(hay)) {
    return 'shop-indigo-desk';
  }
  if (/northstar|coffee/.test(hay)) {
    return 'shop-northstar';
  }
  if (/harbor|spice/.test(hay)) {
    return 'shop-harbor-spice';
  }
  if (/sable|atelier|apparel/.test(hay)) {
    return 'shop-sable-atelier';
  }
  if (/lotus|gifting/.test(hay)) {
    return 'shop-lotus-gifting';
  }
  if (/marigold|home/.test(hay)) {
    return 'shop-marigold-home';
  }
  return 'shop';
}

const THUMB_BY_SEED: Record<string, string> = {
  'tee.crew-cotton': '/thumbs/tee.jpg',
  'scarf.silk-sand': '/thumbs/scarf.jpg',
  'tote.canvas-day': '/thumbs/tote.jpg',
  'brewer.trailpress-steel-750': '/thumbs/press.jpg',
  'grinder.pocket-lite': '/thumbs/grinder.jpg',
  'filters.travel-30': '/thumbs/filters.jpg',
  'grinder.pocket-pro': '/thumbs/grinder-pro.jpg',
  'brewer.clear-glass-500': '/thumbs/pourover.jpg',
  'kettle.road-mini': '/thumbs/kettle.jpg',
  'note.ruled-a5': '/thumbs/notebook.jpg',
  'pen.fineliner-set': '/thumbs/pens.jpg',
  'lamp.desk-arm': '/thumbs/lamp.jpg',
  'clip.binder-24': '/thumbs/clips.jpg',
  'spice.garam-100': '/thumbs/masala.jpg',
  'spice.cumin-200': '/thumbs/cumin.jpg',
  'mill.cast-iron': '/thumbs/mill.jpg',
  'jar.glass-spice': '/thumbs/jar.jpg',
  'gift.chocolate-box': '/thumbs/chocolate.jpg',
  'gift.dried-flowers': '/thumbs/flowers.jpg',
  'gift.brass-diya': '/thumbs/diya.jpg',
  'home.soy-candle': '/thumbs/candle.jpg',
  'home.cotton-throw': '/thumbs/throw.jpg',
  'home.ceramic-mug': '/thumbs/mug.jpg',
  'mug.steel-travel': '/thumbs/travel-mug.jpg',
  'beans.house-250': '/thumbs/beans.jpg',
  'shirt.linen-sand': '/thumbs/shirt.jpg',
  'beanie.wool-oat': '/thumbs/beanie.jpg',
  'sock.cotton-crew': '/thumbs/socks.jpg',
  'mat.desk-cork': '/thumbs/mat.jpg',
  'tape.washi-set': '/thumbs/tape.jpg',
  'tray.letter': '/thumbs/tray.jpg',
  'spice.turmeric-100': '/thumbs/turmeric.jpg',
  'spice.chili-100': '/thumbs/chili.jpg',
  'tea.assam-200': '/thumbs/tea.jpg',
  'gift.tea-hamper': '/thumbs/hamper.jpg',
  'gift.note-card': '/thumbs/card.jpg',
  'gift.photo-frame': '/thumbs/frame.jpg',
  'home.incense-sandal': '/thumbs/incense.jpg',
  'home.ceramic-vase': '/thumbs/vase.jpg',
  'home.napkin-set': '/thumbs/napkin.jpg',
  northstar: '/thumbs/shop-northstar.jpg',
  'indigo-desk': '/thumbs/shop-indigo-desk.jpg',
  'harbor-spice': '/thumbs/shop-harbor-spice.jpg',
  'sable-atelier': '/thumbs/shop-sable-atelier.jpg',
  'lotus-gifting': '/thumbs/shop-lotus-gifting.jpg',
  'marigold-home': '/thumbs/shop-marigold-home.jpg',
};

export function catalogThumbSrc(label: string, seed: string): string {
  const mapped = THUMB_BY_SEED[seed];
  if (mapped) {
    return mapped;
  }
  return `/thumbs/${visualKind(label, seed)}.jpg`;
}

function stripMarks(value: string): string {
  return value
    .replace(/\*\*/g, '')
    .replace(/`/g, '')
    .replace(/^\s*(?:[-*•]|\d+\.)\s+/, '')
    .trim();
}

export function normalizeProductTitle(title: string): string {
  return title
    .replace(/\s*[×xX]\s*\d+\s*$/u, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function resolveCatalogItem(
  item: CatalogVisualItem,
  catalog: CatalogVisualItem[] = [],
): CatalogVisualItem {
  const bySku = catalog.find((row) => row.sku === item.sku);
  if (bySku) {
    return bySku;
  }
  const title = normalizeProductTitle(item.title).toLowerCase();
  const byTitle = catalog.find((row) => row.title.toLowerCase() === title);
  return byTitle ?? { ...item, title: normalizeProductTitle(item.title) };
}

export function catalogItemsInText<T extends CatalogVisualItem>(text: string, items: T[]): T[] {
  const hay = text.toLowerCase();
  const matched: T[] = [];
  for (const item of items) {
    const title = item.title.trim().toLowerCase();
    if (title.length < 3) {
      continue;
    }
    if (hay.includes(title) || hay.includes(item.sku.toLowerCase())) {
      matched.push(item);
      continue;
    }
    const tokens = title.split(/[^a-z0-9]+/).filter((token) => token.length >= 4);
    if (tokens.length > 0 && tokens.every((token) => hay.includes(token))) {
      matched.push(item);
    }
  }
  return matched;
}

export function productsFromMessage(
  text: string,
  catalog: CatalogVisualItem[] = [],
): CatalogVisualItem[] {
  const listed: CatalogVisualItem[] = [];
  for (const raw of text.split('\n')) {
    const line = stripMarks(raw);
    const priced =
      line.match(/^(.{3,80}?)\s+[—–-]\s+(₹[\d,]+(?:\.\d{1,2})?)\s*$/) ??
      line.match(/^(.{3,80}?)\s+\((₹[\d,]+(?:\.\d{1,2})?)\)\s*$/);
    if (!priced) {
      continue;
    }
    const title = normalizeProductTitle(priced[1].replace(/\s+/g, ' ').trim());
    if (!title || /reviews|shops that match|strong start/i.test(title)) {
      continue;
    }
    const priceDisplay = priced[2];
    const hit = catalog.find((item) => item.title.toLowerCase() === title.toLowerCase());
    listed.push(
      hit ?? {
        sku: `listed.${title
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-|-$/g, '')}`,
        title,
        priceDisplay,
      },
    );
  }
  if (listed.length > 0) {
    return listed;
  }
  return catalogItemsInText(text, catalog);
}
