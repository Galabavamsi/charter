update policy.shop_policies
set
  hard_cap_minor = 1500000,
  autonomous_cap_minor = 1500000,
  updated_at = now()
where tenant_id in (
  'indigo-desk-in',
  'harbor-spice-in',
  'sable-atelier-in',
  'lotus-gifting-in',
  'marigold-home-in'
)
  and hard_cap_minor = 500000
  and autonomous_cap_minor = 250000;
