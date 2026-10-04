ALTER TABLE "company" ADD COLUMN "w2_contact_name" text;--> statement-breakpoint
ALTER TABLE "company" ADD COLUMN "w2_contact_phone" text;--> statement-breakpoint
ALTER TABLE "company" ADD COLUMN "w2_contact_email" text;--> statement-breakpoint
ALTER TABLE "company" ADD COLUMN "w2_contact_address" jsonb;--> statement-breakpoint
ALTER TABLE "email_outbox" ADD COLUMN "recipient_email" text;