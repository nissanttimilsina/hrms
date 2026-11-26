-- Plans are sold as Basic / Professional / Business / Enterprise.
-- Rename the two middle plans in place (ids, prices, subscriptions and history are kept).
UPDATE plans SET code = 'PROFESSIONAL', name = 'Professional' WHERE code = 'STANDARD';
UPDATE plans SET code = 'BUSINESS',     name = 'Business'     WHERE code = 'PREMIUM';
UPDATE coupons SET plan_codes = array_replace(array_replace(plan_codes, 'STANDARD', 'PROFESSIONAL'), 'PREMIUM', 'BUSINESS')
 WHERE plan_codes && ARRAY['STANDARD', 'PREMIUM'];
UPDATE platform_settings SET value = to_jsonb(CASE value #>> '{}' WHEN 'STANDARD' THEN 'PROFESSIONAL' WHEN 'PREMIUM' THEN 'BUSINESS' END)
 WHERE key = 'signup.default_plan' AND value #>> '{}' IN ('STANDARD', 'PREMIUM');
UPDATE cms_entries SET body = replace(body, 'Premium and Enterprise', 'Business and Enterprise') WHERE body LIKE '%Premium and Enterprise%';
