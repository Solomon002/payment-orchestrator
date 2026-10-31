-- CreateEnum
CREATE TYPE "AccountType" AS ENUM ('merchant_balance', 'merchant_pending', 'payments_pending', 'gateway_clearing', 'gateway_fees', 'platform_revenue', 'payouts_clearing', 'opening_balance');

-- CreateEnum
CREATE TYPE "NormalSide" AS ENUM ('debit', 'credit');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('card', 'bank_transfer');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('created', 'pending', 'succeeded', 'failed', 'expired');

-- CreateEnum
CREATE TYPE "AttemptStatus" AS ENUM ('initiated', 'error', 'succeeded', 'failed');

-- CreateEnum
CREATE TYPE "WithdrawalStatus" AS ENUM ('completed', 'rejected');

-- CreateEnum
CREATE TYPE "WebhookStatus" AS ENUM ('received', 'queued', 'processed', 'failed', 'rejected');

-- CreateEnum
CREATE TYPE "IdempotencyStatus" AS ENUM ('in_progress', 'completed');

-- CreateEnum
CREATE TYPE "ReconciliationStatus" AS ENUM ('running', 'completed', 'failed');

-- CreateEnum
CREATE TYPE "DiscrepancyType" AS ENUM ('missing_in_ledger', 'missing_in_gateway', 'amount_mismatch', 'status_mismatch');

-- CreateTable
CREATE TABLE "merchants" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "api_key_hash" TEXT NOT NULL,
    "api_key_prefix" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "merchants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "accounts" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "type" "AccountType" NOT NULL,
    "normal_side" "NormalSide" NOT NULL,
    "merchant_id" UUID,
    "gateway" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'NGN',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "journal_entries" (
    "id" UUID NOT NULL,
    "reference" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "payment_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "journal_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "postings" (
    "id" UUID NOT NULL,
    "journal_entry_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "amount_kobo" BIGINT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "postings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" UUID NOT NULL,
    "merchant_id" UUID NOT NULL,
    "merchant_reference" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "amount_kobo" BIGINT NOT NULL,
    "fee_kobo" BIGINT,
    "currency" TEXT NOT NULL DEFAULT 'NGN',
    "method" "PaymentMethod" NOT NULL,
    "status" "PaymentStatus" NOT NULL DEFAULT 'created',
    "customer_email" TEXT NOT NULL,
    "selected_gateway" TEXT,
    "checkout_url" TEXT,
    "failure_reason" TEXT,
    "succeeded_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_attempts" (
    "id" UUID NOT NULL,
    "payment_id" UUID NOT NULL,
    "gateway" TEXT NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "status" "AttemptStatus" NOT NULL,
    "gateway_reference" TEXT,
    "error" TEXT,
    "latency_ms" INTEGER,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),

    CONSTRAINT "payment_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "withdrawals" (
    "id" UUID NOT NULL,
    "merchant_id" UUID NOT NULL,
    "amount_kobo" BIGINT NOT NULL,
    "status" "WithdrawalStatus" NOT NULL,
    "idempotency_key" TEXT,
    "journal_entry_id" UUID,
    "mode" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "withdrawals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_events" (
    "id" UUID NOT NULL,
    "gateway" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "event_type" TEXT,
    "reference" TEXT,
    "raw_body" TEXT NOT NULL,
    "signature_valid" BOOLEAN NOT NULL,
    "status" "WebhookStatus" NOT NULL DEFAULT 'received',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "duplicate_count" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMP(3),

    CONSTRAINT "webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_keys" (
    "id" UUID NOT NULL,
    "merchant_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "status" "IdempotencyStatus" NOT NULL DEFAULT 'in_progress',
    "response_status" INTEGER,
    "response_body" JSONB,
    "locked_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gateway_settlements" (
    "id" UUID NOT NULL,
    "gateway" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "amount_kobo" BIGINT NOT NULL,
    "fee_kobo" BIGINT NOT NULL,
    "settled_at" TIMESTAMP(3) NOT NULL,
    "batch_id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "imported_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "gateway_settlements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reconciliation_runs" (
    "id" UUID NOT NULL,
    "status" "ReconciliationStatus" NOT NULL DEFAULT 'running',
    "window_from" TIMESTAMP(3) NOT NULL,
    "window_to" TIMESTAMP(3) NOT NULL,
    "totals" JSONB,
    "error" TEXT,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),

    CONSTRAINT "reconciliation_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "discrepancies" (
    "id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "type" "DiscrepancyType" NOT NULL,
    "gateway" TEXT NOT NULL,
    "payment_id" UUID,
    "gateway_reference" TEXT,
    "ledger_amount" BIGINT,
    "gateway_amount" BIGINT,
    "note" TEXT,
    "resolved" BOOLEAN NOT NULL DEFAULT false,
    "resolved_note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "discrepancies_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "merchants_api_key_hash_key" ON "merchants"("api_key_hash");

-- CreateIndex
CREATE UNIQUE INDEX "accounts_code_key" ON "accounts"("code");

-- CreateIndex
CREATE UNIQUE INDEX "journal_entries_reference_key" ON "journal_entries"("reference");

-- CreateIndex
CREATE INDEX "journal_entries_payment_id_idx" ON "journal_entries"("payment_id");

-- CreateIndex
CREATE INDEX "postings_account_id_idx" ON "postings"("account_id");

-- CreateIndex
CREATE INDEX "postings_journal_entry_id_idx" ON "postings"("journal_entry_id");

-- CreateIndex
CREATE UNIQUE INDEX "payments_reference_key" ON "payments"("reference");

-- CreateIndex
CREATE INDEX "payments_status_created_at_idx" ON "payments"("status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "payments_merchant_id_merchant_reference_key" ON "payments"("merchant_id", "merchant_reference");

-- CreateIndex
CREATE INDEX "payment_attempts_payment_id_idx" ON "payment_attempts"("payment_id");

-- CreateIndex
CREATE UNIQUE INDEX "withdrawals_merchant_id_idempotency_key_key" ON "withdrawals"("merchant_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "webhook_events_status_received_at_idx" ON "webhook_events"("status", "received_at");

-- CreateIndex
CREATE INDEX "webhook_events_reference_idx" ON "webhook_events"("reference");

-- CreateIndex
CREATE UNIQUE INDEX "webhook_events_gateway_event_id_key" ON "webhook_events"("gateway", "event_id");

-- CreateIndex
CREATE INDEX "idempotency_keys_created_at_idx" ON "idempotency_keys"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_keys_merchant_id_key_key" ON "idempotency_keys"("merchant_id", "key");

-- CreateIndex
CREATE INDEX "gateway_settlements_settled_at_idx" ON "gateway_settlements"("settled_at");

-- CreateIndex
CREATE UNIQUE INDEX "gateway_settlements_gateway_reference_key" ON "gateway_settlements"("gateway", "reference");

-- CreateIndex
CREATE INDEX "discrepancies_run_id_idx" ON "discrepancies"("run_id");

-- CreateIndex
CREATE INDEX "discrepancies_resolved_idx" ON "discrepancies"("resolved");

-- AddForeignKey
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "postings" ADD CONSTRAINT "postings_journal_entry_id_fkey" FOREIGN KEY ("journal_entry_id") REFERENCES "journal_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "postings" ADD CONSTRAINT "postings_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_attempts" ADD CONSTRAINT "payment_attempts_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "withdrawals" ADD CONSTRAINT "withdrawals_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "discrepancies" ADD CONSTRAINT "discrepancies_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "reconciliation_runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
