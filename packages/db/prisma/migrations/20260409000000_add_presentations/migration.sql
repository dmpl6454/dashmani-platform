-- CreateTable
CREATE TABLE "presentations" (
    "id" TEXT NOT NULL,
    "employee_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "markdown" TEXT NOT NULL,
    "theme" TEXT NOT NULL DEFAULT 'default',
    "html_path" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "presentations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "presentations_employee_id_idx" ON "presentations"("employee_id");

-- AddForeignKey
ALTER TABLE "presentations" ADD CONSTRAINT "presentations_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
