import { getConfig, validateConfig } from "./config";
import { closePool, testConnection } from "./db";
import { listQueuedSigningJobs } from "./jobs";
import { processNextSigningJob } from "./signing";
import { logger } from "./logger";
import { listQueuedSubmissionJobs } from "./sri-submission-jobs";
import { processNextSubmissionJob } from "./sri-submission";
import { runRecoverAuthorizationCommand } from "./sri-recovery";

const command = process.argv[2] ?? "help";

async function cmdCheckEnv(): Promise<void> {
  logger.info("Verificando configuración de entorno...");
  try {
    validateConfig();
    logger.info("Configuración válida.");
  } catch (err) {
    logger.error("Error en configuración", {
      message: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  }
}

async function cmdScan(): Promise<void> {
  logger.info("=== SCAN — solo lectura, sin modificar DB ===");

  const config = getConfig();
  logger.info("Config cargada", {
    workerId: config.workerId,
    db: config.databaseUrlSanitized,
    enableRealSigning: config.enableRealSriSigning,
    enableDryRun: config.enableDryRun,
    dryRunMarkSuccess: config.dryRunMarkSuccess,
  });

  const connected = await testConnection();
  if (!connected) {
    logger.error("No se puede continuar — falla la conexión a PostgreSQL.");
    process.exit(1);
  }

  const jobs = await listQueuedSigningJobs(20);

  if (jobs.length === 0) {
    logger.info("No hay jobs QUEUED disponibles.");
  } else {
    logger.info(`Jobs QUEUED encontrados: ${jobs.length}`);
    for (const job of jobs) {
      logger.info("  job", {
        id: job.id,
        tenantId: job.tenantId,
        documentId: job.documentId,
        attempts: job.attempts,
        maxAttempts: job.maxAttempts,
        runAfter: job.runAfter?.toISOString() ?? null,
        createdAt: job.createdAt.toISOString(),
      });
    }
  }

  logger.info("=== SCAN completado ===");
}

async function cmdRunOnce(): Promise<void> {
  logger.info("=== RUN:ONCE — reclama máximo 1 job y termina ===");

  const connected = await testConnection();
  if (!connected) {
    logger.error("No se puede continuar — falla la conexión a PostgreSQL.");
    process.exit(1);
  }

  const result = await processNextSigningJob();

  switch (result.outcome) {
    case "no_job":
      logger.info("No había jobs disponibles. Nada que procesar.");
      break;
    case "claimed":
      logger.info("Job procesado", {
        jobId: result.jobId,
        result: result.result,
      });
      break;
    case "error":
      logger.error("Error al procesar", { message: result.message });
      process.exit(1);
  }

  logger.info("=== RUN:ONCE completado ===");
}

async function cmdScanSubmission(): Promise<void> {
  logger.info("=== SCAN:SUBMISSION — solo lectura, sin modificar DB ===");

  const connected = await testConnection();
  if (!connected) {
    logger.error("No se puede continuar — falla la conexión a PostgreSQL.");
    process.exit(1);
  }

  const jobs = await listQueuedSubmissionJobs(20);
  if (jobs.length === 0) {
    logger.info("No hay submission jobs pendientes.");
  } else {
    logger.info(`Submission jobs pendientes: ${jobs.length}`);
    for (const job of jobs) {
      logger.info("  submission-job", {
        id: job.id,
        tenantId: job.tenantId,
        documentId: job.documentId,
        status: job.status,
        attempts: job.attempts,
        maxAttempts: job.maxAttempts,
        runAfter: job.runAfter?.toISOString() ?? null,
        createdAt: job.createdAt.toISOString(),
      });
    }
  }

  logger.info("=== SCAN:SUBMISSION completado ===");
}

async function cmdSubmitOnce(): Promise<void> {
  logger.info("=== SUBMIT:ONCE — reclama maximo 1 submission job y termina ===");

  const connected = await testConnection();
  if (!connected) {
    logger.error("No se puede continuar — falla la conexión a PostgreSQL.");
    process.exit(1);
  }

  const result = await processNextSubmissionJob();
  switch (result.outcome) {
    case "no_job":
      logger.info("No habia submission jobs disponibles.");
      break;
    case "claimed":
      logger.info("Submission job procesado", {
        jobId: result.jobId,
        result: result.result,
      });
      break;
    case "error":
      logger.error("Error al procesar submission", { message: result.message });
      process.exit(1);
  }

  logger.info("=== SUBMIT:ONCE completado ===");
}

async function cmdRecoverAuthorization(): Promise<void> {
  logger.info("=== RECOVER:AUTHORIZATION — consulta autorización SRI y corrige DB ===");

  const connected = await testConnection();
  if (!connected) {
    logger.error("No se puede continuar — falla la conexión a PostgreSQL.");
    process.exit(1);
  }

  await runRecoverAuthorizationCommand();
  logger.info("=== RECOVER:AUTHORIZATION completado ===");
}

function printHelp(): void {
  console.log(`
sri-signing-worker — Appsolux SRI job processor

Comandos disponibles:

  check-env   Verifica variables de entorno requeridas
  scan        Lista jobs QUEUED (solo lectura, no modifica DB)
  run:once    Reclama y procesa máximo 1 job, luego termina
  scan:submission   Lista jobs de envio SRI TEST pendientes
  submit:once       Reclama y procesa máximo 1 submission job, luego termina
  recover:authorization  Consulta autorizacion por SRI_DOCUMENT_ID o ACCESS_KEY y recupera DB

Uso:
  npm run check-env
  npm run scan
  npm run run:once
  npm run scan:submission
  npm run submit:once
  SRI_DOCUMENT_ID=... npm run recover:authorization
`);
}

async function main(): Promise<void> {
  try {
    switch (command) {
      case "check-env":
        await cmdCheckEnv();
        break;
      case "scan":
        await cmdScan();
        break;
      case "run:once":
        await cmdRunOnce();
        break;
      case "scan:submission":
        await cmdScanSubmission();
        break;
      case "submit:once":
        await cmdSubmitOnce();
        break;
      case "recover:authorization":
        await cmdRecoverAuthorization();
        break;
      default:
        printHelp();
    }
  } catch (err) {
    logger.error("Error fatal", {
      message: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  } finally {
    await closePool();
  }
}

void main();
