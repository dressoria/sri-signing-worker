import { PoolClient } from "pg";
import { query, withTransaction } from "./db";
import { getConfig } from "./config";
import { logger } from "./logger";
import crypto from "crypto";

export type SigningJobStatus = "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELLED";

export type SigningJob = {
  id: string;
  tenantId: string;
  documentId: string;
  status: SigningJobStatus;
  priority: number;
  attempts: number;
  maxAttempts: number;
  lockedAt: Date | null;
  lockedBy: string | null;
  runAfter: Date | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  errorCode: string | null;
  errorMessage: string | null;
  unsignedXmlHash: string | null;
  signedXmlStorageKey: string | null;
  signedXmlHash: string | null;
  createdAt: Date;
  updatedAt: Date;
};

type RawJobRow = {
  id: string;
  tenantId: string;
  documentId: string;
  status: SigningJobStatus;
  priority: string;
  attempts: string;
  maxAttempts: string;
  lockedAt: string | null;
  lockedBy: string | null;
  runAfter: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  unsignedXmlHash: string | null;
  signedXmlStorageKey: string | null;
  signedXmlHash: string | null;
  createdAt: string;
  updatedAt: string;
};

function mapJob(row: RawJobRow): SigningJob {
  return {
    id: row.id,
    tenantId: row.tenantId,
    documentId: row.documentId,
    status: row.status,
    priority: Number(row.priority),
    attempts: Number(row.attempts),
    maxAttempts: Number(row.maxAttempts),
    lockedAt: row.lockedAt ? new Date(row.lockedAt) : null,
    lockedBy: row.lockedBy,
    runAfter: row.runAfter ? new Date(row.runAfter) : null,
    startedAt: row.startedAt ? new Date(row.startedAt) : null,
    finishedAt: row.finishedAt ? new Date(row.finishedAt) : null,
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    unsignedXmlHash: row.unsignedXmlHash,
    signedXmlStorageKey: row.signedXmlStorageKey,
    signedXmlHash: row.signedXmlHash,
    createdAt: new Date(row.createdAt),
    updatedAt: new Date(row.updatedAt),
  };
}

export async function listQueuedSigningJobs(limit = 10): Promise<SigningJob[]> {
  const now = new Date().toISOString();
  const rows = await query<RawJobRow>(
    `SELECT * FROM "SriSigningJob"
     WHERE status = 'QUEUED'
       AND ("runAfter" IS NULL OR "runAfter" <= $1)
     ORDER BY priority DESC, "runAfter" ASC NULLS FIRST, "createdAt" ASC
     LIMIT $2`,
    [now, limit]
  );
  return rows.map(mapJob);
}

export async function claimNextSigningJob(workerId: string): Promise<SigningJob | null> {
  const now = new Date().toISOString();

  return withTransaction(async (client: PoolClient) => {
    // Find the best candidate
    const findResult = await client.query<RawJobRow>(
      `SELECT * FROM "SriSigningJob"
       WHERE status = 'QUEUED'
         AND ("runAfter" IS NULL OR "runAfter" <= $1)
       ORDER BY priority DESC, "runAfter" ASC NULLS FIRST, "createdAt" ASC
       LIMIT 1
       FOR UPDATE SKIP LOCKED`,
      [now]
    );

    if (findResult.rows.length === 0) return null;

    const candidate = findResult.rows[0]!;

    // Update — re-check status in WHERE to guard against race
    const updateResult = await client.query<RawJobRow>(
      `UPDATE "SriSigningJob"
       SET
         status = 'RUNNING',
         "lockedAt" = $1,
         "lockedBy" = $2,
         "startedAt" = COALESCE("startedAt", $1),
         attempts = attempts + 1,
         "updatedAt" = $1
       WHERE id = $3 AND status = 'QUEUED'
       RETURNING *`,
      [now, workerId, candidate.id]
    );

    if (updateResult.rows.length === 0) return null;
    return mapJob(updateResult.rows[0]!);
  });
}

export async function markJobFailed(
  jobId: string,
  errorCode: string,
  errorMessage: string,
  allowRetry = true
): Promise<SigningJob> {
  const now = new Date();

  // Load current job to check attempts
  const rows = await query<RawJobRow>(
    `SELECT attempts, "maxAttempts" FROM "SriSigningJob" WHERE id = $1`,
    [jobId]
  );

  if (rows.length === 0) {
    throw new Error(`Job no encontrado: ${jobId}`);
  }

  const job = rows[0]!;
  const attempts = Number(job.attempts);
  const maxAttempts = Number(job.maxAttempts);
  const retryable = allowRetry && attempts < maxAttempts;

  const runAfter = retryable
    ? new Date(now.getTime() + attempts * 60_000)
    : null;

  const updatedRows = await query<RawJobRow>(
    `UPDATE "SriSigningJob"
     SET
       status = $1,
       "finishedAt" = $2,
       "runAfter" = $3,
       "errorCode" = $4,
       "errorMessage" = $5,
       "lockedAt" = NULL,
       "lockedBy" = NULL,
       "updatedAt" = $6
     WHERE id = $7
     RETURNING *`,
    [
      retryable ? "QUEUED" : "FAILED",
      retryable ? null : now.toISOString(),
      retryable ? runAfter!.toISOString() : null,
      errorCode,
      errorMessage,
      now.toISOString(),
      jobId,
    ]
  );

  if (updatedRows.length === 0) {
    throw new Error(`No se pudo actualizar job: ${jobId}`);
  }

  logger.warn(`Job marcado como ${retryable ? "QUEUED (reintento)" : "FAILED"}`, {
    jobId,
    attempts,
    maxAttempts,
    retryable,
    runAfter: runAfter?.toISOString() ?? null,
    errorCode,
  });

  return mapJob(updatedRows[0]!);
}

export async function markJobSucceededDryRun(
  jobId: string,
  unsignedXmlContent: string
): Promise<SigningJob> {
  const config = getConfig();

  if (!config.enableDryRun || !config.dryRunMarkSuccess) {
    throw new Error(
      "markJobSucceededDryRun llamado pero DRY_RUN_MARK_SUCCESS o ENABLE_SRI_SIGNING_DRY_RUN no están habilitados."
    );
  }

  const now = new Date().toISOString();

  // Hash del XML preliminar con prefijo dry-run para distinguirlo de firma real
  const rawHash = crypto.createHash("sha256").update(unsignedXmlContent).digest("hex");
  const dryRunHash = `dry-run:${rawHash}`;
  const storageKey = "dry-run/not-signed";

  // NEVER change SriDocument.status to SIGNED
  const updatedRows = await query<RawJobRow>(
    `UPDATE "SriSigningJob"
     SET
       status = 'SUCCEEDED',
       "finishedAt" = $1,
       "lockedAt" = NULL,
       "lockedBy" = NULL,
       "signedXmlHash" = $2,
       "signedXmlStorageKey" = $3,
       "updatedAt" = $1
     WHERE id = $4
     RETURNING *`,
    [now, dryRunHash, storageKey, jobId]
  );

  if (updatedRows.length === 0) {
    throw new Error(`No se pudo actualizar job: ${jobId}`);
  }

  logger.info(
    "Job marcado SUCCEEDED en modo dry-run. SriDocument.status NO fue cambiado a SIGNED.",
    {
      jobId,
      signedXmlHash: dryRunHash,
      signedXmlStorageKey: storageKey,
      note: "Dry-run — sin firma XAdES-BES real",
    }
  );

  return mapJob(updatedRows[0]!);
}

export async function markJobSucceededReal(
  jobId: string,
  params: {
    signedXmlStorageKey: string;
    signedXmlHash: string;
    unsignedXmlHash: string;
  }
): Promise<SigningJob> {
  const { signedXmlStorageKey, signedXmlHash, unsignedXmlHash } = params;
  const now = new Date().toISOString();

  // Load job to get documentId and tenantId for the SriDocument update
  const jobRows = await query<RawJobRow>(
    `SELECT * FROM "SriSigningJob" WHERE id = $1`,
    [jobId]
  );

  if (jobRows.length === 0) {
    throw new Error(`Job no encontrado: ${jobId}`);
  }

  const job = jobRows[0]!;

  // Atomic transaction: mark job SUCCEEDED + update SriDocument.status = SIGNED
  return withTransaction(async (client: PoolClient) => {
    const updatedJobRows = await client.query<RawJobRow>(
      `UPDATE "SriSigningJob"
       SET
         status = 'SUCCEEDED',
         "finishedAt" = $1,
         "lockedAt" = NULL,
         "lockedBy" = NULL,
         "signedXmlHash" = $2,
         "signedXmlStorageKey" = $3,
         "unsignedXmlHash" = $4,
         "updatedAt" = $1
       WHERE id = $5 AND status = 'RUNNING'
       RETURNING *`,
      [now, signedXmlHash, signedXmlStorageKey, unsignedXmlHash, jobId]
    );

    if (updatedJobRows.rows.length === 0) {
      throw new Error(
        `No se pudo marcar job SUCCEEDED — puede que ya no esté en RUNNING: ${jobId}`
      );
    }

    // Update SriDocument.status to SIGNED only after job is confirmed SUCCEEDED
    await client.query(
      `UPDATE "SriDocument"
       SET status = 'SIGNED', "updatedAt" = $1
       WHERE id = $2 AND "tenantId" = $3`,
      [now, job.documentId, job.tenantId]
    );

    logger.info("Job SUCCEEDED y SriDocument.status actualizado a SIGNED.", {
      jobId,
      documentId: job.documentId,
      tenantId: job.tenantId,
      signedXmlStorageKey,
      signedXmlHashPartial: signedXmlHash.slice(0, 12) + "...",
    });

    return mapJob(updatedJobRows.rows[0]!);
  });
}
