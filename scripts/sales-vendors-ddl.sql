-- ============================================================================
-- scripts/sales-vendors-ddl.sql — external pages + vendors (sales inventory) and the per-campaign
-- page list and revenue on a Pipeline project (2026-11-18, owner's Pipeline feedback).
-- Models:   SalesVendor, SalesExternalPage, PipelineProjectPage, PipelineProjectRevenue (all new)
-- Services: apps/api/src/services/sales/external-pages.service.ts, campaign-plan.service.ts
--
-- Generated with
--   prisma migrate diff --from-schema-datamodel <origin/main schema.prisma>
--     --to-schema-datamodel packages/db/prisma/schema.prisma --script
-- then hand-edited like scripts/sales-recurring-ddl.sql: one transaction, lock_timeout 3s,
-- statement_timeout 60s, search_path pinned, CREATE ... IF NOT EXISTS, foreign keys guarded by
-- pg_constraint lookups. Definitions are byte-identical to the generated output.
--
-- Purely additive: four new tables, no ALTER of an existing table (the two FKs into
-- pipeline_projects only take a brief SHARE ROW EXCLUSIVE lock to validate an empty table).
-- Apply on prod with scripts/apply-sales-vendors-ddl.sh BEFORE merging the PR.
-- ============================================================================
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';
SET LOCAL search_path = public;

-- CreateTable
CREATE TABLE IF NOT EXISTS "sales_vendors" (
    "id" TEXT NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "phone" VARCHAR(30),
    "email" VARCHAR(200),
    "notes" TEXT NOT NULL DEFAULT '',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sales_vendors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "sales_external_pages" (
    "id" TEXT NOT NULL,
    "vendor_id" TEXT,
    "platform" VARCHAR(16) NOT NULL,
    "handle" VARCHAR(60),
    "name" VARCHAR(120) NOT NULL,
    "profile_url" VARCHAR(300),
    "followers" INTEGER,
    "category" VARCHAR(60),
    "brand_paise" INTEGER,
    "entertainment_paise" INTEGER,
    "event_paise" INTEGER,
    "audio_paise" INTEGER,
    "notes" TEXT NOT NULL DEFAULT '',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sales_external_pages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "pipeline_project_pages" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "page_key" VARCHAR(80) NOT NULL,
    "source" VARCHAR(10) NOT NULL,
    "platform" VARCHAR(16) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "handle" VARCHAR(60),
    "category" VARCHAR(60),
    "vendor_name" VARCHAR(120),
    "followers" INTEGER,
    "profile_url" VARCHAR(300),
    "brand_paise" INTEGER,
    "entertainment_paise" INTEGER,
    "event_paise" INTEGER,
    "added_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pipeline_project_pages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "pipeline_project_revenue" (
    "project_id" TEXT NOT NULL,
    "amount_paise" INTEGER NOT NULL,
    "payment_mode" VARCHAR(8) NOT NULL,
    "received_paise" INTEGER NOT NULL DEFAULT 0,
    "received_on" DATE,
    "note" TEXT NOT NULL DEFAULT '',
    "updated_by_id" TEXT NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pipeline_project_revenue_pkey" PRIMARY KEY ("project_id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "sales_external_pages_vendor_id_idx" ON "sales_external_pages"("vendor_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "sales_external_pages_category_idx" ON "sales_external_pages"("category");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "sales_external_pages_platform_handle_key" ON "sales_external_pages"("platform", "handle");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "pipeline_project_pages_project_id_page_key_key" ON "pipeline_project_pages"("project_id", "page_key");

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sales_external_pages_vendor_id_fkey') THEN
    ALTER TABLE "sales_external_pages" ADD CONSTRAINT "sales_external_pages_vendor_id_fkey" FOREIGN KEY ("vendor_id") REFERENCES "sales_vendors"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pipeline_project_pages_project_id_fkey') THEN
    ALTER TABLE "pipeline_project_pages" ADD CONSTRAINT "pipeline_project_pages_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "pipeline_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pipeline_project_revenue_project_id_fkey') THEN
    ALTER TABLE "pipeline_project_revenue" ADD CONSTRAINT "pipeline_project_revenue_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "pipeline_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;


COMMIT;
