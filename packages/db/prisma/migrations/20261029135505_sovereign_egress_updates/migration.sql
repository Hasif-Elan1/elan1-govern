-- CreateTable
CREATE TABLE "EgressRule" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "port" INTEGER,
    "purpose" TEXT,
    "note" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EgressRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EgressLog" (
    "id" TEXT NOT NULL,
    "orgId" TEXT,
    "host" TEXT NOT NULL,
    "port" INTEGER NOT NULL,
    "purpose" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "profile" TEXT NOT NULL,
    "reason" TEXT,
    "actor" TEXT,
    "receiptSeq" INTEGER,
    "alerted" BOOLEAN NOT NULL DEFAULT false,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EgressLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UpdateRecord" (
    "id" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "manifest" JSONB NOT NULL,
    "manifestSha256" TEXT NOT NULL,
    "kid" TEXT NOT NULL,
    "sourceDir" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "previousVersion" TEXT,
    "importedBy" TEXT NOT NULL,
    "importedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "stagedBy" TEXT,
    "stagedAt" TIMESTAMP(3),
    "appliedBy" TEXT,
    "appliedAt" TIMESTAMP(3),
    "rolledBackBy" TEXT,
    "rolledBackAt" TIMESTAMP(3),
    "rollbackReason" TEXT,

    CONSTRAINT "UpdateRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EgressRule_orgId_idx" ON "EgressRule"("orgId");

-- CreateIndex
CREATE INDEX "EgressLog_at_idx" ON "EgressLog"("at");

-- CreateIndex
CREATE INDEX "EgressLog_orgId_at_idx" ON "EgressLog"("orgId", "at");

-- CreateIndex
CREATE INDEX "EgressLog_orgId_host_purpose_decision_at_idx" ON "EgressLog"("orgId", "host", "purpose", "decision", "at");

-- CreateIndex
CREATE UNIQUE INDEX "UpdateRecord_version_key" ON "UpdateRecord"("version");

-- CreateIndex
CREATE INDEX "UpdateRecord_status_idx" ON "UpdateRecord"("status");
