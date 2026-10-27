-- CreateTable
CREATE TABLE "RuleSuggestion" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "tool" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'new',
    "title" TEXT NOT NULL,
    "proposal" TEXT NOT NULL,
    "confidence" TEXT NOT NULL,
    "explanation" TEXT NOT NULL,
    "evidence" JSONB NOT NULL,
    "savedPerMonth" INTEGER NOT NULL,
    "medianWaitSeconds" INTEGER,
    "covered" INTEGER NOT NULL,
    "baseVersion" INTEGER NOT NULL,
    "draftYaml" TEXT NOT NULL,
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RuleSuggestion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RuleSuggestion_orgId_status_idx" ON "RuleSuggestion"("orgId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "RuleSuggestion_orgId_agentId_kind_fingerprint_key" ON "RuleSuggestion"("orgId", "agentId", "kind", "fingerprint");
