-- guardsync: the console's governance configuration drives the real guard. Rows the console made carry the
-- console's own id (agents, keys, rulebook versions, MCP servers); keys gain an environment and an expiry; the
-- console's approver groups are kept for routing held calls.
-- AlterTable
ALTER TABLE "Agent" ADD COLUMN     "consoleId" TEXT;

-- AlterTable
ALTER TABLE "ApiKey" ADD COLUMN     "consoleId" TEXT,
ADD COLUMN     "environment" TEXT NOT NULL DEFAULT 'production',
ADD COLUMN     "expiresAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Rulebook" ADD COLUMN     "consoleHash" TEXT,
ADD COLUMN     "consoleId" TEXT;

-- AlterTable
ALTER TABLE "UpstreamServer" ADD COLUMN     "consoleId" TEXT;

-- CreateTable
CREATE TABLE "ConsoleApproverGroup" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "consoleId" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "memberIds" TEXT[],
    "emails" TEXT[],
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConsoleApproverGroup_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ConsoleApproverGroup_orgId_consoleId_key" ON "ConsoleApproverGroup"("orgId", "consoleId");

-- CreateIndex
CREATE UNIQUE INDEX "ConsoleApproverGroup_orgId_slug_key" ON "ConsoleApproverGroup"("orgId", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "Agent_orgId_consoleId_key" ON "Agent"("orgId", "consoleId");

-- CreateIndex
CREATE UNIQUE INDEX "ApiKey_orgId_consoleId_key" ON "ApiKey"("orgId", "consoleId");

-- CreateIndex
CREATE UNIQUE INDEX "UpstreamServer_orgId_consoleId_key" ON "UpstreamServer"("orgId", "consoleId");

