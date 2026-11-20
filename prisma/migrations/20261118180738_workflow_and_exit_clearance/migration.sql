-- CreateEnum
CREATE TYPE "ChainVersionStatus" AS ENUM ('DRAFT', 'ACTIVE', 'RETIRED');

-- CreateEnum
CREATE TYPE "ApproverType" AS ENUM ('USER', 'GROUP', 'ROLE', 'RULE');

-- CreateEnum
CREATE TYPE "ApprovalMode" AS ENUM ('ANY', 'N_OF_M', 'ALL');

-- CreateEnum
CREATE TYPE "ApprovalRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'RETURNED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ApprovalDecision" AS ENUM ('APPROVE', 'REJECT', 'RETURN', 'COMMENT', 'SKIPPED', 'AUTO_APPROVED');

-- CreateEnum
CREATE TYPE "ClearanceStatus" AS ENUM ('OPEN', 'IN_APPROVAL', 'COMPLETED');

-- CreateEnum
CREATE TYPE "ClearanceItemType" AS ENUM ('CUSTODY', 'APPROVAL_TASK', 'REQUEST', 'PRODUCTION', 'OTHER');

-- CreateTable
CREATE TABLE "approval_points" (
    "id" SERIAL NOT NULL,
    "code" TEXT NOT NULL,
    "module" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "active_version_id" INTEGER,
    "synced_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "approval_points_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approval_chain_versions" (
    "id" SERIAL NOT NULL,
    "unique_id" TEXT NOT NULL,
    "point_id" INTEGER NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "ChainVersionStatus" NOT NULL DEFAULT 'DRAFT',
    "created_by_id" INTEGER,
    "activated_by_id" INTEGER,
    "activated_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "approval_chain_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approval_steps" (
    "id" SERIAL NOT NULL,
    "version_id" INTEGER NOT NULL,
    "order" INTEGER NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "approver_type" "ApproverType" NOT NULL,
    "approver_user_id" INTEGER,
    "approver_group_id" INTEGER,
    "approver_role_id" INTEGER,
    "rule" TEXT,
    "mode" "ApprovalMode" NOT NULL DEFAULT 'ANY',
    "required_count" INTEGER NOT NULL DEFAULT 1,
    "allow_delegation" BOOLEAN NOT NULL DEFAULT true,
    "condition" JSONB,
    "sla_hours" INTEGER,

    CONSTRAINT "approval_steps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approval_requests" (
    "id" SERIAL NOT NULL,
    "unique_id" TEXT NOT NULL,
    "point_id" INTEGER NOT NULL,
    "version_id" INTEGER,
    "subject_type" TEXT NOT NULL,
    "subject_id" TEXT NOT NULL,
    "subject_department_id" INTEGER,
    "title" TEXT NOT NULL,
    "requester_user_id" INTEGER,
    "status" "ApprovalRequestStatus" NOT NULL DEFAULT 'PENDING',
    "current_step_order" INTEGER,
    "context" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "approval_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approval_assignments" (
    "id" SERIAL NOT NULL,
    "request_id" INTEGER NOT NULL,
    "step_order" INTEGER NOT NULL,
    "user_id" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "approval_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approval_actions" (
    "id" SERIAL NOT NULL,
    "request_id" INTEGER NOT NULL,
    "step_order" INTEGER,
    "step_name" TEXT,
    "decision" "ApprovalDecision" NOT NULL,
    "user_id" INTEGER,
    "on_behalf_of_user_id" INTEGER,
    "comment" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "approval_actions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "exit_clearances" (
    "id" SERIAL NOT NULL,
    "unique_id" TEXT NOT NULL,
    "employee_id" INTEGER NOT NULL,
    "status" "ClearanceStatus" NOT NULL DEFAULT 'OPEN',
    "approval_request_id" INTEGER,
    "signed_off_by_id" INTEGER,
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "exit_clearances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "exit_clearance_items" (
    "id" SERIAL NOT NULL,
    "unique_id" TEXT NOT NULL,
    "clearance_id" INTEGER NOT NULL,
    "type" "ClearanceItemType" NOT NULL,
    "reference" TEXT,
    "description" TEXT NOT NULL,
    "resolved" BOOLEAN NOT NULL DEFAULT false,
    "resolution" TEXT,
    "resolved_by_id" INTEGER,
    "resolved_at" TIMESTAMP(3),

    CONSTRAINT "exit_clearance_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "approval_points_code_key" ON "approval_points"("code");

-- CreateIndex
CREATE UNIQUE INDEX "approval_points_active_version_id_key" ON "approval_points"("active_version_id");

-- CreateIndex
CREATE UNIQUE INDEX "approval_chain_versions_unique_id_key" ON "approval_chain_versions"("unique_id");

-- CreateIndex
CREATE UNIQUE INDEX "approval_chain_versions_point_id_version_key" ON "approval_chain_versions"("point_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "approval_steps_version_id_order_key" ON "approval_steps"("version_id", "order");

-- CreateIndex
CREATE UNIQUE INDEX "approval_requests_unique_id_key" ON "approval_requests"("unique_id");

-- CreateIndex
CREATE INDEX "approval_requests_subject_type_subject_id_idx" ON "approval_requests"("subject_type", "subject_id");

-- CreateIndex
CREATE INDEX "approval_requests_status_idx" ON "approval_requests"("status");

-- CreateIndex
CREATE INDEX "approval_assignments_user_id_active_idx" ON "approval_assignments"("user_id", "active");

-- CreateIndex
CREATE UNIQUE INDEX "approval_assignments_request_id_step_order_user_id_key" ON "approval_assignments"("request_id", "step_order", "user_id");

-- CreateIndex
CREATE INDEX "approval_actions_request_id_idx" ON "approval_actions"("request_id");

-- CreateIndex
CREATE UNIQUE INDEX "exit_clearances_unique_id_key" ON "exit_clearances"("unique_id");

-- CreateIndex
CREATE INDEX "exit_clearances_employee_id_idx" ON "exit_clearances"("employee_id");

-- CreateIndex
CREATE INDEX "exit_clearances_status_idx" ON "exit_clearances"("status");

-- CreateIndex
CREATE UNIQUE INDEX "exit_clearance_items_unique_id_key" ON "exit_clearance_items"("unique_id");

-- CreateIndex
CREATE INDEX "exit_clearance_items_clearance_id_idx" ON "exit_clearance_items"("clearance_id");

-- AddForeignKey
ALTER TABLE "approval_points" ADD CONSTRAINT "approval_points_active_version_id_fkey" FOREIGN KEY ("active_version_id") REFERENCES "approval_chain_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_chain_versions" ADD CONSTRAINT "approval_chain_versions_point_id_fkey" FOREIGN KEY ("point_id") REFERENCES "approval_points"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_steps" ADD CONSTRAINT "approval_steps_version_id_fkey" FOREIGN KEY ("version_id") REFERENCES "approval_chain_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_point_id_fkey" FOREIGN KEY ("point_id") REFERENCES "approval_points"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_version_id_fkey" FOREIGN KEY ("version_id") REFERENCES "approval_chain_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_assignments" ADD CONSTRAINT "approval_assignments_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "approval_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_actions" ADD CONSTRAINT "approval_actions_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "approval_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exit_clearance_items" ADD CONSTRAINT "exit_clearance_items_clearance_id_fkey" FOREIGN KEY ("clearance_id") REFERENCES "exit_clearances"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
