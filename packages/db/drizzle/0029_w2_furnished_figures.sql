CREATE TABLE "w2_furnished_figures" (
	"id" serial PRIMARY KEY NOT NULL,
	"employee_id" integer NOT NULL,
	"tax_year" integer NOT NULL,
	"hash_version" smallint NOT NULL,
	"boxes_hash" text NOT NULL,
	"figures" jsonb NOT NULL,
	"box15_ciphertexts" jsonb,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "w2_furnished_figures_tax_year_check" CHECK ("w2_furnished_figures"."tax_year" BETWEEN 2020 AND 2100),
	CONSTRAINT "w2_furnished_figures_boxes_hash_check" CHECK ("w2_furnished_figures"."boxes_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "w2_furnished_figures_hash_version_check" CHECK ("w2_furnished_figures"."hash_version" IN (1, 2)),
	CONSTRAINT "w2_furnished_figures_figures_check" CHECK (jsonb_typeof("w2_furnished_figures"."figures") = 'object'),
	CONSTRAINT "w2_furnished_figures_box15_check" CHECK ("w2_furnished_figures"."box15_ciphertexts" IS NULL OR ("w2_furnished_figures"."hash_version" = 2 AND jsonb_typeof("w2_furnished_figures"."box15_ciphertexts") = 'object')),
	CONSTRAINT "w2_furnished_figures_source_check" CHECK ("w2_furnished_figures"."source" IN ('furnishing','reconstructed'))
);
--> statement-breakpoint
ALTER TABLE "w2_furnished_figures" ADD CONSTRAINT "w2_furnished_figures_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "w2_furnished_figures_key_uniq" ON "w2_furnished_figures" USING btree ("employee_id","tax_year","hash_version","boxes_hash");--> statement-breakpoint
-- Hand-appended (PAY-223, same doctrine as 0027): the frozen figures of
-- every furnished W-2 version are a record — append-only. TRUNCATE is not
-- covered (tests only; no app path truncates). A future key rotation of
-- box15_ciphertexts needs its own path past this trigger.
CREATE OR REPLACE FUNCTION w2_furnished_figures_append_only() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'w2_furnished_figures is append-only';
END;
$$;--> statement-breakpoint

CREATE TRIGGER "w2_furnished_figures_no_update_delete"
  BEFORE UPDATE OR DELETE ON "w2_furnished_figures"
  FOR EACH ROW EXECUTE FUNCTION w2_furnished_figures_append_only();
