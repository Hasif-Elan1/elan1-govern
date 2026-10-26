-- CreateTable
CREATE TABLE "UpstreamServer" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "authHeaderEnc" TEXT,
    "status" TEXT NOT NULL DEFAULT 'new',
    "lastSyncedAt" TIMESTAMP(3),
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UpstreamServer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UpstreamTool" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "inputSchema" JSONB NOT NULL,
    "tags" TEXT[],
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UpstreamTool_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "UpstreamServer_orgId_slug_key" ON "UpstreamServer"("orgId", "slug");

-- CreateIndex
CREATE INDEX "UpstreamTool_serverId_idx" ON "UpstreamTool"("serverId");

-- CreateIndex
CREATE UNIQUE INDEX "UpstreamTool_orgId_name_key" ON "UpstreamTool"("orgId", "name");

-- AddForeignKey
ALTER TABLE "UpstreamTool" ADD CONSTRAINT "UpstreamTool_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "UpstreamServer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
