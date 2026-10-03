ALTER TABLE "tax_deposits" ADD COLUMN "seq" smallint DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "tax_deposits_live_period_seq_uniq" ON "tax_deposits" USING btree ("jurisdiction","period_start","period_kind","seq") WHERE "tax_deposits"."status" <> 'superseded';--> statement-breakpoint
DROP INDEX "tax_deposits_live_period_uniq";--> statement-breakpoint
ALTER TABLE "tax_deposits" ADD CONSTRAINT "tax_deposits_seq_check" CHECK ("tax_deposits"."seq" >= 0);
