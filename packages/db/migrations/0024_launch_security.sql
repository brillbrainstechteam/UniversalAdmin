-- Phase 12: plans (proposed limits, to be confirmed commercially), tenant plan and support-session links, tenant isolation for support grants, owner-only support approval (ADR-027).
INSERT INTO plans (key, name, description, limits) VALUES
  ('pilot', 'Pilot', 'Pilot merchants: no limits, by agreement.', '{"products":null,"staffSeats":null,"locations":null,"domains":null,"ordersPerMonth":null}'),
  ('starter', 'Starter', 'Proposed limits for small merchants (to be confirmed commercially).', '{"products":500,"staffSeats":5,"locations":2,"domains":1,"ordersPerMonth":500}'),
  ('growth', 'Growth', 'Proposed limits for growing merchants (to be confirmed commercially).', '{"products":10000,"staffSeats":25,"locations":10,"domains":5,"ordersPerMonth":10000}')
ON CONFLICT (key) DO NOTHING;--> statement-breakpoint
ALTER TABLE tenants ADD CONSTRAINT tenants_plan_key_plans_key_fk FOREIGN KEY (plan_key) REFERENCES plans(key) ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE sessions ADD CONSTRAINT sessions_support_grant_id_fk FOREIGN KEY (support_grant_id) REFERENCES support_grants(id) ON DELETE CASCADE;--> statement-breakpoint
CREATE INDEX sessions_support_grant_idx ON sessions (support_grant_id) WHERE support_grant_id IS NOT NULL;--> statement-breakpoint
ALTER TABLE support_grants ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY support_grants_tenant_isolation ON support_grants USING (uc_tenant_visible(tenant_id)) WITH CHECK (uc_tenant_visible(tenant_id));--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON support_grants FROM uc_app;--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON plans FROM uc_app;--> statement-breakpoint
UPDATE roles SET permissions = ARRAY(SELECT DISTINCT unnest(permissions || ARRAY['support.manage']) ORDER BY 1), version = version + 1 WHERE is_system AND key = 'owner';
