-- Task #503 — persistent processed-message exclusion for the Gmail poll.
-- Without label permissions the `-label:` clause never filters, so every
-- poll re-fetched the same first 10 messages and could starve newer mail.
-- Each polled message is recorded here once its disposition is durable.
CREATE TABLE IF NOT EXISTS "gmail_processed_messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"message_id" text NOT NULL,
	"message_date" timestamp,
	"processed_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "gmail_processed_messages_user_message_unique" UNIQUE("user_id","message_id")
);
