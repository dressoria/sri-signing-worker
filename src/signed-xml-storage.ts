import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";

function resolveStorageRoot(storagePath: string): string {
  return path.resolve(storagePath);
}

function safeResolveOutputPath(
  storageRoot: string,
  tenantId: string,
  documentId: string
): string {
  // Validate IDs — only alphanumeric + hyphens/underscores (CUID/UUID-safe)
  if (!/^[a-zA-Z0-9_-]+$/.test(tenantId)) {
    throw new Error(`tenantId inválido para path de storage: "${tenantId}"`);
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(documentId)) {
    throw new Error(`documentId inválido para path de storage: "${documentId}"`);
  }

  const fullPath = path.join(storageRoot, tenantId, documentId, "signed.xml");

  if (!fullPath.startsWith(storageRoot + path.sep)) {
    throw new Error(
      `Path resuelto escapa del storage root. Root: ${storageRoot}, resuelto: ${fullPath}`
    );
  }

  return fullPath;
}

export type SaveSignedXmlResult = {
  storageKey: string; // relative key — tenant/document/signed.xml
  sha256Hex: string;
  byteLength: number;
};

export function saveSignedXml(
  storagePath: string,
  tenantId: string,
  documentId: string,
  signedXml: string
): SaveSignedXmlResult {
  if (!storagePath || storagePath.trim() === "") {
    throw new Error(
      "SRI_SIGNED_XML_STORAGE_PATH (o SRI_CERT_STORAGE_PATH) no está configurado. " +
        "Configura la ruta donde se guardarán los XML firmados."
    );
  }

  const storageRoot = resolveStorageRoot(storagePath.trim());
  const filePath = safeResolveOutputPath(storageRoot, tenantId, documentId);

  // Ensure the directory exists
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });

  const xmlBuffer = Buffer.from(signedXml, "utf8");
  const sha256Hex = crypto.createHash("sha256").update(xmlBuffer).digest("hex");

  fs.writeFileSync(filePath, xmlBuffer, { encoding: null });

  // Return relative storage key, not the full path
  const storageKey = path.join(tenantId, documentId, "signed.xml");

  return {
    storageKey,
    sha256Hex,
    byteLength: xmlBuffer.length,
  };
}

export function readSignedXml(storagePath: string, storageKey: string): string {
  if (!storagePath || storagePath.trim() === "") {
    throw new Error("SRI_SIGNED_XML_STORAGE_PATH no está configurado.");
  }

  const storageRoot = resolveStorageRoot(storagePath.trim());
  const normalized = path.normalize(storageKey).replace(/^(\.\.\/|\.\/|\/)+/, "");

  if (normalized.includes("..")) {
    throw new Error(`storageKey inválido — contiene path traversal: "${storageKey}"`);
  }

  const filePath = path.join(storageRoot, normalized);

  if (!filePath.startsWith(storageRoot + path.sep)) {
    throw new Error(`storageKey escapa del storage root.`);
  }

  if (!fs.existsSync(filePath)) {
    throw new Error(`XML firmado no encontrado: "${storageKey}"`);
  }

  return fs.readFileSync(filePath, "utf8");
}
