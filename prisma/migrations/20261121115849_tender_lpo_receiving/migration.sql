-- CreateEnum
CREATE TYPE "VendorStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'BLACKLISTED');

-- CreateEnum
CREATE TYPE "VendorUserStatus" AS ENUM ('PENDING_ACTIVATION', 'ACTIVE', 'DEACTIVATED');

-- CreateEnum
CREATE TYPE "ProcurementRoute" AS ENUM ('CASH', 'SINGLE_SOURCE', 'QUOTATION');

-- CreateEnum
CREATE TYPE "SourcingStatus" AS ENUM ('OPEN', 'JUSTIFICATION', 'IN_TENDER', 'ORDERED', 'RECEIVED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "TenderStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'CLOSED', 'OPENED', 'EVALUATION', 'AWARD_APPROVAL', 'AWARDED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "TenderLineStatus" AS ENUM ('OPEN', 'AWARDED', 'NOT_AWARDED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "BidStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'WITHDRAWN', 'OPENED');

-- CreateEnum
CREATE TYPE "PurchaseOrderKind" AS ENUM ('TENDER', 'CASH');

-- CreateEnum
CREATE TYPE "PurchaseOrderStatus" AS ENUM ('DRAFT', 'IN_APPROVAL', 'ISSUED', 'ACKNOWLEDGED', 'AMENDMENT_PENDING', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CLOSED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "AmendmentStatus" AS ENUM ('IN_APPROVAL', 'AWAITING_ACKNOWLEDGEMENT', 'APPLIED', 'REJECTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "GrnStatus" AS ENUM ('PENDING_INSPECTION', 'INSPECTED', 'COMPLETED');

-- CreateEnum
CREATE TYPE "GoodsInspectionStatus" AS ENUM ('PENDING', 'IN_PROGRESS', 'PASSED', 'FAILED', 'PARTIALLY_PASSED');

-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('REGISTERED', 'IN_APPROVAL', 'APPROVED', 'REJECTED', 'PAID');

-- AlterTable
ALTER TABLE "products" ADD COLUMN     "single_source_vendor_id" INTEGER;

-- AlterTable
ALTER TABLE "purchase_request_lines" ADD COLUMN     "justification" TEXT,
ADD COLUMN     "justification_approval_id" INTEGER,
ADD COLUMN     "justification_file_id" INTEGER,
ADD COLUMN     "route" "ProcurementRoute",
ADD COLUMN     "route_set_at" TIMESTAMP(3),
ADD COLUMN     "route_set_by_id" INTEGER,
ADD COLUMN     "sourcing_status" "SourcingStatus" NOT NULL DEFAULT 'OPEN';

-- CreateTable
CREATE TABLE "vendors" (
    "id" SERIAL NOT NULL,
    "unique_id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "tin" TEXT,
    "vrn" TEXT,
    "address" TEXT,
    "phone" TEXT,
    "email" TEXT NOT NULL,
    "contact_person" TEXT,
    "status" "VendorStatus" NOT NULL DEFAULT 'ACTIVE',
    "status_reason" TEXT,
    "registered_at" DATE NOT NULL,
    "valid_until" DATE NOT NULL,
    "note" TEXT,
    "created_by_id" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vendors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vendor_categories" (
    "vendor_id" INTEGER NOT NULL,
    "category_id" INTEGER NOT NULL,

    CONSTRAINT "vendor_categories_pkey" PRIMARY KEY ("vendor_id","category_id")
);

-- CreateTable
CREATE TABLE "vendor_users" (
    "id" SERIAL NOT NULL,
    "unique_id" TEXT NOT NULL,
    "vendor_id" INTEGER NOT NULL,
    "full_name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "password" TEXT,
    "is_admin" BOOLEAN NOT NULL DEFAULT false,
    "status" "VendorUserStatus" NOT NULL DEFAULT 'PENDING_ACTIVATION',
    "totp_secret" TEXT,
    "two_factor_enabled" BOOLEAN NOT NULL DEFAULT false,
    "activation_token_hash" TEXT,
    "activation_expires_at" TIMESTAMP(3),
    "failed_login_attempts" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMP(3),
    "last_login_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vendor_users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vendor_sessions" (
    "id" SERIAL NOT NULL,
    "unique_id" TEXT NOT NULL,
    "vendor_user_id" INTEGER NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "absolute_expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "ip_address" TEXT,
    "user_agent" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vendor_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vendor_notifications" (
    "id" SERIAL NOT NULL,
    "unique_id" TEXT NOT NULL,
    "vendor_id" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "link" TEXT,
    "read_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vendor_notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenders" (
    "id" SERIAL NOT NULL,
    "unique_id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "route" "ProcurementRoute" NOT NULL,
    "status" "TenderStatus" NOT NULL DEFAULT 'DRAFT',
    "description" TEXT,
    "delivery_terms" TEXT,
    "terms" TEXT,
    "closing_at" TIMESTAMP(3),
    "bid_validity_days" INTEGER NOT NULL DEFAULT 90,
    "policy_snapshot" JSONB,
    "single_source_vendor_id" INTEGER,
    "created_by_user_id" INTEGER NOT NULL,
    "published_by_user_id" INTEGER,
    "published_at" TIMESTAMP(3),
    "closed_at" TIMESTAMP(3),
    "opened_at" TIMESTAMP(3),
    "evaluated_at" TIMESTAMP(3),
    "award_approval_id" INTEGER,
    "awarded_at" TIMESTAMP(3),
    "letters_sent_at" TIMESTAMP(3),
    "cancelled_at" TIMESTAMP(3),
    "cancel_reason" TEXT,
    "evaluation_note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tender_lines" (
    "id" SERIAL NOT NULL,
    "tender_id" INTEGER NOT NULL,
    "line_no" INTEGER NOT NULL,
    "product_id" INTEGER NOT NULL,
    "product_version_id" INTEGER NOT NULL,
    "quantity" INTEGER NOT NULL,
    "status" "TenderLineStatus" NOT NULL DEFAULT 'OPEN',
    "award_bid_line_id" INTEGER,
    "award_reason" TEXT,
    "tie" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "tender_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tender_line_sources" (
    "tender_line_id" INTEGER NOT NULL,
    "purchase_request_line_id" INTEGER NOT NULL,
    "quantity" INTEGER NOT NULL,

    CONSTRAINT "tender_line_sources_pkey" PRIMARY KEY ("tender_line_id","purchase_request_line_id")
);

-- CreateTable
CREATE TABLE "tender_invites" (
    "tender_id" INTEGER NOT NULL,
    "vendor_id" INTEGER NOT NULL,
    "notified_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tender_invites_pkey" PRIMARY KEY ("tender_id","vendor_id")
);

-- CreateTable
CREATE TABLE "tender_committee_members" (
    "id" SERIAL NOT NULL,
    "tender_id" INTEGER NOT NULL,
    "user_id" INTEGER NOT NULL,
    "is_chair" BOOLEAN NOT NULL DEFAULT false,
    "coi_declared_at" TIMESTAMP(3),
    "coi_statement" TEXT,
    "opening_confirmed_at" TIMESTAMP(3),

    CONSTRAINT "tender_committee_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tender_clarifications" (
    "id" SERIAL NOT NULL,
    "unique_id" TEXT NOT NULL,
    "tender_id" INTEGER NOT NULL,
    "vendor_id" INTEGER NOT NULL,
    "question" TEXT NOT NULL,
    "answer" TEXT,
    "answered_by_id" INTEGER,
    "answered_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tender_clarifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tender_addenda" (
    "id" SERIAL NOT NULL,
    "tender_id" INTEGER NOT NULL,
    "number" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "file_id" INTEGER,
    "new_closing_at" TIMESTAMP(3),
    "created_by_id" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tender_addenda_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bids" (
    "id" SERIAL NOT NULL,
    "unique_id" TEXT NOT NULL,
    "tender_id" INTEGER NOT NULL,
    "vendor_id" INTEGER NOT NULL,
    "status" "BidStatus" NOT NULL DEFAULT 'DRAFT',
    "sealed" TEXT,
    "line_count" INTEGER NOT NULL DEFAULT 0,
    "validity_days" INTEGER,
    "file_ids" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "submitted_at" TIMESTAMP(3),
    "submitted_by_user_id" INTEGER,
    "withdrawn_at" TIMESTAMP(3),
    "opened_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bids_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bid_lines" (
    "id" SERIAL NOT NULL,
    "bid_id" INTEGER NOT NULL,
    "tender_line_id" INTEGER NOT NULL,
    "unit_price" DECIMAL(14,2) NOT NULL,
    "vat_rate" DECIMAL(5,2) NOT NULL,
    "delivery_days" INTEGER NOT NULL,
    "brand" TEXT,
    "model" TEXT,
    "country_of_origin" TEXT,
    "compliance" JSONB NOT NULL,
    "file_ids" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "compliant" BOOLEAN,
    "disqualify_reason" TEXT,
    "rank" INTEGER,
    "override_reason" TEXT,
    "negotiated_price" DECIMAL(14,2),
    "negotiated_days" INTEGER,
    "negotiation_note" TEXT,

    CONSTRAINT "bid_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_orders" (
    "id" SERIAL NOT NULL,
    "unique_id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "kind" "PurchaseOrderKind" NOT NULL,
    "status" "PurchaseOrderStatus" NOT NULL DEFAULT 'DRAFT',
    "revision" INTEGER NOT NULL DEFAULT 0,
    "tender_id" INTEGER,
    "vendor_id" INTEGER,
    "shop_name" TEXT,
    "store_id" INTEGER NOT NULL,
    "delivery_date" DATE,
    "instructions" TEXT,
    "receipt_file_ids" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "issue_approval_id" INTEGER,
    "issued_at" TIMESTAMP(3),
    "issued_by_id" INTEGER,
    "acknowledged_at" TIMESTAMP(3),
    "acknowledged_by" TEXT,
    "cancel_approval_id" INTEGER,
    "cancel_reason" TEXT,
    "reaward_requested" BOOLEAN NOT NULL DEFAULT false,
    "cancelled_at" TIMESTAMP(3),
    "closed_at" TIMESTAMP(3),
    "created_by_id" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "purchase_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_order_lines" (
    "id" SERIAL NOT NULL,
    "order_id" INTEGER NOT NULL,
    "line_no" INTEGER NOT NULL,
    "tender_line_id" INTEGER,
    "bid_line_id" INTEGER,
    "purchase_request_line_id" INTEGER,
    "product_id" INTEGER NOT NULL,
    "product_version_id" INTEGER NOT NULL,
    "description" TEXT,
    "brand" TEXT,
    "model" TEXT,
    "quantity" INTEGER NOT NULL,
    "unit_price" DECIMAL(14,2) NOT NULL,
    "vat_rate" DECIMAL(5,2) NOT NULL,
    "awarded_unit_price" DECIMAL(14,2),
    "awarded_quantity" INTEGER,
    "delivery_days" INTEGER,
    "received_qty" INTEGER NOT NULL DEFAULT 0,
    "passed_qty" INTEGER NOT NULL DEFAULT 0,
    "failed_qty" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "purchase_order_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_order_amendments" (
    "id" SERIAL NOT NULL,
    "unique_id" TEXT NOT NULL,
    "order_id" INTEGER NOT NULL,
    "revision" INTEGER NOT NULL,
    "status" "AmendmentStatus" NOT NULL DEFAULT 'IN_APPROVAL',
    "reason" TEXT NOT NULL,
    "before" JSONB NOT NULL,
    "after" JSONB NOT NULL,
    "increases_value" BOOLEAN NOT NULL,
    "approval_request_id" INTEGER,
    "created_by_id" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acknowledged_at" TIMESTAMP(3),
    "applied_at" TIMESTAMP(3),

    CONSTRAINT "purchase_order_amendments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "grns" (
    "id" SERIAL NOT NULL,
    "unique_id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "order_id" INTEGER NOT NULL,
    "store_id" INTEGER NOT NULL,
    "status" "GrnStatus" NOT NULL DEFAULT 'PENDING_INSPECTION',
    "delivery_note_no" TEXT,
    "delivery_note_file_id" INTEGER,
    "note" TEXT,
    "received_by_id" INTEGER NOT NULL,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "grns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "grn_lines" (
    "id" SERIAL NOT NULL,
    "grn_id" INTEGER NOT NULL,
    "order_line_id" INTEGER NOT NULL,
    "delivered_qty" INTEGER NOT NULL,
    "received_qty" INTEGER NOT NULL,
    "rejected_qty" INTEGER NOT NULL DEFAULT 0,
    "reject_reason" TEXT,
    "photo_file_ids" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "batch_number" TEXT,
    "expiry_date" DATE,
    "serial_numbers" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "warranty_months" INTEGER,

    CONSTRAINT "grn_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "goods_inspections" (
    "id" SERIAL NOT NULL,
    "unique_id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "grn_line_id" INTEGER NOT NULL,
    "department_id" INTEGER NOT NULL,
    "status" "GoodsInspectionStatus" NOT NULL DEFAULT 'PENDING',
    "assigned_user_id" INTEGER,
    "inspector_user_id" INTEGER,
    "passed_qty" INTEGER NOT NULL DEFAULT 0,
    "failed_qty" INTEGER NOT NULL DEFAULT 0,
    "results" JSONB,
    "remarks" TEXT,
    "failed_serials" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "completed_at" TIMESTAMP(3),
    "returned_to_vendor_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "goods_inspections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoices" (
    "id" SERIAL NOT NULL,
    "unique_id" TEXT NOT NULL,
    "order_id" INTEGER NOT NULL,
    "vendor_invoice_no" TEXT NOT NULL,
    "invoice_date" DATE NOT NULL,
    "amount_incl_vat" DECIMAL(14,2) NOT NULL,
    "vat_amount" DECIMAL(14,2) NOT NULL,
    "file_id" INTEGER,
    "status" "InvoiceStatus" NOT NULL DEFAULT 'REGISTERED',
    "registered_by_id" INTEGER NOT NULL,
    "approval_request_id" INTEGER,
    "payment_reference" TEXT,
    "paid_at" DATE,
    "paid_amount" DECIMAL(14,2),
    "payment_file_ids" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "payment_by_id" INTEGER,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "procurement_documents" (
    "id" SERIAL NOT NULL,
    "subject_type" TEXT NOT NULL,
    "subject_id" INTEGER NOT NULL,
    "doc_type" TEXT NOT NULL,
    "file_id" INTEGER NOT NULL,
    "uploaded_by_id" INTEGER,
    "uploaded_by_vendor_id" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "procurement_documents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "vendors_unique_id_key" ON "vendors"("unique_id");

-- CreateIndex
CREATE UNIQUE INDEX "vendors_number_key" ON "vendors"("number");

-- CreateIndex
CREATE UNIQUE INDEX "vendor_users_unique_id_key" ON "vendor_users"("unique_id");

-- CreateIndex
CREATE UNIQUE INDEX "vendor_users_email_key" ON "vendor_users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "vendor_users_activation_token_hash_key" ON "vendor_users"("activation_token_hash");

-- CreateIndex
CREATE UNIQUE INDEX "vendor_sessions_unique_id_key" ON "vendor_sessions"("unique_id");

-- CreateIndex
CREATE UNIQUE INDEX "vendor_notifications_unique_id_key" ON "vendor_notifications"("unique_id");

-- CreateIndex
CREATE INDEX "vendor_notifications_vendor_id_created_at_idx" ON "vendor_notifications"("vendor_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "tenders_unique_id_key" ON "tenders"("unique_id");

-- CreateIndex
CREATE UNIQUE INDEX "tenders_number_key" ON "tenders"("number");

-- CreateIndex
CREATE INDEX "tenders_status_idx" ON "tenders"("status");

-- CreateIndex
CREATE UNIQUE INDEX "tender_lines_tender_id_line_no_key" ON "tender_lines"("tender_id", "line_no");

-- CreateIndex
CREATE UNIQUE INDEX "tender_committee_members_tender_id_user_id_key" ON "tender_committee_members"("tender_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "tender_clarifications_unique_id_key" ON "tender_clarifications"("unique_id");

-- CreateIndex
CREATE UNIQUE INDEX "tender_addenda_tender_id_number_key" ON "tender_addenda"("tender_id", "number");

-- CreateIndex
CREATE UNIQUE INDEX "bids_unique_id_key" ON "bids"("unique_id");

-- CreateIndex
CREATE UNIQUE INDEX "bids_tender_id_vendor_id_key" ON "bids"("tender_id", "vendor_id");

-- CreateIndex
CREATE UNIQUE INDEX "bid_lines_bid_id_tender_line_id_key" ON "bid_lines"("bid_id", "tender_line_id");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_orders_unique_id_key" ON "purchase_orders"("unique_id");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_orders_number_key" ON "purchase_orders"("number");

-- CreateIndex
CREATE INDEX "purchase_orders_status_idx" ON "purchase_orders"("status");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_order_lines_order_id_line_no_key" ON "purchase_order_lines"("order_id", "line_no");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_order_amendments_unique_id_key" ON "purchase_order_amendments"("unique_id");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_order_amendments_order_id_revision_key" ON "purchase_order_amendments"("order_id", "revision");

-- CreateIndex
CREATE UNIQUE INDEX "grns_unique_id_key" ON "grns"("unique_id");

-- CreateIndex
CREATE UNIQUE INDEX "grns_number_key" ON "grns"("number");

-- CreateIndex
CREATE UNIQUE INDEX "goods_inspections_unique_id_key" ON "goods_inspections"("unique_id");

-- CreateIndex
CREATE UNIQUE INDEX "goods_inspections_number_key" ON "goods_inspections"("number");

-- CreateIndex
CREATE UNIQUE INDEX "goods_inspections_grn_line_id_key" ON "goods_inspections"("grn_line_id");

-- CreateIndex
CREATE INDEX "goods_inspections_department_id_status_idx" ON "goods_inspections"("department_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_unique_id_key" ON "invoices"("unique_id");

-- CreateIndex
CREATE INDEX "procurement_documents_subject_type_subject_id_idx" ON "procurement_documents"("subject_type", "subject_id");

-- AddForeignKey
ALTER TABLE "vendor_categories" ADD CONSTRAINT "vendor_categories_vendor_id_fkey" FOREIGN KEY ("vendor_id") REFERENCES "vendors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendor_users" ADD CONSTRAINT "vendor_users_vendor_id_fkey" FOREIGN KEY ("vendor_id") REFERENCES "vendors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendor_sessions" ADD CONSTRAINT "vendor_sessions_vendor_user_id_fkey" FOREIGN KEY ("vendor_user_id") REFERENCES "vendor_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tender_lines" ADD CONSTRAINT "tender_lines_tender_id_fkey" FOREIGN KEY ("tender_id") REFERENCES "tenders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tender_line_sources" ADD CONSTRAINT "tender_line_sources_tender_line_id_fkey" FOREIGN KEY ("tender_line_id") REFERENCES "tender_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tender_invites" ADD CONSTRAINT "tender_invites_tender_id_fkey" FOREIGN KEY ("tender_id") REFERENCES "tenders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tender_committee_members" ADD CONSTRAINT "tender_committee_members_tender_id_fkey" FOREIGN KEY ("tender_id") REFERENCES "tenders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tender_clarifications" ADD CONSTRAINT "tender_clarifications_tender_id_fkey" FOREIGN KEY ("tender_id") REFERENCES "tenders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tender_addenda" ADD CONSTRAINT "tender_addenda_tender_id_fkey" FOREIGN KEY ("tender_id") REFERENCES "tenders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bids" ADD CONSTRAINT "bids_tender_id_fkey" FOREIGN KEY ("tender_id") REFERENCES "tenders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bid_lines" ADD CONSTRAINT "bid_lines_bid_id_fkey" FOREIGN KEY ("bid_id") REFERENCES "bids"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "purchase_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_order_amendments" ADD CONSTRAINT "purchase_order_amendments_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "purchase_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "grn_lines" ADD CONSTRAINT "grn_lines_grn_id_fkey" FOREIGN KEY ("grn_id") REFERENCES "grns"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
