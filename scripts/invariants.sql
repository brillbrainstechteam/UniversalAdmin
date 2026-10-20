-- Business invariants checked after a restore (and usable against any environment, read-only).
-- Every row must report violations = 0. See docs/runbooks/BACKUP-RESTORE.md.
\pset footer off
select 'stock balances negative' as invariant, count(*) as violations
  from stock_balances where on_hand < 0 or reserved < 0 or committed < 0
union all
select 'stock balance differs from ledger', count(*) from (
  select b.id
    from stock_balances b
    left join (
      select variant_id, location_id, condition,
             sum(on_hand_delta) as oh, sum(reserved_delta) as r, sum(committed_delta) as c
        from stock_movements group by 1, 2, 3
    ) l on l.variant_id = b.variant_id and l.location_id = b.location_id and l.condition = b.condition
   where b.on_hand <> coalesce(l.oh, 0) or b.reserved <> coalesce(l.r, 0) or b.committed <> coalesce(l.c, 0)
) x
union all
select 'piece on more than one live order line', count(*) from (
  select ol.serial_item_id
    from order_lines ol join orders o on o.id = ol.order_id
   where ol.serial_item_id is not null and o.status <> 'cancelled'
   group by 1 having count(*) > 1
) x
union all
select 'order total <> subtotal - discount + tax', count(*)
  from orders where total_minor <> subtotal_minor - discount_minor + tax_minor
union all
select 'refunds exceed captured payment', count(*) from (
  select p.id from payments p join refunds r on r.payment_id = p.id and r.status = 'succeeded'
   group by p.id, p.amount_minor having sum(r.amount_minor) > p.amount_minor
) x
union all
select 'discount usage differs from redemptions', count(*) from (
  select d.id from discounts d left join discount_redemptions dr on dr.discount_id = d.id
   group by d.id, d.used_count having d.used_count <> count(dr.id)
) x
union all
select 'credit ledger entry with wrong sign', count(*)
  from credit_entries where (type = 'order_charge' and amount_minor <= 0) or (type in ('payment','advance','order_release') and amount_minor >= 0);
