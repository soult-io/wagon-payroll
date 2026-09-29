-- Custom SQL migration (hand-written, Spec 26 (PAY-173) C12) — not expressible
-- in Drizzle's DSL.
--
-- The FUTA annual cap is per calendar year of PAYMENT (IRC 3306(b)(1)): the
-- trigger function from 0017 grouped employer_futa by the period-start year,
-- so a December period paid in January was added to the previous year's
-- total and rejected. Body identical to 0017 except both
--   EXTRACT(YEAR FROM r.period_start)  ->  EXTRACT(YEAR FROM r.pay_date)
-- The trigger object payroll_entries_futa_annual_cap is unchanged (it calls
-- the function by name). CREATE OR REPLACE FUNCTION takes no table lock and
-- rewrites no rows. Forward-only: to restore the old body, add a new
-- migration with 0017's body.

CREATE OR REPLACE FUNCTION payroll_entries_enforce_futa_annual_cap() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  v_employee_id integer;
  v_tax_year integer;
  v_cap numeric(12,2);
  v_total numeric(12,2);
  v_periods integer;
BEGIN
  IF NEW.category <> 'employer_futa' THEN
    RETURN NEW;
  END IF;

  SELECT r.employee_id, EXTRACT(YEAR FROM r.pay_date)::integer
    INTO v_employee_id, v_tax_year
    FROM "payroll_runs" r
   WHERE r.id = NEW.run_id;

  SELECT round((tc.futa_wage_cap * tc.futa_rate)::numeric, 2)
    INTO v_cap
    FROM "tax_config" tc
   WHERE tc.jurisdiction = 'federal' AND tc.tax_year = v_tax_year;

  IF v_cap IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT COALESCE(SUM(e.amount), 0)::numeric(12,2), COUNT(*)
    INTO v_total, v_periods
    FROM "payroll_entries" e
    JOIN "payroll_runs" r ON r.id = e.run_id
   WHERE e.category = 'employer_futa'
     AND r.employee_id = v_employee_id
     AND r.status = 'issued'
     AND EXTRACT(YEAR FROM r.pay_date)::integer = v_tax_year;

  IF v_total + NEW.amount > v_cap + (0.005 * (v_periods + 1))::numeric THEN
    RAISE EXCEPTION 'employer_futa annual cap exceeded for employee % in %: % > cap % (futa_wage_cap × futa_rate)',
      v_employee_id, v_tax_year, v_total + NEW.amount, v_cap;
  END IF;

  RETURN NEW;
END;
$$;
