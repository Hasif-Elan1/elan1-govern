-- AlterTable
ALTER TABLE "Org" ADD COLUMN     "replayStore" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "ReplayCall" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "tool" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "argsEnc" TEXT NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReplayCall_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ReplayCall_orgId_agentId_ts_idx" ON "ReplayCall"("orgId", "agentId", "ts");

-- CreateIndex
CREATE INDEX "ReplayCall_ts_idx" ON "ReplayCall"("ts");

-- CreateIndex
CREATE UNIQUE INDEX "ReplayCall_orgId_seq_key" ON "ReplayCall"("orgId", "seq");
