-- CreateTable
CREATE TABLE "SealRecord" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "receiptHash" TEXT NOT NULL,
    "level" TEXT NOT NULL,
    "values" JSONB NOT NULL,
    "recordId" TEXT NOT NULL,
    "digest" TEXT NOT NULL,
    "kid" TEXT NOT NULL,
    "sig" TEXT NOT NULL,
    "saltEnc" TEXT,
    "payloadUnbound" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SealRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReceiptRedaction" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "receipt" JSONB NOT NULL,
    "erasureSeq" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReceiptRedaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConsoleSignature" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "kid" TEXT NOT NULL,
    "sig" TEXT NOT NULL,
    "receiptSeq" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConsoleSignature_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SealRecord_orgId_recordId_idx" ON "SealRecord"("orgId", "recordId");

-- CreateIndex
CREATE INDEX "SealRecord_orgId_updatedAt_idx" ON "SealRecord"("orgId", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "SealRecord_orgId_seq_key" ON "SealRecord"("orgId", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "ReceiptRedaction_orgId_seq_key" ON "ReceiptRedaction"("orgId", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "ConsoleSignature_orgId_kind_message_kid_key" ON "ConsoleSignature"("orgId", "kind", "message", "kid");
