import { getConfig, validateConfig } from "./config";
import { closePool, testConnection } from "./db";
import { listQueuedSigningJobs } from "./jobs";
import { processNextSigningJob } from "./signing";
import { logger } from "./logger";

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

function printHelp(): void {
  console.log(`
sri-signing-worker — Appsolux SRI job processor

Comandos disponibles:

  check-env   Verifica variables de entorno requeridas
  scan        Lista jobs QUEUED (solo lectura, no modifica DB)
  run:once    Reclama y procesa máximo 1 job, luego termina

Uso:
  npm run check-env
  npm run scan
  npm run run:once
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
