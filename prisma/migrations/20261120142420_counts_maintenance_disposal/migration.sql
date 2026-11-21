-- CreateEnum
CREATE TYPE "CountScope" AS ENUM ('FULL', 'LOCATION', 'CATEGORY');

-- CreateEnum
CREATE TYPE "CountStatus" AS ENUM ('COUNTING', 'IN_APPROVAL', 'APPROVED', 'REJECTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "MaintenanceStatus" AS ENUM ('OPEN', 'IN_REPAIR', 'AT_VENDOR', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "MaintenanceSource" AS ENUM ('FAULT_REPORT', 'PRODUCTION_RETURN', 'STOCK_COUNT', 'TRANSFER_RECEIPT', 'SCHEDULED', 'OTHER');

-- CreateEnum
CREATE TYPE "DisposalStatus" AS ENUM ('IN_APPROVAL', 'APPROVED', 'RETURNED', 'REJECTED', 'CANCELLED', 'COMPLETED');

-- CreateTable
CREATE TABLE "stock_counts" (
    "id" SERIAL NOT NULL,
    "unique_id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "store_id" INTEGER NOT NULL,
    "scope" "CountScope" NOT NULL,
    "location_ids" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "category_id" INTEGER,
    "status" "CountStatus" NOT NULL DEFAULT 'COUNTING',
    "note" TEXT,
    "created_by_user_id" INTEGER NOT NULL,
    "approval_request_id" INTEGER,
    "submitted_at" TIMESTAMP(3),
    "posted_at" TIMESTAMP(3),
    "post_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "stock_counts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_count_lines" (
    "id" SERIAL NOT NULL,
    "count_id" INTEGER NOT NULL,
    "product_id" INTEGER NOT NULL,
    "asset_id" INTEGER,
    "location_id" INTEGER NOT NULL,
    "batch_number" TEXT,
    "expected_qty" INTEGER NOT NULL,
    "counted_qty" INTEGER,
    "unexpected" BOOLEAN NOT NULL DEFAULT false,
    "counted_by_user_id" INTEGER,
    "counted_at" TIMESTAMP(3),
    "note" TEXT,

    CONSTRAINT "stock_count_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "maintenance_tickets" (
    "id" SERIAL NOT NULL,
    "unique_id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "asset_id" INTEGER NOT NULL,
    "source" "MaintenanceSource" NOT NULL,
    "description" TEXT NOT NULL,
    "status" "MaintenanceStatus" NOT NULL DEFAULT 'OPEN',
    "external" BOOLEAN NOT NULL DEFAULT false,
    "vendor_name" TEXT,
    "under_warranty" BOOLEAN NOT NULL DEFAULT false,
    "opened_by_user_id" INTEGER NOT NULL,
    "previous_status" "AssetStatus",
    "started_at" TIMESTAMP(3),
    "sent_out_at" TIMESTAMP(3),
    "back_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "completed_by_user_id" INTEGER,
    "outcome" TEXT,
    "outcome_condition" "AssetCondition",
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "maintenance_tickets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "disposals" (
    "id" SERIAL NOT NULL,
    "unique_id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "asset_id" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "status" "DisposalStatus" NOT NULL DEFAULT 'IN_APPROVAL',
    "previous_status" "AssetStatus" NOT NULL,
    "proposed_by_user_id" INTEGER NOT NULL,
    "approval_request_id" INTEGER,
    "completed_at" TIMESTAMP(3),
    "completed_by_user_id" INTEGER,
    "completion_note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "disposals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "stock_counts_unique_id_key" ON "stock_counts"("unique_id");

-- CreateIndex
CREATE UNIQUE INDEX "stock_counts_number_key" ON "stock_counts"("number");

-- CreateIndex
CREATE INDEX "stock_counts_store_id_status_idx" ON "stock_counts"("store_id", "status");

-- CreateIndex
CREATE INDEX "stock_count_lines_count_id_idx" ON "stock_count_lines"("count_id");

-- CreateIndex
CREATE UNIQUE INDEX "maintenance_tickets_unique_id_key" ON "maintenance_tickets"("unique_id");

-- CreateIndex
CREATE UNIQUE INDEX "maintenance_tickets_number_key" ON "maintenance_tickets"("number");

-- CreateIndex
CREATE INDEX "maintenance_tickets_asset_id_idx" ON "maintenance_tickets"("asset_id");

-- CreateIndex
CREATE INDEX "maintenance_tickets_status_idx" ON "maintenance_tickets"("status");

-- CreateIndex
CREATE UNIQUE INDEX "disposals_unique_id_key" ON "disposals"("unique_id");

-- CreateIndex
CREATE UNIQUE INDEX "disposals_number_key" ON "disposals"("number");

-- CreateIndex
CREATE INDEX "disposals_asset_id_idx" ON "disposals"("asset_id");

-- CreateIndex
CREATE INDEX "disposals_status_idx" ON "disposals"("status");

-- AddForeignKey
ALTER TABLE "stock_count_lines" ADD CONSTRAINT "stock_count_lines_count_id_fkey" FOREIGN KEY ("count_id") REFERENCES "stock_counts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
