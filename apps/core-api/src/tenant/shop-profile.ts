export function normalizeShopProfile(input: {
  gstin?: string;
  addressLine?: string;
  refundPolicy?: string;
  previous: { gstin: string; addressLine: string; refundPolicy: string };
}): { gstin: string; addressLine: string; refundPolicy: string } {
  const gstin = input.gstin === undefined ? input.previous.gstin : input.gstin.trim().toUpperCase();
  if (gstin !== '' && !/^[0-9A-Z]{15}$/.test(gstin)) {
    throw new Error('SETTINGS_INVALID');
  }
  const addressLine =
    input.addressLine === undefined ? input.previous.addressLine : input.addressLine.trim();
  if (addressLine.length > 300) {
    throw new Error('SETTINGS_INVALID');
  }
  const refundPolicy =
    input.refundPolicy === undefined ? input.previous.refundPolicy : input.refundPolicy.trim();
  if (refundPolicy.length > 2000) {
    throw new Error('SETTINGS_INVALID');
  }
  return { gstin, addressLine, refundPolicy };
}
