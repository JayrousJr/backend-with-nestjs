-- CreateEnum
CREATE TYPE "InternalRequestStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'ACCEPTED', 'FULFILLED_FROM_STORE', 'IN_PURCHASE', 'DELIVERED', 'CLOSED', 'RETURNED', 'REJECTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PurchaseRequestStatus" AS ENUM ('DRAFT', 'IN_APPROVAL', 'APPROVED', 'RETURNED', 'REJECTED', 'IN_PROCUREMENT', 'COMPLETED', 'CANCELLED');

-- CreateTable
CREATE TABLE "internal_requests" (
    "id" SERIAL NOT NULL,
    "unique_id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "status" "InternalRequestStatus" NOT NULL DEFAULT 'DRAFT',
    "requesting_department_id" INTEGER NOT NULL,
    "beneficiary_employee_id" INTEGER,
    "product_id" INTEGER NOT NULL,
    "product_version_id" INTEGER NOT NULL,
    "quantity" INTEGER NOT NULL,
    "required_by" DATE,
    "justification" TEXT NOT NULL,
    "production_ref" TEXT,
    "created_by_user_id" INTEGER NOT NULL,
    "approval_request_id" INTEGER,
    "accepted_qty" INTEGER,
    "accept_note" TEXT,
    "store_id" INTEGER,
    "from_store_qty" INTEGER NOT NULL DEFAULT 0,
    "to_purchase_qty" INTEGER NOT NULL DEFAULT 0,
    "delivered_qty" INTEGER NOT NULL DEFAULT 0,
    "submitted_at" TIMESTAMP(3),
    "accepted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "internal_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_requests" (
    "id" SERIAL NOT NULL,
    "unique_id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "status" "PurchaseRequestStatus" NOT NULL DEFAULT 'DRAFT',
    "department_id" INTEGER NOT NULL,
    "justification" TEXT NOT NULL,
    "created_by_user_id" INTEGER NOT NULL,
    "approval_request_id" INTEGER,
    "submitted_at" TIMESTAMP(3),
    "decided_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "purchase_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_request_lines" (
    "id" SERIAL NOT NULL,
    "purchase_request_id" INTEGER NOT NULL,
    "line_no" INTEGER NOT NULL,
    "product_id" INTEGER NOT NULL,
    "product_version_id" INTEGER NOT NULL,
    "quantity" INTEGER NOT NULL,
    "beneficiary_employee_id" INTEGER,
    "beneficiary_department_id" INTEGER,
    "production_ref" TEXT,
    "internal_request_id" INTEGER,
    "note" TEXT,

    CONSTRAINT "purchase_request_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "internal_requests_unique_id_key" ON "internal_requests"("unique_id");

-- CreateIndex
CREATE UNIQUE INDEX "internal_requests_number_key" ON "internal_requests"("number");

-- CreateIndex
CREATE INDEX "internal_requests_requesting_department_id_status_idx" ON "internal_requests"("requesting_department_id", "status");

-- CreateIndex
CREATE INDEX "internal_requests_product_id_idx" ON "internal_requests"("product_id");

-- CreateIndex
CREATE INDEX "internal_requests_beneficiary_employee_id_idx" ON "internal_requests"("beneficiary_employee_id");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_requests_unique_id_key" ON "purchase_requests"("unique_id");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_requests_number_key" ON "purchase_requests"("number");

-- CreateIndex
CREATE INDEX "purchase_requests_department_id_status_idx" ON "purchase_requests"("department_id", "status");

-- CreateIndex
CREATE INDEX "purchase_request_lines_purchase_request_id_idx" ON "purchase_request_lines"("purchase_request_id");

-- CreateIndex
CREATE INDEX "purchase_request_lines_internal_request_id_idx" ON "purchase_request_lines"("internal_request_id");

-- AddForeignKey
ALTER TABLE "purchase_request_lines" ADD CONSTRAINT "purchase_request_lines_purchase_request_id_fkey" FOREIGN KEY ("purchase_request_id") REFERENCES "purchase_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_request_lines" ADD CONSTRAINT "purchase_request_lines_internal_request_id_fkey" FOREIGN KEY ("internal_request_id") REFERENCES "internal_requests"("id") ON DELETE SET NULL ON UPDATE CASCADE;
