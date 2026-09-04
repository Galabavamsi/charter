import { useParams } from 'react-router';
import { useAccount, type AccountShop } from './account';

export function useMerchantShop(): AccountShop {
  const { account } = useAccount();
  const { shopId = '' } = useParams();
  const shop = account?.shops.find((candidate) => candidate.tenantId === shopId);
  if (!shop) {
    throw new Error('MERCHANT_SHOP_CONTEXT_REQUIRED');
  }
  return shop;
}
