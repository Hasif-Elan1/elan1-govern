-- AlterTable
ALTER TABLE "Agent" ADD COLUMN     "autoPauseOnHigh" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Org" ADD COLUMN     "behaviourSettings" JSONB;

-- CreateTable
CREATE TABLE "BehaviourAlert" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "agentSlug" TEXT NOT NULL,
    "detector" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "dedupeKey" TEXT,
    "severity" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "title" TEXT NOT NULL,
    "explanation" TEXT NOT NULL,
    "numbers" JSONB NOT NULL,
    "seqs" INTEGER[],
    "receiptSeq" INTEGER,
    "occurrences" INTEGER NOT NULL DEFAULT 1,
    "autoPaused" BOOLEAN NOT NULL DEFAULT false,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acknowledgedBy" TEXT,
    "acknowledgedAt" TIMESTAMP(3),
    "resolvedBy" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BehaviourAlert_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Incident" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'emergency_stop',
    "status" TEXT NOT NULL DEFAULT 'open',
    "reason" TEXT,
    "startedBy" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startSeq" INTEGER,
    "pausedAgentIds" TEXT[],
    "endedBy" TEXT,
    "endedAt" TIMESTAMP(3),
    "endSeq" INTEGER,
    "resumedCount" INTEGER,

    CONSTRAINT "Incident_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BehaviourAlert_orgId_status_createdAt_idx" ON "BehaviourAlert"("orgId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "BehaviourAlert_orgId_agentId_createdAt_idx" ON "BehaviourAlert"("orgId", "agentId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "BehaviourAlert_orgId_dedupeKey_key" ON "BehaviourAlert"("orgId", "dedupeKey");

-- CreateIndex
CREATE INDEX "Incident_orgId_status_idx" ON "Incident"("orgId", "status");
