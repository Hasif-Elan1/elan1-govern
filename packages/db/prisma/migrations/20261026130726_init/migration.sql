-- CreateEnum
CREATE TYPE "Role" AS ENUM ('owner', 'admin', 'approver', 'viewer', 'auditor');

-- CreateEnum
CREATE TYPE "AgentStatus" AS ENUM ('active', 'paused');

-- CreateEnum
CREATE TYPE "RiskTier" AS ENUM ('low', 'medium', 'high');

-- CreateEnum
CREATE TYPE "ApprovalStatus" AS ENUM ('pending', 'approved', 'rejected', 'expired');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "totpSecret" TEXT,
    "totpEnabled" BOOLEAN NOT NULL DEFAULT false,
    "failedLogins" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "activeOrgId" TEXT,
    "csrfToken" TEXT NOT NULL,
    "lastAuthAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Membership" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Membership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Org" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "publicKey" TEXT NOT NULL,
    "privateKeyEnc" TEXT NOT NULL,
    "notifyEmail" TEXT,
    "retentionDays" INTEGER NOT NULL DEFAULT 2555,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Org_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Invite" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "invitedBy" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Invite_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Agent" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "ownerEmail" TEXT NOT NULL,
    "createdById" TEXT,
    "riskTier" "RiskTier" NOT NULL DEFAULT 'medium',
    "riskAnswers" JSONB,
    "status" "AgentStatus" NOT NULL DEFAULT 'active',
    "activeRulebookId" TEXT,
    "lastActionAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Agent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApiKey" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "label" TEXT NOT NULL DEFAULT 'Default',
    "prefix" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "ApiKey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Rulebook" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "yaml" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "signedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Rulebook_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Connector" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'mock',
    "status" TEXT NOT NULL DEFAULT 'connected',
    "tokensEnc" TEXT,
    "accountLabel" TEXT,
    "meta" JSONB,
    "connectedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Connector_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Approval" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "tool" TEXT NOT NULL,
    "argsEnc" TEXT,
    "argsSummary" JSONB NOT NULL,
    "ruleId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "approverGroup" TEXT NOT NULL,
    "approvers" TEXT[],
    "evidence" JSONB,
    "status" "ApprovalStatus" NOT NULL DEFAULT 'pending',
    "heldSeq" INTEGER NOT NULL,
    "resolvedBy" TEXT,
    "note" TEXT,
    "selfApproval" BOOLEAN NOT NULL DEFAULT false,
    "result" JSONB,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Approval_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApprovalLink" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "approvalId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApprovalLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Receipt" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL,
    "kind" TEXT NOT NULL,
    "agent" TEXT,
    "tool" TEXT,
    "decision" TEXT,
    "amountInr" DOUBLE PRECISION,
    "outcome" TEXT,
    "body" JSONB NOT NULL,
    "hash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Receipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Checkpoint" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "hash" TEXT NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL,
    "sig" TEXT NOT NULL,

    CONSTRAINT "Checkpoint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Control" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "evidence" TEXT NOT NULL,
    "mappings" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',

    CONSTRAINT "Control_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HealthAlert" (
    "id" TEXT NOT NULL,
    "orgId" TEXT,
    "kind" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "HealthAlert_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Session_tokenHash_key" ON "Session"("tokenHash");

-- CreateIndex
CREATE INDEX "Membership_orgId_idx" ON "Membership"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "Membership_userId_orgId_key" ON "Membership"("userId", "orgId");

-- CreateIndex
CREATE UNIQUE INDEX "Invite_tokenHash_key" ON "Invite"("tokenHash");

-- CreateIndex
CREATE INDEX "Invite_orgId_idx" ON "Invite"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "Agent_orgId_slug_key" ON "Agent"("orgId", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "ApiKey_keyHash_key" ON "ApiKey"("keyHash");

-- CreateIndex
CREATE INDEX "ApiKey_orgId_idx" ON "ApiKey"("orgId");

-- CreateIndex
CREATE INDEX "Rulebook_orgId_idx" ON "Rulebook"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "Rulebook_agentId_version_key" ON "Rulebook"("agentId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "Connector_orgId_kind_key" ON "Connector"("orgId", "kind");

-- CreateIndex
CREATE INDEX "Approval_orgId_status_idx" ON "Approval"("orgId", "status");

-- CreateIndex
CREATE INDEX "ApprovalLink_orgId_idx" ON "ApprovalLink"("orgId");

-- CreateIndex
CREATE INDEX "Receipt_orgId_ts_idx" ON "Receipt"("orgId", "ts");

-- CreateIndex
CREATE INDEX "Receipt_orgId_agent_idx" ON "Receipt"("orgId", "agent");

-- CreateIndex
CREATE UNIQUE INDEX "Receipt_orgId_seq_key" ON "Receipt"("orgId", "seq");

-- CreateIndex
CREATE INDEX "Checkpoint_orgId_seq_idx" ON "Checkpoint"("orgId", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "Control_orgId_code_key" ON "Control"("orgId", "code");

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Agent" ADD CONSTRAINT "Agent_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApiKey" ADD CONSTRAINT "ApiKey_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Rulebook" ADD CONSTRAINT "Rulebook_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApprovalLink" ADD CONSTRAINT "ApprovalLink_approvalId_fkey" FOREIGN KEY ("approvalId") REFERENCES "Approval"("id") ON DELETE CASCADE ON UPDATE CASCADE;
