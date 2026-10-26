-- CreateTable
CREATE TABLE "AiSystem" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "vendor" TEXT,
    "purpose" TEXT NOT NULL,
    "ownerEmail" TEXT NOT NULL,
    "businessUnit" TEXT,
    "lifecycle" TEXT NOT NULL DEFAULT 'proposed',
    "riskTier" TEXT NOT NULL DEFAULT 'unassessed',
    "dataCategories" TEXT[],
    "affectedPeople" TEXT[],
    "decisionImpact" TEXT NOT NULL DEFAULT 'none',
    "agentId" TEXT,
    "nextReviewAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiSystem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Assessment" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "systemId" TEXT NOT NULL,
    "templateKey" TEXT NOT NULL,
    "templateVersion" INTEGER NOT NULL,
    "answers" JSONB NOT NULL DEFAULT '{}',
    "score" INTEGER,
    "resultTier" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "createdBy" TEXT NOT NULL,
    "submittedBy" TEXT,
    "submittedById" TEXT,
    "submittedAt" TIMESTAMP(3),
    "reviewedBy" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Assessment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AiSystem_orgId_idx" ON "AiSystem"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "AiSystem_orgId_agentId_key" ON "AiSystem"("orgId", "agentId");

-- CreateIndex
CREATE INDEX "Assessment_orgId_status_idx" ON "Assessment"("orgId", "status");

-- CreateIndex
CREATE INDEX "Assessment_orgId_systemId_idx" ON "Assessment"("orgId", "systemId");

-- AddForeignKey
ALTER TABLE "Assessment" ADD CONSTRAINT "Assessment_systemId_fkey" FOREIGN KEY ("systemId") REFERENCES "AiSystem"("id") ON DELETE CASCADE ON UPDATE CASCADE;
