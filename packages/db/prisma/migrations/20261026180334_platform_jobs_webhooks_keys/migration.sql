-- AlterTable
ALTER TABLE "Checkpoint" ADD COLUMN     "kid" TEXT;

-- CreateTable
CREATE TABLE "OrgKey" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "kid" TEXT NOT NULL,
    "publicKey" TEXT NOT NULL,
    "privateKeyEnc" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'env',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "retiredAt" TIMESTAMP(3),

    CONSTRAINT "OrgKey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Webhook" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "secretEnc" TEXT NOT NULL,
    "events" TEXT[],
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Webhook_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookDelivery" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "webhookId" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "responseStatus" INTEGER,
    "nextAttemptAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OrgKey_orgId_retiredAt_idx" ON "OrgKey"("orgId", "retiredAt");

-- CreateIndex
CREATE UNIQUE INDEX "OrgKey_orgId_kid_key" ON "OrgKey"("orgId", "kid");

-- CreateIndex
CREATE INDEX "Webhook_orgId_idx" ON "Webhook"("orgId");

-- CreateIndex
CREATE INDEX "WebhookDelivery_orgId_webhookId_createdAt_idx" ON "WebhookDelivery"("orgId", "webhookId", "createdAt");

-- CreateIndex
CREATE INDEX "WebhookDelivery_status_nextAttemptAt_idx" ON "WebhookDelivery"("status", "nextAttemptAt");

-- AddForeignKey
ALTER TABLE "WebhookDelivery" ADD CONSTRAINT "WebhookDelivery_webhookId_fkey" FOREIGN KEY ("webhookId") REFERENCES "Webhook"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Data migration: every existing org key becomes its first OrgKey row (active).
-- kid is the same fingerprint as keyFingerprint() in packages/core: first 16 hex chars
-- of sha256(trimmed PEM). Orgs created later get their row from the gate service, and
-- the gate also copies a missing row lazily on first use (for rows written by older code).
INSERT INTO "OrgKey" ("id", "orgId", "kid", "publicKey", "privateKeyEnc", "provider", "createdAt")
SELECT
    gen_random_uuid()::text,
    o."id",
    substr(encode(sha256(convert_to(btrim(o."publicKey", E' \t\n\r\f'), 'UTF8')), 'hex'), 1, 16),
    o."publicKey",
    o."privateKeyEnc",
    'env',
    o."createdAt"
FROM "Org" o
WHERE o."privateKeyEnc" LIKE 'v1.%'
ON CONFLICT ("orgId", "kid") DO NOTHING;
