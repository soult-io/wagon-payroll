CREATE TABLE "company_state_ids" (
	"id" serial PRIMARY KEY NOT NULL,
	"company_id" integer NOT NULL,
	"state_code" text NOT NULL,
	"from_tax_year" integer NOT NULL,
	"state_id" text NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "company_state_ids_company_state_year_uniq" UNIQUE("company_id","state_code","from_tax_year"),
	CONSTRAINT "company_state_ids_state_code_check" CHECK ("company_state_ids"."state_code" ~ '^[A-Z]{2}$'),
	CONSTRAINT "company_state_ids_year_check" CHECK ("company_state_ids"."from_tax_year" BETWEEN 2000 AND 2100),
	CONSTRAINT "company_state_ids_encrypted_check" CHECK ("company_state_ids"."state_id" ~ '^enc:v1:[A-Za-z0-9_-]{39,}$')
);
--> statement-breakpoint
ALTER TABLE "company_state_ids" ADD CONSTRAINT "company_state_ids_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;