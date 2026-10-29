-- CreateTable
CREATE TABLE "SamlConnection" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "idpEntityId" TEXT NOT NULL,
    "idpSsoUrl" TEXT NOT NULL,
    "idpCertPems" TEXT[],
    "spEntityId" TEXT NOT NULL,
    "wantAssertionsSigned" BOOLEAN NOT NULL DEFAULT true,
    "domains" TEXT[],
    "verifyToken" TEXT NOT NULL,
    "verifiedDomains" TEXT[],
    "enforced" BOOLEAN NOT NULL DEFAULT false,
    "jit" BOOLEAN NOT NULL DEFAULT true,
    "defaultRole" "Role" NOT NULL DEFAULT 'viewer',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SamlConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SamlReplay" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SamlReplay_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScimConnection" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "tokenPrefix" TEXT NOT NULL,
    "defaultRole" "Role" NOT NULL DEFAULT 'viewer',
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ScimConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScimUser" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "userName" TEXT NOT NULL,
    "externalId" TEXT,
    "displayName" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "role" "Role" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ScimUser_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SamlConnection_orgId_key" ON "SamlConnection"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "SamlConnection_spEntityId_key" ON "SamlConnection"("spEntityId");

-- CreateIndex
CREATE INDEX "SamlReplay_expiresAt_idx" ON "SamlReplay"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "SamlReplay_orgId_key_key" ON "SamlReplay"("orgId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "ScimConnection_orgId_key" ON "ScimConnection"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "ScimConnection_tokenHash_key" ON "ScimConnection"("tokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "ScimUser_orgId_userId_key" ON "ScimUser"("orgId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "ScimUser_orgId_userName_key" ON "ScimUser"("orgId", "userName");
