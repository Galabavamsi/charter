import type { PlatformRole, ShopRole } from './account';

const SHOP_CAPABILITIES = {
  registerRead: ['owner', 'admin', 'catalog', 'support', 'finance', 'viewer'],
  catalogWrite: ['owner', 'admin', 'catalog'],
  orderRead: ['owner', 'admin', 'catalog', 'support', 'finance', 'viewer'],
  approvalWrite: ['owner', 'admin'],
  catalogPublishApprove: ['owner', 'admin', 'catalog'],
  refundApprove: ['owner', 'admin', 'finance'],
  campaignApprove: ['owner', 'admin'],
  recoveryRead: ['owner', 'admin', 'support'],
  recoveryOperate: ['owner', 'admin', 'support'],
  rulesWrite: ['owner', 'admin'],
  settingsWrite: ['owner', 'admin'],
} as const satisfies Record<string, readonly ShopRole[]>;

const CONTROL_READ_ROLES = ['operator', 'admin'] as const satisfies readonly PlatformRole[];
const CONTROL_KILL_ROLES = ['admin'] as const satisfies readonly PlatformRole[];

function hasShopCapability(role: ShopRole, allowedRoles: readonly ShopRole[]): boolean {
  return allowedRoles.includes(role);
}

function hasPlatformCapability(
  roles: readonly PlatformRole[],
  allowedRoles: readonly PlatformRole[],
): boolean {
  return roles.some((role) => allowedRoles.includes(role));
}

export function canReadRegister(role: ShopRole): boolean {
  return hasShopCapability(role, SHOP_CAPABILITIES.registerRead);
}

export function canManageCatalog(role: ShopRole): boolean {
  return hasShopCapability(role, SHOP_CAPABILITIES.catalogWrite);
}

export function canDecideApprovals(role: ShopRole): boolean {
  return hasShopCapability(role, SHOP_CAPABILITIES.approvalWrite);
}

export function canDecideCatalogPublish(role: ShopRole): boolean {
  return hasShopCapability(role, SHOP_CAPABILITIES.catalogPublishApprove);
}

export function canDecideRefunds(role: ShopRole): boolean {
  return hasShopCapability(role, SHOP_CAPABILITIES.refundApprove);
}

export function canDecideCampaigns(role: ShopRole): boolean {
  return hasShopCapability(role, SHOP_CAPABILITIES.campaignApprove);
}

export function merchantSectionForRole(role: ShopRole, section: string): string {
  if (section === 'recovery' && !canReadRecovery(role)) {
    return 'overview';
  }
  if (section === 'orders' && !canReadOrders(role)) {
    return 'overview';
  }
  return section;
}

export function canReadOrders(role: ShopRole): boolean {
  return hasShopCapability(role, SHOP_CAPABILITIES.orderRead);
}

export function canReadRecovery(role: ShopRole): boolean {
  return hasShopCapability(role, SHOP_CAPABILITIES.recoveryRead);
}

export function canOperateRecovery(role: ShopRole): boolean {
  return hasShopCapability(role, SHOP_CAPABILITIES.recoveryOperate);
}

export function canManageRules(role: ShopRole): boolean {
  return hasShopCapability(role, SHOP_CAPABILITIES.rulesWrite);
}

export function canManageSettings(role: ShopRole): boolean {
  return hasShopCapability(role, SHOP_CAPABILITIES.settingsWrite);
}

export function canReadControl(roles: readonly PlatformRole[]): boolean {
  return hasPlatformCapability(roles, CONTROL_READ_ROLES);
}

export function canManageControlKills(roles: readonly PlatformRole[]): boolean {
  return hasPlatformCapability(roles, CONTROL_KILL_ROLES);
}
