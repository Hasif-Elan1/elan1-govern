-- CreateTable
CREATE TABLE "HsmKey" (
    "handle" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "publicKey" TEXT NOT NULL,
    "materialEnc" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HsmKey_pkey" PRIMARY KEY ("handle")
);

-- CreateTable
CREATE TABLE "KeyCeremony" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'generation',
    "kid" TEXT NOT NULL,
    "threshold" INTEGER NOT NULL,
    "shareCount" INTEGER NOT NULL,
    "custodians" JSONB NOT NULL,
    "shareSet" TEXT NOT NULL,
    "backupEnc" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KeyCeremony_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KeySuccessor" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "kid" TEXT NOT NULL,
    "publicKey" TEXT NOT NULL,
    "privateKeyEnc" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "ceremonyId" TEXT,
    "proposedBy" TEXT NOT NULL,
    "boundSeq" INTEGER NOT NULL,
    "boundAt" TIMESTAMP(3) NOT NULL,
    "switchAt" TIMESTAMP(3) NOT NULL,
    "confirmedBy" TEXT,
    "confirmedSeq" INTEGER,
    "activatedAt" TIMESTAMP(3),
    "activatedSeq" INTEGER,
    "withdrawnAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KeySuccessor_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "KeyCeremony_orgId_createdAt_idx" ON "KeyCeremony"("orgId", "createdAt");

-- CreateIndex
CREATE INDEX "KeySuccessor_orgId_activatedAt_idx" ON "KeySuccessor"("orgId", "activatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "KeySuccessor_orgId_kid_key" ON "KeySuccessor"("orgId", "kid");
