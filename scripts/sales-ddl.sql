-- ============================================================================
-- scripts/sales-ddl.sql — feature-only DDL for sales.digitalsukoon.com (2026-10-26):
-- client billing profiles, quotes, sales orders, GST invoices, payments, credit notes,
-- the per-financial-year number sequences and the sales audit log.
-- Models:   ClientBillingProfile, SalesSequence, SalesQuote(+Item), SalesOrder(+Item),
--           SalesInvoice(+Item), SalesPayment, SalesPaymentAllocation, SalesCreditNote, SalesEvent
-- Services: apps/api/src/services/sales/*
--
-- Generated with
--   prisma migrate diff --from-schema-datamodel <origin/main schema.prisma>
--     --to-schema-datamodel packages/db/prisma/schema.prisma --script
-- then hand-edited like scripts/campaign-overrides-ddl.sql: one transaction, lock_timeout 3s,
-- statement_timeout 60s, search_path pinned, CREATE ... IF NOT EXISTS, foreign keys guarded by
-- pg_constraint lookups. Definitions are byte-identical to the generated output, so
-- `prisma migrate diff --from-url <db> ... --exit-code` shows no drift.
--
-- Purely additive: twelve NEW tables, no ALTER on any existing table. The only references into
-- existing tables are foreign keys to clients(id), which take a brief SHARE ROW EXCLUSIVE lock
-- on clients while each constraint is validated (small table, no hot path). The running API
-- never reads these tables before the sales deploy.
--
-- Safe to run twice: the second run changes nothing and raises no error.
-- Apply ONLY through psql, as the app role (never sudo -u postgres):
--   psql "$DBURL" -v ON_ERROR_STOP=1 -f scripts/sales-ddl.sql
-- ============================================================================
\set ON_ERROR_STOP on

BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';
SET LOCAL search_path = public;

-- CreateTable
CREATE TABLE IF NOT EXISTS "client_billing_profiles" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "legal_name" VARCHAR(200) NOT NULL,
    "gstin" VARCHAR(15),
    "pan" VARCHAR(10),
    "address_line1" VARCHAR(200),
    "address_line2" VARCHAR(200),
    "city" VARCHAR(100),
    "state" VARCHAR(60),
    "state_code" VARCHAR(2),
    "pincode" VARCHAR(10),
    "country" VARCHAR(2) NOT NULL DEFAULT 'IN',
    "billing_email" VARCHAR(200),
    "billing_phone" VARCHAR(30),
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "client_billing_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "sales_sequences" (
    "key" VARCHAR(40) NOT NULL,
    "next" INTEGER NOT NULL DEFAULT 1,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sales_sequences_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "sales_quotes" (
    "id" TEXT NOT NULL,
    "number" VARCHAR(32) NOT NULL,
    "client_id" TEXT NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "status" VARCHAR(16) NOT NULL DEFAULT 'draft',
    "campaign_type" VARCHAR(16) NOT NULL DEFAULT 'brand',
    "valid_until" DATE,
    "place_of_supply_code" VARCHAR(2),
    "tax_mode" VARCHAR(8) NOT NULL DEFAULT 'intra',
    "gst_rate_bp" INTEGER NOT NULL DEFAULT 1800,
    "subtotal_paise" INTEGER NOT NULL DEFAULT 0,
    "discount_paise" INTEGER NOT NULL DEFAULT 0,
    "taxable_paise" INTEGER NOT NULL DEFAULT 0,
    "cgst_paise" INTEGER NOT NULL DEFAULT 0,
    "sgst_paise" INTEGER NOT NULL DEFAULT 0,
    "igst_paise" INTEGER NOT NULL DEFAULT 0,
    "total_paise" INTEGER NOT NULL DEFAULT 0,
    "notes" TEXT,
    "internal_notes" TEXT,
    "sent_at" TIMESTAMP(3),
    "accepted_at" TIMESTAMP(3),
    "declined_at" TIMESTAMP(3),
    "converted_order_id" TEXT,
    "created_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sales_quotes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "sales_quote_items" (
    "id" TEXT NOT NULL,
    "quote_id" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "kind" VARCHAR(16) NOT NULL DEFAULT 'placement',
    "target_type" VARCHAR(16),
    "target_id" TEXT,
    "platform" VARCHAR(16),
    "format" VARCHAR(24),
    "description" VARCHAR(300) NOT NULL,
    "account_name" VARCHAR(200),
    "account_handle" VARCHAR(100),
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "unit_price_paise" INTEGER NOT NULL,
    "discount_paise" INTEGER NOT NULL DEFAULT 0,
    "amount_paise" INTEGER NOT NULL,
    "sac" VARCHAR(8),
    "scheduled_on" DATE,
    "rate_card_id" TEXT,

    CONSTRAINT "sales_quote_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "sales_orders" (
    "id" TEXT NOT NULL,
    "number" VARCHAR(32) NOT NULL,
    "client_id" TEXT NOT NULL,
    "quote_id" TEXT,
    "campaign_booking_id" TEXT,
    "title" VARCHAR(200) NOT NULL,
    "status" VARCHAR(16) NOT NULL DEFAULT 'draft',
    "campaign_type" VARCHAR(16) NOT NULL DEFAULT 'brand',
    "po_number" VARCHAR(60),
    "start_date" DATE,
    "end_date" DATE,
    "place_of_supply_code" VARCHAR(2),
    "tax_mode" VARCHAR(8) NOT NULL DEFAULT 'intra',
    "gst_rate_bp" INTEGER NOT NULL DEFAULT 1800,
    "subtotal_paise" INTEGER NOT NULL DEFAULT 0,
    "discount_paise" INTEGER NOT NULL DEFAULT 0,
    "taxable_paise" INTEGER NOT NULL DEFAULT 0,
    "cgst_paise" INTEGER NOT NULL DEFAULT 0,
    "sgst_paise" INTEGER NOT NULL DEFAULT 0,
    "igst_paise" INTEGER NOT NULL DEFAULT 0,
    "total_paise" INTEGER NOT NULL DEFAULT 0,
    "notes" TEXT,
    "internal_notes" TEXT,
    "confirmed_at" TIMESTAMP(3),
    "delivered_at" TIMESTAMP(3),
    "closed_at" TIMESTAMP(3),
    "cancelled_at" TIMESTAMP(3),
    "created_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sales_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "sales_order_items" (
    "id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "kind" VARCHAR(16) NOT NULL DEFAULT 'placement',
    "target_type" VARCHAR(16),
    "target_id" TEXT,
    "platform" VARCHAR(16),
    "format" VARCHAR(24),
    "description" VARCHAR(300) NOT NULL,
    "account_name" VARCHAR(200),
    "account_handle" VARCHAR(100),
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "unit_price_paise" INTEGER NOT NULL,
    "discount_paise" INTEGER NOT NULL DEFAULT 0,
    "amount_paise" INTEGER NOT NULL,
    "sac" VARCHAR(8),
    "scheduled_on" DATE,
    "status" VARCHAR(16) NOT NULL DEFAULT 'pending',
    "permalink" VARCHAR(500),
    "delivered_on" DATE,
    "rate_card_id" TEXT,

    CONSTRAINT "sales_order_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "sales_invoices" (
    "id" TEXT NOT NULL,
    "number" VARCHAR(32),
    "kind" VARCHAR(16) NOT NULL DEFAULT 'tax_invoice',
    "client_id" TEXT NOT NULL,
    "order_id" TEXT,
    "campaign_booking_id" TEXT,
    "status" VARCHAR(16) NOT NULL DEFAULT 'draft',
    "issue_date" DATE,
    "due_date" DATE,
    "place_of_supply_code" VARCHAR(2),
    "tax_mode" VARCHAR(8) NOT NULL DEFAULT 'intra',
    "gst_rate_bp" INTEGER NOT NULL DEFAULT 1800,
    "seller_snapshot" JSONB,
    "buyer_snapshot" JSONB,
    "subtotal_paise" INTEGER NOT NULL DEFAULT 0,
    "discount_paise" INTEGER NOT NULL DEFAULT 0,
    "taxable_paise" INTEGER NOT NULL DEFAULT 0,
    "cgst_paise" INTEGER NOT NULL DEFAULT 0,
    "sgst_paise" INTEGER NOT NULL DEFAULT 0,
    "igst_paise" INTEGER NOT NULL DEFAULT 0,
    "round_off_paise" INTEGER NOT NULL DEFAULT 0,
    "total_paise" INTEGER NOT NULL DEFAULT 0,
    "amount_in_words" VARCHAR(400),
    "paid_paise" INTEGER NOT NULL DEFAULT 0,
    "tds_paise" INTEGER NOT NULL DEFAULT 0,
    "credited_paise" INTEGER NOT NULL DEFAULT 0,
    "notes" TEXT,
    "terms" TEXT,
    "internal_notes" TEXT,
    "issued_at" TIMESTAMP(3),
    "sent_at" TIMESTAMP(3),
    "paid_at" TIMESTAMP(3),
    "cancelled_at" TIMESTAMP(3),
    "cancel_reason" VARCHAR(300),
    "created_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sales_invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "sales_invoice_items" (
    "id" TEXT NOT NULL,
    "invoice_id" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "description" VARCHAR(300) NOT NULL,
    "sac" VARCHAR(8),
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "unit_price_paise" INTEGER NOT NULL,
    "discount_paise" INTEGER NOT NULL DEFAULT 0,
    "amount_paise" INTEGER NOT NULL,
    "order_item_id" TEXT,

    CONSTRAINT "sales_invoice_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "sales_payments" (
    "id" TEXT NOT NULL,
    "number" VARCHAR(32) NOT NULL,
    "client_id" TEXT NOT NULL,
    "amount_paise" INTEGER NOT NULL,
    "tds_paise" INTEGER NOT NULL DEFAULT 0,
    "mode" VARCHAR(16) NOT NULL,
    "reference" VARCHAR(120),
    "paid_on" DATE NOT NULL,
    "bank_name" VARCHAR(120),
    "notes" TEXT,
    "recorded_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sales_payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "sales_payment_allocations" (
    "id" TEXT NOT NULL,
    "payment_id" TEXT NOT NULL,
    "invoice_id" TEXT NOT NULL,
    "amount_paise" INTEGER NOT NULL,
    "tds_paise" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sales_payment_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "sales_credit_notes" (
    "id" TEXT NOT NULL,
    "number" VARCHAR(32) NOT NULL,
    "invoice_id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "status" VARCHAR(16) NOT NULL DEFAULT 'issued',
    "issue_date" DATE NOT NULL,
    "reason" VARCHAR(300) NOT NULL,
    "tax_mode" VARCHAR(8) NOT NULL,
    "gst_rate_bp" INTEGER NOT NULL,
    "taxable_paise" INTEGER NOT NULL,
    "cgst_paise" INTEGER NOT NULL DEFAULT 0,
    "sgst_paise" INTEGER NOT NULL DEFAULT 0,
    "igst_paise" INTEGER NOT NULL DEFAULT 0,
    "total_paise" INTEGER NOT NULL,
    "cancelled_at" TIMESTAMP(3),
    "created_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sales_credit_notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "sales_events" (
    "id" TEXT NOT NULL,
    "entity_type" VARCHAR(16) NOT NULL,
    "entity_id" TEXT NOT NULL,
    "actor_id" TEXT,
    "action" VARCHAR(40) NOT NULL,
    "from_status" VARCHAR(16),
    "to_status" VARCHAR(16),
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sales_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "client_billing_profiles_client_id_key" ON "client_billing_profiles"("client_id");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "sales_quotes_number_key" ON "sales_quotes"("number");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "sales_quotes_client_id_idx" ON "sales_quotes"("client_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "sales_quotes_status_created_at_idx" ON "sales_quotes"("status", "created_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "sales_quote_items_quote_id_idx" ON "sales_quote_items"("quote_id");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "sales_orders_number_key" ON "sales_orders"("number");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "sales_orders_quote_id_key" ON "sales_orders"("quote_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "sales_orders_client_id_idx" ON "sales_orders"("client_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "sales_orders_status_created_at_idx" ON "sales_orders"("status", "created_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "sales_order_items_order_id_idx" ON "sales_order_items"("order_id");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "sales_invoices_number_key" ON "sales_invoices"("number");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "sales_invoices_client_id_idx" ON "sales_invoices"("client_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "sales_invoices_status_due_date_idx" ON "sales_invoices"("status", "due_date");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "sales_invoices_issue_date_idx" ON "sales_invoices"("issue_date");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "sales_invoice_items_invoice_id_idx" ON "sales_invoice_items"("invoice_id");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "sales_payments_number_key" ON "sales_payments"("number");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "sales_payments_client_id_paid_on_idx" ON "sales_payments"("client_id", "paid_on");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "sales_payment_allocations_invoice_id_idx" ON "sales_payment_allocations"("invoice_id");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "sales_payment_allocations_payment_id_invoice_id_key" ON "sales_payment_allocations"("payment_id", "invoice_id");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "sales_credit_notes_number_key" ON "sales_credit_notes"("number");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "sales_credit_notes_invoice_id_idx" ON "sales_credit_notes"("invoice_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "sales_credit_notes_client_id_idx" ON "sales_credit_notes"("client_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "sales_events_entity_type_entity_id_created_at_idx" ON "sales_events"("entity_type", "entity_id", "created_at");

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'client_billing_profiles_client_id_fkey') THEN
    ALTER TABLE "client_billing_profiles" ADD CONSTRAINT "client_billing_profiles_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sales_quotes_client_id_fkey') THEN
    ALTER TABLE "sales_quotes" ADD CONSTRAINT "sales_quotes_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sales_quote_items_quote_id_fkey') THEN
    ALTER TABLE "sales_quote_items" ADD CONSTRAINT "sales_quote_items_quote_id_fkey" FOREIGN KEY ("quote_id") REFERENCES "sales_quotes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sales_orders_client_id_fkey') THEN
    ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sales_order_items_order_id_fkey') THEN
    ALTER TABLE "sales_order_items" ADD CONSTRAINT "sales_order_items_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "sales_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sales_invoices_client_id_fkey') THEN
    ALTER TABLE "sales_invoices" ADD CONSTRAINT "sales_invoices_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sales_invoices_order_id_fkey') THEN
    ALTER TABLE "sales_invoices" ADD CONSTRAINT "sales_invoices_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "sales_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sales_invoice_items_invoice_id_fkey') THEN
    ALTER TABLE "sales_invoice_items" ADD CONSTRAINT "sales_invoice_items_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "sales_invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sales_payments_client_id_fkey') THEN
    ALTER TABLE "sales_payments" ADD CONSTRAINT "sales_payments_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sales_payment_allocations_payment_id_fkey') THEN
    ALTER TABLE "sales_payment_allocations" ADD CONSTRAINT "sales_payment_allocations_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "sales_payments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sales_payment_allocations_invoice_id_fkey') THEN
    ALTER TABLE "sales_payment_allocations" ADD CONSTRAINT "sales_payment_allocations_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "sales_invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sales_credit_notes_invoice_id_fkey') THEN
    ALTER TABLE "sales_credit_notes" ADD CONSTRAINT "sales_credit_notes_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "sales_invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sales_credit_notes_client_id_fkey') THEN
    ALTER TABLE "sales_credit_notes" ADD CONSTRAINT "sales_credit_notes_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

COMMIT;
