-- CreateTable
CREATE TABLE "ConsoleState" (
    "orgId" TEXT NOT NULL,
    "doc" JSON NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConsoleState_pkey" PRIMARY KEY ("orgId")
);
