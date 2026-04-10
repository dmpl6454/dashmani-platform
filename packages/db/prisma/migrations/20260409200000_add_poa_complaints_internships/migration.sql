-- Add joining date and SOP fields to employee_profiles
ALTER TABLE "employee_profiles" ADD COLUMN "joining_date" DATE;
ALTER TABLE "employee_profiles" ADD COLUMN "joining_date_approved" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "employee_profiles" ADD COLUMN "sop_accepted_at" TIMESTAMP(3);

-- CreateEnum
CREATE TYPE "ComplaintStatus" AS ENUM ('OPEN', 'IN_REVIEW', 'RESOLVED', 'CLOSED');
CREATE TYPE "ApplicationStatus" AS ENUM ('RECEIVED', 'REVIEWING', 'SHORTLISTED', 'INTERVIEW', 'OFFERED', 'ACCEPTED', 'REJECTED');

-- CreateTable: daily_poas
CREATE TABLE "daily_poas" (
    "id" TEXT NOT NULL,
    "employee_id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "tasks" TEXT NOT NULL,
    "achievements" TEXT,
    "blockers" TEXT,
    "tomorrow_plan" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "daily_poas_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "daily_poas_employee_id_date_key" ON "daily_poas"("employee_id", "date");
CREATE INDEX "daily_poas_employee_id_idx" ON "daily_poas"("employee_id");
CREATE INDEX "daily_poas_date_idx" ON "daily_poas"("date");
ALTER TABLE "daily_poas" ADD CONSTRAINT "daily_poas_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateTable: complaints
CREATE TABLE "complaints" (
    "id" TEXT NOT NULL,
    "employee_id" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'GENERAL',
    "status" "ComplaintStatus" NOT NULL DEFAULT 'OPEN',
    "admin_response" TEXT,
    "resolved_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "complaints_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "complaints_employee_id_idx" ON "complaints"("employee_id");
CREATE INDEX "complaints_status_idx" ON "complaints"("status");
ALTER TABLE "complaints" ADD CONSTRAINT "complaints_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateTable: internship_applications
CREATE TABLE "internship_applications" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "college" TEXT,
    "course" TEXT,
    "start_date" DATE,
    "duration" TEXT NOT NULL DEFAULT '6 months',
    "department" TEXT,
    "skills" TEXT,
    "portfolio" TEXT,
    "linkedin" TEXT,
    "cover_letter" TEXT,
    "resume_url" TEXT,
    "status" "ApplicationStatus" NOT NULL DEFAULT 'RECEIVED',
    "review_notes" TEXT,
    "reviewed_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "internship_applications_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "internship_applications_status_idx" ON "internship_applications"("status");
