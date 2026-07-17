-- AlterTable
ALTER TABLE "RefreshToken" ADD COLUMN     "revokedAt" TIMESTAMP(3),
ADD COLUMN     "sessionId" UUID NOT NULL;

-- CreateIndex
CREATE INDEX "RefreshToken_sessionId_idx" ON "RefreshToken"("sessionId");
