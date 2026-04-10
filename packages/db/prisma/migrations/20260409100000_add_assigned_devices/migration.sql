-- CreateEnum
CREATE TYPE "DeviceType" AS ENUM ('LAPTOP', 'PHONE', 'TABLET', 'MONITOR', 'KEYBOARD', 'MOUSE', 'HEADSET', 'OTHER');

-- CreateTable
CREATE TABLE "assigned_devices" (
    "id" TEXT NOT NULL,
    "employee_id" TEXT NOT NULL,
    "type" "DeviceType" NOT NULL,
    "brand" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "serial_number" TEXT,
    "asset_tag" TEXT,
    "condition" TEXT NOT NULL DEFAULT 'Good',
    "notes" TEXT,
    "assigned_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "returned_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "assigned_devices_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "assigned_devices_employee_id_idx" ON "assigned_devices"("employee_id");

-- AddForeignKey
ALTER TABLE "assigned_devices" ADD CONSTRAINT "assigned_devices_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
