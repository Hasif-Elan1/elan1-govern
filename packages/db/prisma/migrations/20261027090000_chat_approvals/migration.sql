-- AlterTable
ALTER TABLE "Approval" ADD COLUMN     "channel" TEXT,
ADD COLUMN     "channelUser" TEXT,
ADD COLUMN     "chatApproval" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "ChatChannel" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "config" JSONB NOT NULL,
    "secretsEnc" TEXT NOT NULL,
    "verifyHash" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChatChannel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChatNumber" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "numberEnc" TEXT NOT NULL,
    "numberHash" TEXT NOT NULL,
    "last4" TEXT NOT NULL,
    "verifiedAt" TIMESTAMP(3),
    "codeHash" TEXT,
    "codeExpires" TIMESTAMP(3),
    "codeAttempts" INTEGER NOT NULL DEFAULT 0,
    "codesSent" INTEGER NOT NULL DEFAULT 0,
    "windowStart" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatNumber_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChatMessage" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "approvalId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "recipientUserId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "externalId" TEXT,
    "externalChannel" TEXT,
    "nextAttemptAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ChatChannel_orgId_kind_key" ON "ChatChannel"("orgId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "ChatNumber_orgId_userId_key" ON "ChatNumber"("orgId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "ChatNumber_orgId_numberHash_key" ON "ChatNumber"("orgId", "numberHash");

-- CreateIndex
CREATE INDEX "ChatMessage_orgId_approvalId_idx" ON "ChatMessage"("orgId", "approvalId");

-- CreateIndex
CREATE INDEX "ChatMessage_status_nextAttemptAt_idx" ON "ChatMessage"("status", "nextAttemptAt");

-- AddForeignKey
ALTER TABLE "ChatMessage" ADD CONSTRAINT "ChatMessage_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "ChatChannel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
