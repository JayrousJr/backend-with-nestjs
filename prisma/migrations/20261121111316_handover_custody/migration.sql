-- CreateEnum
CREATE TYPE "HandoverStatus" AS ENUM ('PREPARED', 'AWAITING_ACKNOWLEDGEMENT', 'ACKNOWLEDGED', 'PARTIALLY_RETURNED', 'CLOSED', 'DISPUTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "HandoverSource" AS ENUM ('INTERNAL_REQUEST', 'PURCHASE_REQUEST', 'TEMPORARY_REPLACEMENT', 'CUSTODY_TRANSFER', 'OPENING_BALANCE');

-- CreateEnum
CREATE TYPE "AckMethod" AS ENUM ('SYSTEM', 'EMAIL_LINK', 'COUNTER_CODE');

-- CreateEnum
CREATE TYPE "AckTokenKind" AS ENUM ('EMAIL_LINK', 'COUNTER_CODE');

-- CreateEnum
CREATE TYPE "ReturnStatus" AS ENUM ('REQUESTED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "AssetReportType" AS ENUM ('FAULT', 'DAMAGE', 'LOSS', 'THEFT');

-- CreateEnum
CREATE TYPE "AssetReportStatus" AS ENUM ('OPEN', 'IN_APPROVAL', 'CONFIRMED', 'REJECTED', 'CLOSED');

-- CreateEnum
CREATE TYPE "ResponsibilityDecision" AS ENUM ('NORMAL_WEAR', 'ACCIDENT', 'NEGLIGENCE', 'UNDER_INVESTIGATION');

-- CreateEnum
CREATE TYPE "CustodyTransferStatus" AS ENUM ('IN_APPROVAL', 'APPROVED', 'COMPLETED', 'REJECTED', 'CANCELLED');

-- AlterTable
ALTER TABLE "product_categories" ADD COLUMN     "inspection_months" INTEGER,
ADD COLUMN     "terms_of_use" TEXT;

-- CreateTable
CREATE TABLE "handovers" (
    "id" SERIAL NOT NULL,
    "unique_id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "status" "HandoverStatus" NOT NULL DEFAULT 'PREPARED',
    "custodian_employee_id" INTEGER NOT NULL,
    "custodian_department_id" INTEGER NOT NULL,
    "store_id" INTEGER NOT NULL,
    "source" "HandoverSource" NOT NULL,
    "internal_request_id" INTEGER,
    "custody_transfer_id" INTEGER,
    "asset_report_id" INTEGER,
    "source_ref" TEXT,
    "purpose" TEXT NOT NULL,
    "expected_return_date" DATE,
    "terms_text" TEXT,
    "prepared_by_user_id" INTEGER,
    "approval_request_id" INTEGER,
    "acknowledged_at" TIMESTAMP(3),
    "ack_method" "AckMethod",
    "ack_ip" TEXT,
    "ack_by_user_id" INTEGER,
    "dispute_note" TEXT,
    "cancel_reason" TEXT,
    "reminded_at" TIMESTAMP(3),
    "return_reminded_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "handovers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "handover_lines" (
    "id" SERIAL NOT NULL,
    "handover_id" INTEGER NOT NULL,
    "asset_id" INTEGER NOT NULL,
    "condition" "AssetCondition" NOT NULL,
    "accessories" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "photo_file_ids" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "returned_at" TIMESTAMP(3),
    "return_id" INTEGER,

    CONSTRAINT "handover_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "handover_ack_tokens" (
    "id" SERIAL NOT NULL,
    "handover_id" INTEGER NOT NULL,
    "kind" "AckTokenKind" NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "ip" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "handover_ack_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "custodies" (
    "id" SERIAL NOT NULL,
    "asset_id" INTEGER NOT NULL,
    "custodian_employee_id" INTEGER NOT NULL,
    "handover_id" INTEGER NOT NULL,
    "from_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "to_at" TIMESTAMP(3),
    "return_id" INTEGER,
    "end_reason" TEXT,
    "next_custody_id" INTEGER,

    CONSTRAINT "custodies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "asset_returns" (
    "id" SERIAL NOT NULL,
    "unique_id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "status" "ReturnStatus" NOT NULL DEFAULT 'REQUESTED',
    "custodian_employee_id" INTEGER NOT NULL,
    "store_id" INTEGER,
    "trigger" TEXT NOT NULL,
    "reason" TEXT,
    "requested_by_user_id" INTEGER,
    "received_by_user_id" INTEGER,
    "received_at" TIMESTAMP(3),
    "custody_transfer_id" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "asset_returns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "asset_return_lines" (
    "id" SERIAL NOT NULL,
    "return_id" INTEGER NOT NULL,
    "asset_id" INTEGER NOT NULL,
    "received" BOOLEAN NOT NULL DEFAULT false,
    "condition" "AssetCondition",
    "accessories_returned" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "missing" TEXT,
    "photo_file_ids" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "note" TEXT,

    CONSTRAINT "asset_return_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "asset_reports" (
    "id" SERIAL NOT NULL,
    "unique_id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "type" "AssetReportType" NOT NULL,
    "status" "AssetReportStatus" NOT NULL DEFAULT 'OPEN',
    "asset_id" INTEGER NOT NULL,
    "custodian_employee_id" INTEGER,
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "circumstances" TEXT NOT NULL,
    "still_usable" BOOLEAN NOT NULL DEFAULT true,
    "file_ids" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "reported_by_user_id" INTEGER,
    "automatic" BOOLEAN NOT NULL DEFAULT false,
    "maintenance_ticket_id" INTEGER,
    "loss_approval_request_id" INTEGER,
    "responsibility" "ResponsibilityDecision",
    "responsibility_reason" TEXT,
    "responsibility_status" TEXT,
    "responsibility_request_id" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "asset_reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "asset_inspections" (
    "id" SERIAL NOT NULL,
    "unique_id" TEXT NOT NULL,
    "asset_id" INTEGER NOT NULL,
    "custodian_employee_id" INTEGER,
    "condition" "AssetCondition" NOT NULL,
    "checklist" JSONB,
    "remarks" TEXT,
    "file_ids" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "inspected_by_user_id" INTEGER NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "asset_inspections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "custody_transfers" (
    "id" SERIAL NOT NULL,
    "unique_id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "status" "CustodyTransferStatus" NOT NULL DEFAULT 'IN_APPROVAL',
    "asset_ids" INTEGER[],
    "from_employee_id" INTEGER NOT NULL,
    "to_employee_id" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "requested_by_user_id" INTEGER NOT NULL,
    "approval_request_id" INTEGER,
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "custody_transfers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "handovers_unique_id_key" ON "handovers"("unique_id");

-- CreateIndex
CREATE UNIQUE INDEX "handovers_number_key" ON "handovers"("number");

-- CreateIndex
CREATE INDEX "handovers_custodian_employee_id_status_idx" ON "handovers"("custodian_employee_id", "status");

-- CreateIndex
CREATE INDEX "handovers_store_id_status_idx" ON "handovers"("store_id", "status");

-- CreateIndex
CREATE INDEX "handover_lines_handover_id_idx" ON "handover_lines"("handover_id");

-- CreateIndex
CREATE INDEX "handover_lines_asset_id_idx" ON "handover_lines"("asset_id");

-- CreateIndex
CREATE UNIQUE INDEX "handover_ack_tokens_token_hash_key" ON "handover_ack_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "custodies_asset_id_to_at_idx" ON "custodies"("asset_id", "to_at");

-- CreateIndex
CREATE INDEX "custodies_custodian_employee_id_to_at_idx" ON "custodies"("custodian_employee_id", "to_at");

-- CreateIndex
CREATE UNIQUE INDEX "asset_returns_unique_id_key" ON "asset_returns"("unique_id");

-- CreateIndex
CREATE UNIQUE INDEX "asset_returns_number_key" ON "asset_returns"("number");

-- CreateIndex
CREATE INDEX "asset_returns_custodian_employee_id_status_idx" ON "asset_returns"("custodian_employee_id", "status");

-- CreateIndex
CREATE INDEX "asset_return_lines_return_id_idx" ON "asset_return_lines"("return_id");

-- CreateIndex
CREATE UNIQUE INDEX "asset_reports_unique_id_key" ON "asset_reports"("unique_id");

-- CreateIndex
CREATE UNIQUE INDEX "asset_reports_number_key" ON "asset_reports"("number");

-- CreateIndex
CREATE INDEX "asset_reports_asset_id_idx" ON "asset_reports"("asset_id");

-- CreateIndex
CREATE INDEX "asset_reports_custodian_employee_id_idx" ON "asset_reports"("custodian_employee_id");

-- CreateIndex
CREATE UNIQUE INDEX "asset_inspections_unique_id_key" ON "asset_inspections"("unique_id");

-- CreateIndex
CREATE INDEX "asset_inspections_asset_id_at_idx" ON "asset_inspections"("asset_id", "at");

-- CreateIndex
CREATE UNIQUE INDEX "custody_transfers_unique_id_key" ON "custody_transfers"("unique_id");

-- CreateIndex
CREATE UNIQUE INDEX "custody_transfers_number_key" ON "custody_transfers"("number");

-- CreateIndex
CREATE INDEX "custody_transfers_status_idx" ON "custody_transfers"("status");

-- AddForeignKey
ALTER TABLE "handover_lines" ADD CONSTRAINT "handover_lines_handover_id_fkey" FOREIGN KEY ("handover_id") REFERENCES "handovers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "handover_ack_tokens" ADD CONSTRAINT "handover_ack_tokens_handover_id_fkey" FOREIGN KEY ("handover_id") REFERENCES "handovers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_return_lines" ADD CONSTRAINT "asset_return_lines_return_id_fkey" FOREIGN KEY ("return_id") REFERENCES "asset_returns"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
