-- AlterTable
ALTER TABLE "Clinic" ADD COLUMN     "demoSource" JSONB,
ADD COLUMN     "isDemo" BOOLEAN NOT NULL DEFAULT false;
