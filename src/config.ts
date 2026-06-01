import dotenv from "dotenv";
import path from "path";

dotenv.config({ path: path.resolve(process.cwd(), ".env") });

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val || val.trim() === "") {
    throw new Error(`Variable de entorno requerida no encontrada: ${name}`);
  }
  return val.trim();
}

function boolEnv(name: string, defaultValue: boolean): boolean {
  const val = process.env[name];
  if (val === undefined || val === "") return defaultValue;
  return val.trim().toLowerCase() === "true";
}

function sanitizeDatabaseUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.username}:***@${parsed.host}${parsed.pathname}`;
  } catch {
    return "[DATABASE_URL inválida]";
  }
}

export type WorkerConfig = {
  databaseUrl: string;
  databaseUrlSanitized: string;
  dbSsl: boolean;
  workerId: string;
  enableRealSriSigning: boolean;
  enableDryRun: boolean;
  dryRunMarkSuccess: boolean;
  certEncryptionKey: string | null;
  certStoragePath: string | null;
  signedXmlStoragePath: string | null;
};

let _config: WorkerConfig | null = null;

export function getConfig(): WorkerConfig {
  if (_config) return _config;

  const databaseUrl = requireEnv("DATABASE_URL_WORKER");
  const workerId = requireEnv("WORKER_ID");

  const enableRealSriSigning = boolEnv("ENABLE_REAL_SRI_SIGNING", false);
  const enableDryRun = boolEnv("ENABLE_SRI_SIGNING_DRY_RUN", true);
  const dryRunMarkSuccess = boolEnv("DRY_RUN_MARK_SUCCESS", false);
  const dbSsl = boolEnv("DB_SSL", false);

  const certEncryptionKey = process.env["SRI_CERT_ENCRYPTION_KEY"]?.trim() || null;
  const certStoragePath = process.env["SRI_CERT_STORAGE_PATH"]?.trim() || null;
  const signedXmlStoragePath =
    process.env["SRI_SIGNED_XML_STORAGE_PATH"]?.trim() ||
    (certStoragePath ? certStoragePath + "/signed-xml" : null);

  // When real signing is enabled, validate that required secrets are present
  if (enableRealSriSigning) {
    if (!certEncryptionKey) {
      throw new Error(
        "ENABLE_REAL_SRI_SIGNING=true requiere SRI_CERT_ENCRYPTION_KEY configurada. " +
          "Sin esta clave no es posible descifrar los certificados."
      );
    }
    if (!certStoragePath) {
      throw new Error(
        "ENABLE_REAL_SRI_SIGNING=true requiere SRI_CERT_STORAGE_PATH configurada. " +
          "Sin esta ruta no es posible leer los certificados cifrados."
      );
    }
    if (!signedXmlStoragePath) {
      throw new Error(
        "ENABLE_REAL_SRI_SIGNING=true requiere SRI_SIGNED_XML_STORAGE_PATH (o SRI_CERT_STORAGE_PATH) configurada. " +
          "Sin esta ruta no es posible guardar los XML firmados."
      );
    }
  }

  _config = {
    databaseUrl,
    databaseUrlSanitized: sanitizeDatabaseUrl(databaseUrl),
    dbSsl,
    workerId,
    enableRealSriSigning,
    enableDryRun,
    dryRunMarkSuccess,
    certEncryptionKey,
    certStoragePath,
    signedXmlStoragePath,
  };

  return _config;
}

export function validateConfig(): void {
  const config = getConfig();
  console.log("=== Validación de configuración ===");
  console.log(`  WORKER_ID                  : ${config.workerId}`);
  console.log(`  DATABASE_URL_WORKER        : ${config.databaseUrlSanitized}`);
  console.log(`  DB_SSL                     : ${config.dbSsl}`);
  console.log(`  ENABLE_REAL_SRI_SIGNING    : ${config.enableRealSriSigning}`);
  console.log(`  ENABLE_SRI_SIGNING_DRY_RUN : ${config.enableDryRun}`);
  console.log(`  DRY_RUN_MARK_SUCCESS       : ${config.dryRunMarkSuccess}`);
  console.log(`  SRI_CERT_ENCRYPTION_KEY    : ${config.certEncryptionKey ? "[configurada]" : "[vacía]"}`);
  console.log(`  SRI_CERT_STORAGE_PATH      : ${config.certStoragePath ?? "[vacía]"}`);
  console.log(`  SRI_SIGNED_XML_STORAGE_PATH: ${config.signedXmlStoragePath ?? "[vacía]"}`);
  console.log("===================================");
}
