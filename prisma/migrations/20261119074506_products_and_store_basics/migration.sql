-- CreateEnum
CREATE TYPE "ProductStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'IN_REVIEW', 'ACTIVE', 'INACTIVE', 'RETIRED', 'RETURNED', 'REJECTED');

-- CreateEnum
CREATE TYPE "ProductVersionStatus" AS ENUM ('DRAFT', 'IN_APPROVAL', 'ACTIVE', 'SUPERSEDED', 'RETURNED', 'REJECTED');

-- CreateEnum
CREATE TYPE "StoreItemType" AS ENUM ('FIXED_ASSET', 'CONSUMABLE', 'SPARE');

-- CreateEnum
CREATE TYPE "TrackingType" AS ENUM ('SERIALISED', 'QUANTITY', 'BATCH');

-- CreateEnum
CREATE TYPE "AcquisitionMethod" AS ENUM ('QUOTATION', 'SINGLE_SOURCE');

-- CreateEnum
CREATE TYPE "SpecRule" AS ENUM ('EXACT', 'MIN', 'MAX', 'RANGE', 'ONE_OF', 'TEXT');

-- CreateEnum
CREATE TYPE "StoreType" AS ENUM ('MAIN', 'SUB');

-- CreateEnum
CREATE TYPE "LocationKind" AS ENUM ('GENERAL', 'RECEIVING', 'REJECTED', 'IN_TRANSIT');

-- CreateEnum
CREATE TYPE "AssetStatus" AS ENUM ('IN_QUARANTINE', 'IN_STORE', 'RESERVED', 'CHECKED_OUT_TO_PRODUCTION', 'ASSIGNED_TO_EMPLOYEE', 'IN_TRANSIT', 'UNDER_MAINTENANCE', 'AT_VENDOR_FOR_REPAIR', 'MISSING', 'DAMAGED', 'LOST', 'PENDING_DISPOSAL', 'DISPOSED');

-- CreateEnum
CREATE TYPE "AssetCondition" AS ENUM ('GOOD', 'FAIR', 'NEEDS_REPAIR', 'UNDER_REPAIR', 'BEYOND_REPAIR');

-- CreateEnum
CREATE TYPE "AssetSource" AS ENUM ('PURCHASE', 'OPENING_BALANCE', 'FOUND', 'DONATED');

-- CreateEnum
CREATE TYPE "StockTxnType" AS ENUM ('RECEIVE_QUARANTINE', 'STOCK_IN', 'REJECT_TO_VENDOR', 'RESERVE', 'RELEASE', 'ISSUE', 'HANDOVER', 'PRODUCTION_CHECKOUT', 'PRODUCTION_RETURN', 'RETURN_TO_STORE', 'TRANSFER_DISPATCH', 'TRANSFER_RECEIVE', 'REPAIR_OUT', 'REPAIR_BACK', 'ADJUSTMENT', 'OPENING_BALANCE', 'LOCATION_MOVE', 'DISPOSAL', 'REVERSAL');

-- CreateEnum
CREATE TYPE "AdjustmentType" AS ENUM ('OPENING_BALANCE', 'FOUND', 'DONATED', 'COUNT_VARIANCE', 'CORRECTION');

-- CreateEnum
CREATE TYPE "AdjustmentStatus" AS ENUM ('DRAFT', 'IN_APPROVAL', 'APPROVED', 'RETURNED', 'REJECTED', 'CANCELLED');

-- CreateTable
CREATE TABLE "counters" (
    "key" TEXT NOT NULL,
    "value" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "counters_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "product_categories" (
    "id" SERIAL NOT NULL,
    "unique_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "tag_prefix" TEXT NOT NULL,
    "created_by_id" INTEGER,
    "updated_by_id" INTEGER,
    "deleted_by_id" INTEGER,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "product_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "category_criteria" (
    "id" SERIAL NOT NULL,
    "unique_id" TEXT NOT NULL,
    "category_id" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "category_criteria_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "products" (
    "id" SERIAL NOT NULL,
    "unique_id" TEXT NOT NULL,
    "code" TEXT,
    "status" "ProductStatus" NOT NULL DEFAULT 'DRAFT',
    "owning_department_id" INTEGER NOT NULL,
    "current_version_id" INTEGER,
    "item_type" "StoreItemType",
    "tracking_type" "TrackingType",
    "acquisition_method" "AcquisitionMethod",
    "single_source_vendor" TEXT,
    "vat_rate" DECIMAL(5,2),
    "is_vehicle" BOOLEAN NOT NULL DEFAULT false,
    "merged_into_id" INTEGER,
    "created_by_id" INTEGER,
    "updated_by_id" INTEGER,
    "deleted_by_id" INTEGER,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_versions" (
    "id" SERIAL NOT NULL,
    "unique_id" TEXT NOT NULL,
    "product_id" INTEGER NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "ProductVersionStatus" NOT NULL DEFAULT 'DRAFT',
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "category_id" INTEGER NOT NULL,
    "unit" TEXT NOT NULL,
    "reference_price" DECIMAL(14,2),
    "author_user_id" INTEGER NOT NULL,
    "approval_request_id" INTEGER,
    "submitted_at" TIMESTAMP(3),
    "activated_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "product_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_specs" (
    "id" SERIAL NOT NULL,
    "version_id" INTEGER NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "attribute" TEXT NOT NULL,
    "rule" "SpecRule" NOT NULL,
    "value" TEXT NOT NULL,
    "value_max" TEXT,
    "unit" TEXT,

    CONSTRAINT "product_specs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_criteria" (
    "id" SERIAL NOT NULL,
    "version_id" INTEGER NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "text" TEXT NOT NULL,
    "library_id" INTEGER,

    CONSTRAINT "product_criteria_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_attachments" (
    "id" SERIAL NOT NULL,
    "version_id" INTEGER NOT NULL,
    "file_id" INTEGER NOT NULL,

    CONSTRAINT "product_attachments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stores" (
    "id" SERIAL NOT NULL,
    "unique_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "StoreType" NOT NULL,
    "managing_department_id" INTEGER NOT NULL,
    "address" TEXT,
    "created_by_id" INTEGER,
    "updated_by_id" INTEGER,
    "deleted_by_id" INTEGER,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "stores_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "store_locations" (
    "id" SERIAL NOT NULL,
    "unique_id" TEXT NOT NULL,
    "store_id" INTEGER NOT NULL,
    "parent_id" INTEGER,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "LocationKind" NOT NULL DEFAULT 'GENERAL',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "store_locations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_settings" (
    "id" SERIAL NOT NULL,
    "store_id" INTEGER NOT NULL,
    "product_id" INTEGER NOT NULL,
    "min_level" INTEGER NOT NULL DEFAULT 0,
    "reorder_level" INTEGER NOT NULL DEFAULT 0,
    "max_level" INTEGER,
    "default_location_id" INTEGER,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "stock_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "asset_tags" (
    "id" SERIAL NOT NULL,
    "tag" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "issued_by_id" INTEGER,
    "issued_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "printed_at" TIMESTAMP(3),

    CONSTRAINT "asset_tags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assets" (
    "id" SERIAL NOT NULL,
    "unique_id" TEXT NOT NULL,
    "tag_id" INTEGER NOT NULL,
    "tag" TEXT NOT NULL,
    "serial_number" TEXT,
    "brand" TEXT,
    "model" TEXT,
    "product_id" INTEGER NOT NULL,
    "product_version_id" INTEGER NOT NULL,
    "owning_department_id" INTEGER NOT NULL,
    "source" "AssetSource" NOT NULL,
    "lpo_ref" TEXT,
    "grn_ref" TEXT,
    "inspection_ref" TEXT,
    "vendor_ref" TEXT,
    "purchase_price" DECIMAL(14,2),
    "price_estimated" BOOLEAN NOT NULL DEFAULT false,
    "purchase_date" DATE,
    "warranty_expiry" DATE,
    "store_id" INTEGER,
    "location_id" INTEGER,
    "custodian_employee_id" INTEGER,
    "condition" "AssetCondition" NOT NULL DEFAULT 'GOOD',
    "status" "AssetStatus" NOT NULL,
    "parent_asset_id" INTEGER,
    "is_kit" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "created_by_id" INTEGER,
    "updated_by_id" INTEGER,
    "deleted_by_id" INTEGER,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "assets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vehicle_details" (
    "id" SERIAL NOT NULL,
    "asset_id" INTEGER NOT NULL,
    "registration_number" TEXT NOT NULL,
    "chassis_number" TEXT,
    "engine_number" TEXT,
    "fuel_type" TEXT,
    "seating_capacity" INTEGER,
    "insurance_expiry" DATE,
    "road_licence_expiry" DATE,
    "service_interval_km" INTEGER,
    "service_interval_months" INTEGER,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vehicle_details_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_balances" (
    "id" SERIAL NOT NULL,
    "store_id" INTEGER NOT NULL,
    "location_id" INTEGER NOT NULL,
    "product_id" INTEGER NOT NULL,
    "batch_number" TEXT NOT NULL DEFAULT '',
    "expiry_date" DATE,
    "on_hand" INTEGER NOT NULL DEFAULT 0,
    "quarantine" INTEGER NOT NULL DEFAULT 0,
    "reserved" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "stock_balances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_transactions" (
    "id" SERIAL NOT NULL,
    "unique_id" TEXT NOT NULL,
    "type" "StockTxnType" NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "user_id" INTEGER,
    "store_id" INTEGER NOT NULL,
    "location_id" INTEGER,
    "to_location_id" INTEGER,
    "product_id" INTEGER NOT NULL,
    "asset_id" INTEGER,
    "batch_number" TEXT,
    "quantity" INTEGER NOT NULL,
    "from_status" "AssetStatus",
    "to_status" "AssetStatus",
    "condition" "AssetCondition",
    "reference_type" TEXT,
    "reference_id" TEXT,
    "reason" TEXT,
    "beneficiary" JSONB,
    "reversal_of_id" INTEGER,

    CONSTRAINT "stock_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_adjustments" (
    "id" SERIAL NOT NULL,
    "unique_id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "type" "AdjustmentType" NOT NULL,
    "status" "AdjustmentStatus" NOT NULL DEFAULT 'DRAFT',
    "store_id" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "created_by_user_id" INTEGER NOT NULL,
    "approval_request_id" INTEGER,
    "import_batch_id" INTEGER,
    "posted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "stock_adjustments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_adjustment_lines" (
    "id" SERIAL NOT NULL,
    "adjustment_id" INTEGER NOT NULL,
    "line_no" INTEGER NOT NULL,
    "product_id" INTEGER NOT NULL,
    "location_id" INTEGER NOT NULL,
    "quantity" INTEGER NOT NULL,
    "batch_number" TEXT,
    "expiry_date" DATE,
    "asset" JSONB,
    "asset_id" INTEGER,

    CONSTRAINT "stock_adjustment_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "product_categories_unique_id_key" ON "product_categories"("unique_id");

-- CreateIndex
CREATE UNIQUE INDEX "product_categories_code_key" ON "product_categories"("code");

-- CreateIndex
CREATE UNIQUE INDEX "category_criteria_unique_id_key" ON "category_criteria"("unique_id");

-- CreateIndex
CREATE INDEX "category_criteria_category_id_idx" ON "category_criteria"("category_id");

-- CreateIndex
CREATE UNIQUE INDEX "products_unique_id_key" ON "products"("unique_id");

-- CreateIndex
CREATE UNIQUE INDEX "products_code_key" ON "products"("code");

-- CreateIndex
CREATE UNIQUE INDEX "products_current_version_id_key" ON "products"("current_version_id");

-- CreateIndex
CREATE INDEX "products_owning_department_id_idx" ON "products"("owning_department_id");

-- CreateIndex
CREATE INDEX "products_status_idx" ON "products"("status");

-- CreateIndex
CREATE UNIQUE INDEX "product_versions_unique_id_key" ON "product_versions"("unique_id");

-- CreateIndex
CREATE UNIQUE INDEX "product_versions_product_id_version_key" ON "product_versions"("product_id", "version");

-- CreateIndex
CREATE INDEX "product_specs_version_id_idx" ON "product_specs"("version_id");

-- CreateIndex
CREATE INDEX "product_criteria_version_id_idx" ON "product_criteria"("version_id");

-- CreateIndex
CREATE UNIQUE INDEX "product_attachments_version_id_file_id_key" ON "product_attachments"("version_id", "file_id");

-- CreateIndex
CREATE UNIQUE INDEX "stores_unique_id_key" ON "stores"("unique_id");

-- CreateIndex
CREATE UNIQUE INDEX "stores_code_key" ON "stores"("code");

-- CreateIndex
CREATE UNIQUE INDEX "store_locations_unique_id_key" ON "store_locations"("unique_id");

-- CreateIndex
CREATE UNIQUE INDEX "store_locations_store_id_code_key" ON "store_locations"("store_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "stock_settings_store_id_product_id_key" ON "stock_settings"("store_id", "product_id");

-- CreateIndex
CREATE UNIQUE INDEX "asset_tags_tag_key" ON "asset_tags"("tag");

-- CreateIndex
CREATE UNIQUE INDEX "asset_tags_prefix_number_key" ON "asset_tags"("prefix", "number");

-- CreateIndex
CREATE UNIQUE INDEX "assets_unique_id_key" ON "assets"("unique_id");

-- CreateIndex
CREATE UNIQUE INDEX "assets_tag_id_key" ON "assets"("tag_id");

-- CreateIndex
CREATE UNIQUE INDEX "assets_tag_key" ON "assets"("tag");

-- CreateIndex
CREATE INDEX "assets_product_id_idx" ON "assets"("product_id");

-- CreateIndex
CREATE INDEX "assets_store_id_status_idx" ON "assets"("store_id", "status");

-- CreateIndex
CREATE INDEX "assets_owning_department_id_idx" ON "assets"("owning_department_id");

-- CreateIndex
CREATE INDEX "assets_serial_number_idx" ON "assets"("serial_number");

-- CreateIndex
CREATE UNIQUE INDEX "vehicle_details_asset_id_key" ON "vehicle_details"("asset_id");

-- CreateIndex
CREATE UNIQUE INDEX "vehicle_details_registration_number_key" ON "vehicle_details"("registration_number");

-- CreateIndex
CREATE INDEX "stock_balances_product_id_idx" ON "stock_balances"("product_id");

-- CreateIndex
CREATE UNIQUE INDEX "stock_balances_store_id_location_id_product_id_batch_number_key" ON "stock_balances"("store_id", "location_id", "product_id", "batch_number");

-- CreateIndex
CREATE UNIQUE INDEX "stock_transactions_unique_id_key" ON "stock_transactions"("unique_id");

-- CreateIndex
CREATE INDEX "stock_transactions_store_id_at_idx" ON "stock_transactions"("store_id", "at");

-- CreateIndex
CREATE INDEX "stock_transactions_product_id_at_idx" ON "stock_transactions"("product_id", "at");

-- CreateIndex
CREATE INDEX "stock_transactions_asset_id_at_idx" ON "stock_transactions"("asset_id", "at");

-- CreateIndex
CREATE INDEX "stock_transactions_reference_type_reference_id_idx" ON "stock_transactions"("reference_type", "reference_id");

-- CreateIndex
CREATE UNIQUE INDEX "stock_adjustments_unique_id_key" ON "stock_adjustments"("unique_id");

-- CreateIndex
CREATE UNIQUE INDEX "stock_adjustments_number_key" ON "stock_adjustments"("number");

-- CreateIndex
CREATE INDEX "stock_adjustments_store_id_status_idx" ON "stock_adjustments"("store_id", "status");

-- CreateIndex
CREATE INDEX "stock_adjustment_lines_adjustment_id_idx" ON "stock_adjustment_lines"("adjustment_id");

-- AddForeignKey
ALTER TABLE "category_criteria" ADD CONSTRAINT "category_criteria_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "product_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_owning_department_id_fkey" FOREIGN KEY ("owning_department_id") REFERENCES "departments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_current_version_id_fkey" FOREIGN KEY ("current_version_id") REFERENCES "product_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_merged_into_id_fkey" FOREIGN KEY ("merged_into_id") REFERENCES "products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_versions" ADD CONSTRAINT "product_versions_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_versions" ADD CONSTRAINT "product_versions_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "product_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_specs" ADD CONSTRAINT "product_specs_version_id_fkey" FOREIGN KEY ("version_id") REFERENCES "product_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_criteria" ADD CONSTRAINT "product_criteria_version_id_fkey" FOREIGN KEY ("version_id") REFERENCES "product_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_attachments" ADD CONSTRAINT "product_attachments_version_id_fkey" FOREIGN KEY ("version_id") REFERENCES "product_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_attachments" ADD CONSTRAINT "product_attachments_file_id_fkey" FOREIGN KEY ("file_id") REFERENCES "files"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stores" ADD CONSTRAINT "stores_managing_department_id_fkey" FOREIGN KEY ("managing_department_id") REFERENCES "departments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_locations" ADD CONSTRAINT "store_locations_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_locations" ADD CONSTRAINT "store_locations_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "store_locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_settings" ADD CONSTRAINT "stock_settings_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_settings" ADD CONSTRAINT "stock_settings_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assets" ADD CONSTRAINT "assets_tag_id_fkey" FOREIGN KEY ("tag_id") REFERENCES "asset_tags"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assets" ADD CONSTRAINT "assets_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assets" ADD CONSTRAINT "assets_product_version_id_fkey" FOREIGN KEY ("product_version_id") REFERENCES "product_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assets" ADD CONSTRAINT "assets_owning_department_id_fkey" FOREIGN KEY ("owning_department_id") REFERENCES "departments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assets" ADD CONSTRAINT "assets_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assets" ADD CONSTRAINT "assets_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "store_locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assets" ADD CONSTRAINT "assets_custodian_employee_id_fkey" FOREIGN KEY ("custodian_employee_id") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assets" ADD CONSTRAINT "assets_parent_asset_id_fkey" FOREIGN KEY ("parent_asset_id") REFERENCES "assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_details" ADD CONSTRAINT "vehicle_details_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_balances" ADD CONSTRAINT "stock_balances_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_balances" ADD CONSTRAINT "stock_balances_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "store_locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_balances" ADD CONSTRAINT "stock_balances_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_adjustments" ADD CONSTRAINT "stock_adjustments_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_adjustment_lines" ADD CONSTRAINT "stock_adjustment_lines_adjustment_id_fkey" FOREIGN KEY ("adjustment_id") REFERENCES "stock_adjustments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The stock ledger is append-only (B2 §4): transactions are never edited
-- or deleted; mistakes are corrected with a reversing transaction.
CREATE OR REPLACE FUNCTION stock_transactions_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'stock_transactions is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER stock_transactions_no_update_delete
  BEFORE UPDATE OR DELETE ON "stock_transactions"
  FOR EACH ROW EXECUTE FUNCTION stock_transactions_immutable();

CREATE TRIGGER stock_transactions_no_truncate
  BEFORE TRUNCATE ON "stock_transactions"
  FOR EACH STATEMENT EXECUTE FUNCTION stock_transactions_immutable();

-- No negative stock (B2 §3).
ALTER TABLE "stock_balances" ADD CONSTRAINT stock_balances_non_negative
  CHECK (on_hand >= 0 AND quarantine >= 0 AND reserved >= 0 AND reserved <= on_hand);

-- Only one main store.
CREATE UNIQUE INDEX stores_one_main ON "stores" (type) WHERE type = 'MAIN';
