-- CreateEnum
CREATE TYPE "ImportStatus" AS ENUM ('VALIDATED', 'FAILED', 'COMMITTED');

-- CreateTable
CREATE TABLE "import_batches" (
    "id" SERIAL NOT NULL,
    "unique_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "status" "ImportStatus" NOT NULL,
    "file_name" TEXT NOT NULL,
    "file" BYTEA NOT NULL,
    "total_rows" INTEGER NOT NULL,
    "create_count" INTEGER NOT NULL DEFAULT 0,
    "update_count" INTEGER NOT NULL DEFAULT 0,
    "error_count" INTEGER NOT NULL DEFAULT 0,
    "rows" JSONB NOT NULL,
    "uploaded_by_id" INTEGER NOT NULL,
    "committed_by_id" INTEGER,
    "committed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "import_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "import_row_errors" (
    "id" SERIAL NOT NULL,
    "batch_id" INTEGER NOT NULL,
    "row" INTEGER NOT NULL,
    "column" TEXT,
    "message" TEXT NOT NULL,

    CONSTRAINT "import_row_errors_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "import_batches_unique_id_key" ON "import_batches"("unique_id");

-- CreateIndex
CREATE INDEX "import_batches_type_created_at_idx" ON "import_batches"("type", "created_at");

-- CreateIndex
CREATE INDEX "import_row_errors_batch_id_idx" ON "import_row_errors"("batch_id");

-- AddForeignKey
ALTER TABLE "import_row_errors" ADD CONSTRAINT "import_row_errors_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "import_batches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
