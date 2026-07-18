-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('active', 'suspended');

-- AlterEnum
ALTER TYPE "UserRole" ADD VALUE 'super_admin';

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "status" "UserStatus" NOT NULL DEFAULT 'active';

