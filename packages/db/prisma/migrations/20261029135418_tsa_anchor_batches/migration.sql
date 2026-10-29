-- Org.level is added by the identity migration (20261029135319).

-- CreateTable
CREATE TABLE "TsaKey" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "certPem" TEXT NOT NULL,
    "privateKeyEnc" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'env',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TsaKey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AnchorBatch" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "fromSeq" INTEGER NOT NULL,
    "toSeq" INTEGER NOT NULL,
    "root" TEXT NOT NULL,
    "tokens" JSONB NOT NULL,
    "failures" JSONB NOT NULL DEFAULT '[]',
    "status" TEXT NOT NULL,
    "receiptSeq" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AnchorBatch_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AnchorBatch_orgId_toSeq_idx" ON "AnchorBatch"("orgId", "toSeq");
