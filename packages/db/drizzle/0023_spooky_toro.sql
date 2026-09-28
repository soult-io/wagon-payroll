CREATE TABLE "employee_residences" (
	"id" serial PRIMARY KEY NOT NULL,
	"employee_id" integer NOT NULL,
	"country" text NOT NULL,
	"state_code" text,
	"locality_code" text,
	"effective_from" date NOT NULL,
	"effective_to" date,
	"source" text DEFAULT 'admin' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "employee_residences_employee_effective_uniq" UNIQUE("employee_id","effective_from"),
	CONSTRAINT "employee_residences_country_check" CHECK ("employee_residences"."country" ~ '^[A-Z]{2}$'),
	CONSTRAINT "employee_residences_us_state_check" CHECK (("employee_residences"."country" = 'US') = ("employee_residences"."state_code" IS NOT NULL)),
	CONSTRAINT "employee_residences_state_code_check" CHECK ("employee_residences"."state_code" IS NULL OR "employee_residences"."state_code" ~ '^[A-Z]{2}$'),
	CONSTRAINT "employee_residences_locality_check" CHECK ("employee_residences"."locality_code" IS NULL OR "employee_residences"."locality_code" IN ('NY-NYC','NY-YONKERS','MD-001','MD-003','MD-005','MD-009','MD-011','MD-013','MD-015','MD-017','MD-019','MD-021','MD-023','MD-025','MD-027','MD-029','MD-031','MD-033','MD-035','MD-037','MD-039','MD-041','MD-043','MD-045','MD-047','MD-510')),
	CONSTRAINT "employee_residences_locality_state_check" CHECK ("employee_residences"."locality_code" IS NULL OR ("employee_residences"."state_code" IS NOT NULL AND "employee_residences"."locality_code" LIKE "employee_residences"."state_code" || '-%')),
	CONSTRAINT "employee_residences_md_county_check" CHECK ("employee_residences"."state_code" IS DISTINCT FROM 'MD' OR "employee_residences"."locality_code" IS NOT NULL),
	CONSTRAINT "employee_residences_window_check" CHECK ("employee_residences"."effective_to" IS NULL OR "employee_residences"."effective_to" > "employee_residences"."effective_from"),
	CONSTRAINT "employee_residences_source_check" CHECK ("employee_residences"."source" IN ('admin','certificate'))
);
--> statement-breakpoint
CREATE TABLE "local_tax_coverage" (
	"code" text NOT NULL,
	"basis" text NOT NULL,
	"handling" text NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"source" text DEFAULT '' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "local_tax_coverage_pk" PRIMARY KEY("code","basis"),
	CONSTRAINT "local_tax_coverage_code_check" CHECK ("local_tax_coverage"."code" ~ '^[A-Z]{2}(-[A-Z0-9]{2,10})?$'),
	CONSTRAINT "local_tax_coverage_basis_check" CHECK ("local_tax_coverage"."basis" IN ('residence','work')),
	CONSTRAINT "local_tax_coverage_handling_check" CHECK ("local_tax_coverage"."handling" IN ('unsupported','engine'))
);
--> statement-breakpoint
ALTER TABLE "employee_work_states" ADD COLUMN "locality_code" text;--> statement-breakpoint
ALTER TABLE "employee_work_states" ADD COLUMN "locality_confirmed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "employee_work_states" ADD COLUMN "locality_confirmed_by" text;--> statement-breakpoint
ALTER TABLE "employee_residences" ADD CONSTRAINT "employee_residences_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_work_states" ADD CONSTRAINT "employee_work_states_locality_check" CHECK ("employee_work_states"."locality_code" IS NULL OR ("employee_work_states"."locality_code" LIKE "employee_work_states"."state_code" || '-%' AND "employee_work_states"."locality_code" IN ('NY-YONKERS','MD-001','MD-003','MD-005','MD-009','MD-011','MD-013','MD-015','MD-017','MD-019','MD-021','MD-023','MD-025','MD-027','MD-029','MD-031','MD-033','MD-035','MD-037','MD-039','MD-041','MD-043','MD-045','MD-047','MD-510')));--> statement-breakpoint
ALTER TABLE "employee_work_states" ADD CONSTRAINT "employee_work_states_locality_confirmed_check" CHECK ("employee_work_states"."locality_code" IS NULL OR "employee_work_states"."locality_confirmed_at" IS NOT NULL);--> statement-breakpoint
-- PAY-163 (hand-written; not expressible in Drizzle's DSL): one residence per
-- employee per day. int4range(employee_id) with && is equality on the id and
-- needs no btree_gist extension; windows are [effective_from, effective_to).
ALTER TABLE "employee_residences" ADD CONSTRAINT "employee_residences_no_overlap" EXCLUDE USING gist (int4range("employee_id", "employee_id", '[]') WITH &&, daterange("effective_from", "effective_to", '[)') WITH &&);
