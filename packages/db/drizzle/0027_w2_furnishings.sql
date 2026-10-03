CREATE TABLE "w2_furnishings" (
	"id" serial PRIMARY KEY NOT NULL,
	"employee_id" integer NOT NULL,
	"tax_year" integer NOT NULL,
	"boxes_hash" text NOT NULL,
	"hash_version" smallint DEFAULT 1 NOT NULL,
	"corrected" boolean NOT NULL,
	"method" text NOT NULL,
	"actor_id" text,
	"furnished_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "w2_furnishings_event_uniq" UNIQUE("employee_id","tax_year","boxes_hash","method"),
	CONSTRAINT "w2_furnishings_tax_year_check" CHECK ("w2_furnishings"."tax_year" BETWEEN 2020 AND 2100),
	CONSTRAINT "w2_furnishings_boxes_hash_check" CHECK ("w2_furnishings"."boxes_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "w2_furnishings_method_check" CHECK ("w2_furnishings"."method" IN ('portal_notice','employee_download','admin_print','paper_handed','backfill'))
);
--> statement-breakpoint
ALTER TABLE "w2_furnishings" ADD CONSTRAINT "w2_furnishings_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "w2_furnishings_employee_year_idx" ON "w2_furnishings" USING btree ("employee_id","tax_year","furnished_at");--> statement-breakpoint
-- Hand-appended (PAY-206, same doctrine as 0001): w2_furnishings is the
-- record of what each employee was furnished — append-only. TRUNCATE is not
-- covered (tests only; no app path truncates).
CREATE OR REPLACE FUNCTION w2_furnishings_append_only() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'w2_furnishings is append-only';
END;
$$;--> statement-breakpoint

CREATE TRIGGER "w2_furnishings_no_update_delete"
  BEFORE UPDATE OR DELETE ON "w2_furnishings"
  FOR EACH ROW EXECUTE FUNCTION w2_furnishings_append_only();
