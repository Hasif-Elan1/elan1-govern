-- AlterTable
ALTER TABLE "User" ADD COLUMN     "isPlatformStaff" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Webhook" ADD COLUMN     "secretPrefix" TEXT NOT NULL DEFAULT '';

-- CreateTable
CREATE TABLE "WebhookSecretRoll" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "webhookId" TEXT NOT NULL,
    "previousSecretEnc" TEXT NOT NULL,
    "previousPrefix" TEXT NOT NULL,
    "validUntil" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookSecretRoll_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WebhookSecretRoll_orgId_webhookId_idx" ON "WebhookSecretRoll"("orgId", "webhookId");
