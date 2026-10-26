-- Framework library and industry packs.
-- The controls catalogue moved into code (@gate/core/frameworks), so the per-org copy in
-- "Control" (seed data, never edited in the app) is dropped.

-- AlterTable
ALTER TABLE "Org" ADD COLUMN     "industry" TEXT,
ADD COLUMN     "regions" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- DropTable
DROP TABLE "Control";

-- CreateTable
CREATE TABLE "OrgFramework" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "frameworkId" TEXT NOT NULL,
    "enabledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "enabledBy" TEXT NOT NULL,

    CONSTRAINT "OrgFramework_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OrgFramework_orgId_frameworkId_key" ON "OrgFramework"("orgId", "frameworkId");

-- Backfill: orgs created before the library showed these five frameworks in the compliance
-- map, so they stay switched on.
INSERT INTO "OrgFramework" ("id", "orgId", "frameworkId", "enabledBy")
SELECT gen_random_uuid()::text, o."id", f."frameworkId", 'migration'
FROM "Org" o
CROSS JOIN (VALUES ('dpdp'), ('rbi-free-ai'), ('iso-42001'), ('eu-ai-act'), ('nist-ai-rmf')) AS f("frameworkId")
ON CONFLICT DO NOTHING;
