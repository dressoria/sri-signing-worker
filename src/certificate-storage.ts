import * as fs from "fs";
import * as path from "path";

function resolveStorageRoot(storagePath: string): string {
  return path.resolve(storagePath);
}

function safeResolvePath(storageRoot: string, storageKey: string): string {
  // Normalize the storage key: strip leading slashes, prevent traversal
  const normalized = path.normalize(storageKey).replace(/^(\.\.\/|\.\/|\/)+/, "");

  if (normalized.includes("..")) {
    throw new Error(
      `storageKey inválido — contiene path traversal: "${storageKey}"`
    );
  }

  const fullPath = path.join(storageRoot, normalized);

  // Verify it stays within the storage root
  if (!fullPath.startsWith(storageRoot + path.sep) && fullPath !== storageRoot) {
    throw new Error(
      `storageKey intenta escapar del storage root. ` +
        `Root: ${storageRoot}, resuelto: ${fullPath}`
    );
  }

  return fullPath;
}

export function readEncryptedCertificate(
  storagePath: string,
  encryptedStorageKey: string
): Buffer {
  if (!storagePath || storagePath.trim() === "") {
    throw new Error(
      "SRI_CERT_STORAGE_PATH no está configurada. " +
        "Configura la ruta donde están guardados los certificados cifrados."
    );
  }

  if (!encryptedStorageKey || encryptedStorageKey.trim() === "") {
    throw new Error(
      "encryptedCertificateStorageKey está vacío en la configuración de firma del tenant."
    );
  }

  const storageRoot = resolveStorageRoot(storagePath);
  const filePath = safeResolvePath(storageRoot, encryptedStorageKey.trim());

  // Log only the relative key, not the full path
  if (!fs.existsSync(filePath)) {
    throw new Error(
      `Certificado cifrado no encontrado. ` +
        `storageKey: "${encryptedStorageKey.trim()}". ` +
        `Verifica que el archivo fue guardado correctamente al configurar la firma.`
    );
  }

  const stat = fs.statSync(filePath);
  if (!stat.isFile()) {
    throw new Error(
      `La ruta del certificado no es un archivo: "${encryptedStorageKey.trim()}".`
    );
  }

  if (stat.size === 0) {
    throw new Error(
      `El archivo de certificado cifrado está vacío: "${encryptedStorageKey.trim()}".`
    );
  }

  // Max 10 MB for a certificate — sanity check
  const MAX_CERT_BYTES = 10 * 1024 * 1024;
  if (stat.size > MAX_CERT_BYTES) {
    throw new Error(
      `El archivo de certificado cifrado es demasiado grande (${stat.size} bytes). ` +
        `Se esperaba un archivo .p12/.pfx pequeño.`
    );
  }

  return fs.readFileSync(filePath);
}
