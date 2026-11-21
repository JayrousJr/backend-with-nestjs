-- CreateEnum
CREATE TYPE "TransferStatus" AS ENUM ('REQUESTED', 'APPROVED', 'DISPATCHED', 'DISCREPANCY', 'COMPLETED', 'REJECTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "TransferReason" AS ENUM ('RESTOCK', 'DELIVERY', 'PRODUCTION', 'CONSOLIDATION', 'REPAIR');

-- CreateEnum
CREATE TYPE "StockDocType" AS ENUM ('ISSUE', 'RETURN');

-- CreateEnum
CREATE TYPE "BeneficiaryType" AS ENUM ('DEPARTMENT', 'EMPLOYEE', 'PRODUCTION');

-- AlterTable
ALTER TABLE "stock_settings" ADD COLUMN     "alerted_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "transfers" (
    "id" SERIAL NOT NULL,
    "unique_id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "from_store_id" INTEGER NOT NULL,
    "to_store_id" INTEGER NOT NULL,
    "reason" "TransferReason" NOT NULL,
    "note" TEXT,
    "status" "TransferStatus" NOT NULL DEFAULT 'REQUESTED',
    "requested_by_user_id" INTEGER NOT NULL,
    "approval_request_id" INTEGER,
    "problem" TEXT,
    "dispatched_by_user_id" INTEGER,
    "dispatched_at" TIMESTAMP(3),
    "carried_by" TEXT,
    "vehicle_asset_id" INTEGER,
    "expected_arrival" TIMESTAMP(3),
    "received_by_user_id" INTEGER,
    "received_at" TIMESTAMP(3),
    "discrepancy_note" TEXT,
    "discrepancy_request_id" INTEGER,
    "reminded_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "transfers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transfer_lines" (
    "id" SERIAL NOT NULL,
    "transfer_id" INTEGER NOT NULL,
    "line_no" INTEGER NOT NULL,
    "product_id" INTEGER NOT NULL,
    "asset_id" INTEGER,
    "quantity" INTEGER NOT NULL,
    "batch_number" TEXT,
    "from_location_id" INTEGER,
    "reserved" INTEGER NOT NULL DEFAULT 0,
    "dispatched_qty" INTEGER,
    "dispatch_condition" "AssetCondition",
    "received_qty" INTEGER,
    "received_condition" "AssetCondition",
    "to_location_id" INTEGER,
    "note" TEXT,

    CONSTRAINT "transfer_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_documents" (
    "id" SERIAL NOT NULL,
    "unique_id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "type" "StockDocType" NOT NULL,
    "store_id" INTEGER NOT NULL,
    "beneficiary_type" "BeneficiaryType" NOT NULL,
    "department_id" INTEGER,
    "employee_id" INTEGER,
    "production_ref" TEXT,
    "reference" TEXT,
    "note" TEXT,
    "user_id" INTEGER NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_document_lines" (
    "id" SERIAL NOT NULL,
    "document_id" INTEGER NOT NULL,
    "line_no" INTEGER NOT NULL,
    "product_id" INTEGER NOT NULL,
    "location_id" INTEGER NOT NULL,
    "batch_number" TEXT,
    "quantity" INTEGER NOT NULL,

    CONSTRAINT "stock_document_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "transfers_unique_id_key" ON "transfers"("unique_id");

-- CreateIndex
CREATE UNIQUE INDEX "transfers_number_key" ON "transfers"("number");

-- CreateIndex
CREATE INDEX "transfers_status_idx" ON "transfers"("status");

-- CreateIndex
CREATE INDEX "transfers_from_store_id_status_idx" ON "transfers"("from_store_id", "status");

-- CreateIndex
CREATE INDEX "transfers_to_store_id_status_idx" ON "transfers"("to_store_id", "status");

-- CreateIndex
CREATE INDEX "transfer_lines_transfer_id_idx" ON "transfer_lines"("transfer_id");

-- CreateIndex
CREATE UNIQUE INDEX "stock_documents_unique_id_key" ON "stock_documents"("unique_id");

-- CreateIndex
CREATE UNIQUE INDEX "stock_documents_number_key" ON "stock_documents"("number");

-- CreateIndex
CREATE INDEX "stock_documents_store_id_at_idx" ON "stock_documents"("store_id", "at");

-- CreateIndex
CREATE INDEX "stock_document_lines_document_id_idx" ON "stock_document_lines"("document_id");

-- AddForeignKey
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_from_store_id_fkey" FOREIGN KEY ("from_store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_to_store_id_fkey" FOREIGN KEY ("to_store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transfer_lines" ADD CONSTRAINT "transfer_lines_transfer_id_fkey" FOREIGN KEY ("transfer_id") REFERENCES "transfers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_document_lines" ADD CONSTRAINT "stock_document_lines_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "stock_documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
