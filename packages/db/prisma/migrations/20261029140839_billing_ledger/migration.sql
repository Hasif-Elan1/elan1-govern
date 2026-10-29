-- CreateTable
CREATE TABLE "BillingAccount" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "plan" TEXT NOT NULL DEFAULT 'l1',
    "invoicePrefix" TEXT NOT NULL,
    "buyerName" TEXT NOT NULL,
    "buyerGstin" TEXT,
    "buyerAddress" TEXT,
    "residency" TEXT,
    "pilotStartsAt" TIMESTAMP(3),
    "pilotEndsAt" TIMESTAMP(3),
    "pilotCap" INTEGER,
    "pilotStoppedAt" TIMESTAMP(3),
    "pilotStoppedWhy" TEXT,
    "pilotStoppedSeq" INTEGER,
    "pilotConvertedAt" TIMESTAMP(3),
    "pilotConvertedTo" TEXT,
    "pilotClosedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BillingAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Invoice" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'monthly',
    "period" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "subtotalPaise" BIGINT NOT NULL,
    "gstPaise" BIGINT NOT NULL,
    "totalPaise" BIGINT NOT NULL,
    "heldPaise" BIGINT NOT NULL DEFAULT 0,
    "payablePaise" BIGINT NOT NULL,
    "gstPercent" INTEGER NOT NULL DEFAULT 18,
    "placeOfSupply" TEXT NOT NULL,
    "irn" TEXT NOT NULL,
    "lines" JSONB NOT NULL,
    "fromSeq" INTEGER,
    "toSeq" INTEGER,
    "events" INTEGER NOT NULL DEFAULT 0,
    "heldByRunId" TEXT,
    "issuedAt" TIMESTAMP(3),
    "dueAt" TIMESTAMP(3),
    "voidedAt" TIMESTAMP(3),
    "voidReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Invoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreditNote" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "invoiceNumber" TEXT NOT NULL,
    "line" TEXT NOT NULL,
    "disputeId" TEXT,
    "outcome" TEXT NOT NULL,
    "amountPaise" BIGINT NOT NULL,
    "gstPaise" BIGINT NOT NULL,
    "totalPaise" BIGINT NOT NULL,
    "irn" TEXT NOT NULL,
    "note" TEXT NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CreditNote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Discount" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "pctBasisPoints" INTEGER NOT NULL,
    "fromDay" TEXT NOT NULL,
    "untilDay" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'offered',
    "offeredBy" TEXT NOT NULL,
    "offeredByRole" TEXT NOT NULL,
    "reference" TEXT,
    "validUntil" TEXT NOT NULL,
    "requestId" TEXT,
    "offerSeq" INTEGER,
    "acceptedBy" TEXT,
    "acceptedAt" TIMESTAMP(3),
    "acceptedSeq" INTEGER,
    "declinedReason" TEXT,
    "endedAt" TIMESTAMP(3),
    "endedReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Discount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DiscountRequest" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "pctBasisPoints" INTEGER NOT NULL,
    "months" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "requestedBy" TEXT NOT NULL,
    "needs" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'with_elan1',
    "offerId" TEXT,
    "declinedReason" TEXT,
    "declinedBy" TEXT,
    "seq" INTEGER,
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DiscountRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Dispute" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "invoiceNumber" TEXT NOT NULL,
    "line" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "fromSeq" INTEGER,
    "toSeq" INTEGER,
    "openedBy" TEXT NOT NULL,
    "seq" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'open',
    "outcome" TEXT,
    "linePaise" BIGINT,
    "creditPaise" BIGINT,
    "creditNoteNumber" TEXT,
    "note" TEXT,
    "decidedBy" TEXT,
    "decidedByRole" TEXT,
    "approvedBy" TEXT,
    "settleSeq" INTEGER,
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Dispute_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReconciliationRun" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "meterEvents" INTEGER NOT NULL,
    "chainDecisions" INTEGER NOT NULL,
    "meterTenths" INTEGER NOT NULL,
    "chainTenths" INTEGER NOT NULL,
    "matched" BOOLEAN NOT NULL,
    "note" TEXT,
    "runBy" TEXT NOT NULL,
    "seq" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReconciliationRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BillingAccount_orgId_key" ON "BillingAccount"("orgId");

-- CreateIndex
CREATE INDEX "Invoice_orgId_period_idx" ON "Invoice"("orgId", "period");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_orgId_number_key" ON "Invoice"("orgId", "number");

-- CreateIndex
CREATE INDEX "CreditNote_orgId_invoiceNumber_idx" ON "CreditNote"("orgId", "invoiceNumber");

-- CreateIndex
CREATE UNIQUE INDEX "CreditNote_orgId_number_key" ON "CreditNote"("orgId", "number");

-- CreateIndex
CREATE INDEX "Discount_orgId_status_idx" ON "Discount"("orgId", "status");

-- CreateIndex
CREATE INDEX "DiscountRequest_orgId_status_idx" ON "DiscountRequest"("orgId", "status");

-- CreateIndex
CREATE INDEX "Dispute_orgId_invoiceNumber_line_idx" ON "Dispute"("orgId", "invoiceNumber", "line");

-- CreateIndex
CREATE INDEX "Dispute_orgId_status_idx" ON "Dispute"("orgId", "status");

-- CreateIndex
CREATE INDEX "ReconciliationRun_orgId_period_createdAt_idx" ON "ReconciliationRun"("orgId", "period", "createdAt");

-- Issued invoices never change. Once an invoice is issued or void the database refuses any change to it, except
-- voiding an issued one (status, voidedAt, voidReason), and refuses deleting it. Credit notes never change at all.
-- Corrections are credit notes. Prisma does not manage triggers, so `migrate dev` leaves these in place.
CREATE FUNCTION billing_invoice_immutable() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."status" IN ('issued', 'void') THEN
      RAISE EXCEPTION 'invoice % is %, so it cannot be deleted', OLD."number", OLD."status" USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD."status" = 'void'
     OR (OLD."status" = 'issued' AND (NEW."status" <> 'void'
       OR (to_jsonb(NEW) - 'status' - 'voidedAt' - 'voidReason' - 'updatedAt') IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'voidedAt' - 'voidReason' - 'updatedAt'))) THEN
    RAISE EXCEPTION 'invoice % is %, so it cannot be changed; issue a credit note instead', OLD."number", OLD."status" USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "Invoice_immutable_once_issued" BEFORE UPDATE OR DELETE ON "Invoice"
  FOR EACH ROW EXECUTE FUNCTION billing_invoice_immutable();

CREATE FUNCTION billing_credit_note_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'credit note % cannot be changed or deleted', OLD."number" USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "CreditNote_immutable" BEFORE UPDATE OR DELETE ON "CreditNote"
  FOR EACH ROW EXECUTE FUNCTION billing_credit_note_immutable();
