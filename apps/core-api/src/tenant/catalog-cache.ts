import {
  copyOfferRule,
  hydrateMerchantCache,
  liftStaleSeededShopCaps,
  NORTHSTAR_TENANT,
  NORTHSTAR_VARIANTS,
  SEEDED_SHOPS,
  type CatalogVariant,
} from '@charter/catalog';
import type { ShopRecord, TenantRepository } from './repository.js';

function seededVariantsFor(tenantId: string) {
  if (tenantId === NORTHSTAR_TENANT) {
    return NORTHSTAR_VARIANTS;
  }
  return SEEDED_SHOPS.find((row) => row.tenantId === tenantId)?.variants ?? [];
}

function mergeSeededCatalog(tenantId: string, items: CatalogVariant[]): CatalogVariant[] {
  const have = new Set(items.map((item) => item.sku));
  const extra = seededVariantsFor(tenantId)
    .filter((row) => !have.has(row.sku))
    .map((row) => ({
      sku: row.sku,
      title: row.title,
      priceMinor: row.priceMinor,
      stock: row.stock,
      material: row.material,
      published: row.published,
      aliases: [...(row.aliases ?? [])],
    }));
  return extra.length > 0 ? [...items, ...extra] : items;
}

export async function hydrateCatalogCache(
  repository: TenantRepository,
  shop: ShopRecord,
  memberUserId?: string,
): Promise<void> {
  const [items, policy] = await Promise.all([
    memberUserId
      ? repository.listCatalogForMember(memberUserId, shop.tenantId)
      : repository.listCatalog(shop.tenantId),
    repository.getPolicy(shop.tenantId),
  ]);
  if (!policy) {
    throw new Error('SHOP_POLICY_NOT_FOUND');
  }
  hydrateMerchantCache({
    tenantId: shop.tenantId,
    slug: shop.slug,
    name: shop.name,
    label: shop.label,
    blurb: shop.blurb,
    synthetic: shop.synthetic,
    currency: 'INR',
    catalogVersion: shop.version ?? 1,
    policyVersion: policy.version,
    variants: mergeSeededCatalog(
      shop.tenantId,
      items.map((item) => ({
        sku: item.sku,
        title: item.title,
        priceMinor: BigInt(item.priceMinor),
        stock: item.stock,
        material: item.material,
        published: item.published,
        aliases: [...item.aliases],
      })),
    ),
    authority: liftStaleSeededShopCaps(shop.tenantId, {
      hardCapMinor: policy.hardCapMinor,
      autonomousCapMinor: policy.autonomousCapMinor,
      forbiddenMaterials: [...policy.forbiddenMaterials],
    }),
    offers: policy.offers.map(copyOfferRule),
    ...(shop.refundPolicy === undefined ? {} : { refundPolicy: shop.refundPolicy }),
  });
}
