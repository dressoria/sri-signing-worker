import crypto from "crypto";
import { PoolClient } from "pg";

import { query, withTransaction } from "./db";
import { logger } from "./logger";

export type SubmissionJobStatus =
  | "QUEUED"
  | "RUNNING"
  | "RECEIVED"
  | "AUTHORIZED"
  | "REJECTED"
  | "FAILED"
  | "CANCELLED";

export type SubmissionJob = {
  id: string;
  tenantId: string;
  documentId: string;
  status: SubmissionJobStatus;
  environment: "TEST" | "PRODUCTION";
  priority: number;
  attempts: number;
  maxAttempts: number;
  lockedAt: Date | null;
  lockedBy: string | null;
  runAfter: Date | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  receivedAt: Date | null;
  authorizedAt: Date | null;
  sriReceiptStatus: string | null;
  sriAuthorizationStatus: string | null;
  sriAuthorizationNumber: string | null;
  sriAccessKey: string | null;
  sriResponseRaw: unknown;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: Date;
  updatedAt: Date;
};

type RawSubmissionJobRow = {
  id: string;
  tenantId: string;
  documentId: string;
  status: SubmissionJobStatus;
  environment: "TEST" | "PRODUCTION";
  priority: string;
  attempts: string;
  maxAttempts: string;
  lockedAt: string | null;
  lockedBy: string | null;
  runAfter: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  receivedAt: string | null;
  authorizedAt: string | null;
  sriReceiptStatus: string | null;
  sriAuthorizationStatus: string | null;
  sriAuthorizationNumber: string | null;
  sriAccessKey: string | null;
  sriResponseRaw: unknown;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
};

function mapJob(row: RawSubmissionJobRow): SubmissionJob {
  return {
    id: row.id,
    tenantId: row.tenantId,
    documentId: row.documentId,
    status: row.status,
    environment: row.environment,
    priority: Number(row.priority),
    attempts: Number(row.attempts),
    maxAttempts: Number(row.maxAttempts),
    lockedAt: row.lockedAt ? new Date(row.lockedAt) : null,
    lockedBy: row.lockedBy,
    runAfter: row.runAfter ? new Date(row.runAfter) : null,
    startedAt: row.startedAt ? new Date(row.startedAt) : null,
    finishedAt: row.finishedAt ? new Date(row.finishedAt) : null,
    receivedAt: row.receivedAt ? new Date(row.receivedAt) : null,
    authorizedAt: row.authorizedAt ? new Date(row.authorizedAt) : null,
    sriReceiptStatus: row.sriReceiptStatus,
    sriAuthorizationStatus: row.sriAuthorizationStatus,
    sriAuthorizationNumber: row.sriAuthorizationNumber,
    sriAccessKey: row.sriAccessKey,
    sriResponseRaw: row.sriResponseRaw,
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    createdAt: new Date(row.createdAt),
    updatedAt: new Date(row.updatedAt),
  };
}

export async function listQueuedSubmissionJobs(limit = 10): Promise<SubmissionJob[]> {
  const now = new Date().toISOString();
  const rows = await query<RawSubmissionJobRow>(
    `SELECT * FROM "SriSubmissionJob"
     WHERE status IN ('QUEUED', 'RECEIVED')
       AND ("runAfter" IS NULL OR "runAfter" <= $1)
     ORDER BY priority DESC, "runAfter" ASC NULLS FIRST, "createdAt" ASC
     LIMIT $2`,
    [now, limit]
  );
  return rows.map(mapJob);
}

export async function claimNextSubmissionJob(workerId: string): Promise<SubmissionJob | null> {
  const now = new Date().toISOString();

  return withTransaction(async (client: PoolClient) => {
    const findResult = await client.query<RawSubmissionJobRow>(
      `SELECT * FROM "SriSubmissionJob"
       WHERE status IN ('QUEUED', 'RECEIVED')
         AND ("runAfter" IS NULL OR "runAfter" <= $1)
       ORDER BY priority DESC, "runAfter" ASC NULLS FIRST, "createdAt" ASC
       LIMIT 1
       FOR UPDATE SKIP LOCKED`,
      [now]
    );

    if (findResult.rows.length === 0) return null;

    const candidate = findResult.rows[0]!;
    const updateResult = await client.query<RawSubmissionJobRow>(
      `UPDATE "SriSubmissionJob"
       SET
         status = 'RUNNING',
         "lockedAt" = $1,
         "lockedBy" = $2,
         "startedAt" = COALESCE("startedAt", $1),
         attempts = attempts + 1,
         "updatedAt" = $1
       WHERE id = $3 AND status IN ('QUEUED', 'RECEIVED')
       RETURNING *`,
      [now, workerId, candidate.id]
    );

    if (updateResult.rows.length === 0) return null;
    return mapJob(updateResult.rows[0]!);
  });
}

export async function markSubmissionReceived(params: {
  jobId: string;
  sriReceiptStatus: string;
  sriAccessKey: string;
  sriResponseRaw: unknown;
  pollAfterMs?: number;
}): Promise<SubmissionJob> {
  const now = new Date();
  const pollAfter = new Date(now.getTime() + (params.pollAfterMs ?? 30_000));

  return withTransaction(async (client: PoolClient) => {
    const updated = await client.query<RawSubmissionJobRow>(
      `UPDATE "SriSubmissionJob"
       SET
         status = 'RECEIVED',
         "receivedAt" = COALESCE("receivedAt", $1),
         "lockedAt" = NULL,
         "lockedBy" = NULL,
         "runAfter" = $2,
         "sriReceiptStatus" = $3,
         "sriAccessKey" = $4,
         "sriResponseRaw" = $5::jsonb,
         "updatedAt" = $1
       WHERE id = $6
       RETURNING *`,
      [
        now.toISOString(),
        pollAfter.toISOString(),
        params.sriReceiptStatus,
        params.sriAccessKey,
        JSON.stringify(params.sriResponseRaw),
        params.jobId,
      ]
    );

    if (updated.rows.length === 0) {
      throw new Error(`Submission job no encontrado: ${params.jobId}`);
    }

    const job = updated.rows[0]!;
    await client.query(
      `UPDATE "SriDocument"
       SET status = 'SENT', "updatedAt" = $1
       WHERE id = $2 AND "tenantId" = $3 AND status IN ('SIGNED', 'SENT')`,
      [now.toISOString(), job.documentId, job.tenantId]
    );

    logger.info("Submission job marcado RECEIVED.", {
      jobId: params.jobId,
      sriReceiptStatus: params.sriReceiptStatus,
    });

    return mapJob(job);
  });
}

export async function markSubmissionAuthorized(params: {
  jobId: string;
  sriAuthorizationStatus: string;
  sriAuthorizationNumber: string;
  sriAccessKey: string;
  authorizedAt: Date;
  sriResponseRaw: unknown;
  authorizedXmlStorageKey?: string | null;
}): Promise<SubmissionJob> {
  const finishedAt = new Date().toISOString();

  return withTransaction(async (client: PoolClient) => {
    const updated = await client.query<RawSubmissionJobRow>(
      `UPDATE "SriSubmissionJob"
       SET
         status = 'AUTHORIZED',
         "finishedAt" = $1,
         "authorizedAt" = $2,
         "lockedAt" = NULL,
         "lockedBy" = NULL,
         "sriAuthorizationStatus" = $3,
         "sriAuthorizationNumber" = $4,
         "sriAccessKey" = $5,
         "sriResponseRaw" = $6::jsonb,
         "authorizedXmlStorageKey" = COALESCE($8, "authorizedXmlStorageKey"),
         "updatedAt" = $1
       WHERE id = $7 AND status = 'RUNNING'
       RETURNING *`,
      [
        finishedAt,
        params.authorizedAt.toISOString(),
        params.sriAuthorizationStatus,
        params.sriAuthorizationNumber,
        params.sriAccessKey,
        JSON.stringify(params.sriResponseRaw),
        params.jobId,
        params.authorizedXmlStorageKey ?? null,
      ]
    );

    if (updated.rows.length === 0) {
      throw new Error(`No se pudo marcar submission job AUTHORIZED: ${params.jobId}`);
    }

    const job = updated.rows[0]!;
    await client.query(
      `UPDATE "SriDocument"
       SET status = 'AUTHORIZED', "updatedAt" = $1
       WHERE id = $2 AND "tenantId" = $3`,
      [finishedAt, job.documentId, job.tenantId]
    );

    return mapJob(job);
  });
}

export async function markSubmissionRejected(params: {
  jobId: string;
  sriReceiptStatus?: string | null;
  sriAuthorizationStatus?: string | null;
  sriAccessKey?: string | null;
  errorMessage: string;
  sriResponseRaw: unknown;
}): Promise<SubmissionJob> {
  const now = new Date().toISOString();

  return withTransaction(async (client: PoolClient) => {
    const updated = await client.query<RawSubmissionJobRow>(
      `UPDATE "SriSubmissionJob"
       SET
         status = 'REJECTED',
         "finishedAt" = $1,
         "lockedAt" = NULL,
         "lockedBy" = NULL,
         "sriReceiptStatus" = COALESCE($2, "sriReceiptStatus"),
         "sriAuthorizationStatus" = COALESCE($3, "sriAuthorizationStatus"),
         "sriAccessKey" = COALESCE($4, "sriAccessKey"),
         "errorMessage" = $5,
         "sriResponseRaw" = $6::jsonb,
         "updatedAt" = $1
       WHERE id = $7
       RETURNING *`,
      [
        now,
        params.sriReceiptStatus,
        params.sriAuthorizationStatus,
        params.sriAccessKey,
        params.errorMessage,
        JSON.stringify(params.sriResponseRaw),
        params.jobId,
      ]
    );

    if (updated.rows.length === 0) {
      throw new Error(`No se pudo marcar submission job REJECTED: ${params.jobId}`);
    }

    const job = updated.rows[0]!;
    await client.query(
      `UPDATE "SriDocument"
       SET status = 'REJECTED', "updatedAt" = $1
       WHERE id = $2 AND "tenantId" = $3`,
      [now, job.documentId, job.tenantId]
    );

    return mapJob(job);
  });
}

export async function createSubmissionJobAfterSigning(params: {
  tenantId: string;
  documentId: string;
  environment: "TEST" | "PRODUCTION";
  sriAccessKey: string | null;
}): Promise<void> {
  const existing = await query<{ id: string }>(
    `SELECT id FROM "SriSubmissionJob"
     WHERE "documentId" = $1 AND "tenantId" = $2
       AND status IN ('QUEUED', 'RUNNING', 'RECEIVED', 'AUTHORIZED')
     LIMIT 1`,
    [params.documentId, params.tenantId]
  );

  if (existing.length > 0) {
    logger.info("Submission job ya existe para este documento.", {
      documentId: params.documentId,
      existingJobId: existing[0]!.id,
    });
    return;
  }

  const docRows = await query<{ status: string }>(
    `SELECT status FROM "SriDocument" WHERE id = $1 AND "tenantId" = $2`,
    [params.documentId, params.tenantId]
  );

  const doc = docRows[0];
  if (!doc || doc.status !== "SIGNED") {
    logger.warn("No se creó submission job: documento no en estado SIGNED.", {
      documentId: params.documentId,
      status: doc?.status ?? "no encontrado",
    });
    return;
  }

  const id = crypto.randomUUID();
  await query(
    `INSERT INTO "SriSubmissionJob"
      (id, "tenantId", "documentId", environment, status, priority, attempts, "maxAttempts", "sriAccessKey", "createdAt", "updatedAt")
     VALUES ($1, $2, $3, $4, 'QUEUED', 5, 0, 3, $5, NOW(), NOW())`,
    [id, params.tenantId, params.documentId, params.environment, params.sriAccessKey]
  );

  logger.info("Submission job creado automaticamente despues de firma exitosa.", {
    submissionJobId: id,
    documentId: params.documentId,
    tenantId: params.tenantId,
    environment: params.environment,
  });
}

export async function markSubmissionFailed(params: {
  jobId: string;
  errorCode: string;
  errorMessage: string;
  sriResponseRaw?: unknown;
}): Promise<SubmissionJob> {
  const now = new Date();
  const rows = await query<RawSubmissionJobRow>(
    `SELECT attempts, "maxAttempts" FROM "SriSubmissionJob" WHERE id = $1`,
    [params.jobId]
  );

  if (rows.length === 0) throw new Error(`Submission job no encontrado: ${params.jobId}`);

  const current = rows[0]!;
  const attempts = Number(current.attempts);
  const maxAttempts = Number(current.maxAttempts);
  const retryable = attempts < maxAttempts;
  const runAfter = retryable ? new Date(now.getTime() + attempts * 60_000) : null;

  const updated = await query<RawSubmissionJobRow>(
    `UPDATE "SriSubmissionJob"
     SET
       status = $1,
       "finishedAt" = $2,
       "runAfter" = $3,
       "lockedAt" = NULL,
       "lockedBy" = NULL,
       "errorCode" = $4,
       "errorMessage" = $5,
       "sriResponseRaw" = COALESCE($6::jsonb, "sriResponseRaw"),
       "updatedAt" = $7
     WHERE id = $8
     RETURNING *`,
    [
      retryable ? "QUEUED" : "FAILED",
      retryable ? null : now.toISOString(),
      retryable ? runAfter!.toISOString() : null,
      params.errorCode,
      params.errorMessage,
      params.sriResponseRaw ? JSON.stringify(params.sriResponseRaw) : null,
      now.toISOString(),
      params.jobId,
    ]
  );

  if (updated.length === 0) throw new Error(`No se pudo actualizar submission job: ${params.jobId}`);

  logger.warn(`Submission job marcado como ${retryable ? "QUEUED (reintento)" : "FAILED"}`, {
    jobId: params.jobId,
    errorCode: params.errorCode,
    retryable,
  });

  return mapJob(updated[0]!);
}
