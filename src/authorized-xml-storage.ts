import * as fs from "fs";
import * as path from "path";

function resolveStorageRoot(storagePath: string): string {
  return path.resolve(storagePath.trim());
}

function validateSegment(label: string, value: string): void {
  if (!/^[a-zA-Z0-9_-]+$/.test(value)) {
    throw new Error(`${label} inválido para authorized-xml storage: "${value}"`);
  }
}

function safeResolveOutputPath(
  storageRoot: string,
  tenantId: string,
  documentId: string
): string {
  validateSegment("tenantId", tenantId);
  validateSegment("documentId", documentId);

  const fullPath = path.join(storageRoot, tenantId, documentId, "authorized.xml");

  if (!fullPath.startsWith(storageRoot + path.sep)) {
    throw new Error(
      `Path resuelto escapa del storage root. Root: ${storageRoot}, resuelto: ${fullPath}`
    );
  }
  return fullPath;
}

export type SaveAuthorizedXmlResult = {
  storageKey: string;
  byteLength: number;
};

export function saveAuthorizedXml(
  storagePath: string,
  tenantId: string,
  documentId: string,
  rawXml: string
): SaveAuthorizedXmlResult {
  if (!storagePath || storagePath.trim() === "") {
    throw new Error(
      "SRI_AUTHORIZED_XML_STORAGE_PATH (o SRI_SIGNED_XML_STORAGE_PATH) no está configurado."
    );
  }

  const storageRoot = resolveStorageRoot(storagePath);
  const filePath = safeResolveOutputPath(storageRoot, tenantId, documentId);

  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });

  const xmlBuffer = Buffer.from(rawXml, "utf8");
  fs.writeFileSync(filePath, xmlBuffer, { encoding: null });

  const storageKey = path.join(tenantId, documentId, "authorized.xml");
  return { storageKey, byteLength: xmlBuffer.length };
}

export function readAuthorizedXml(storagePath: string, storageKey: string): string {
  if (!storagePath || storagePath.trim() === "") {
    throw new Error("SRI_AUTHORIZED_XML_STORAGE_PATH no está configurado.");
  }

  const storageRoot = resolveStorageRoot(storagePath);
  const normalized = path.normalize(storageKey).replace(/^(\.\.\/|\.\/|\/)+/, "");

  if (normalized.includes("..")) {
    throw new Error(`storageKey inválido — contiene path traversal: "${storageKey}"`);
  }

  const filePath = path.join(storageRoot, normalized);
  if (!filePath.startsWith(storageRoot + path.sep)) {
    throw new Error("storageKey escapa del storage root.");
  }

  if (!fs.existsSync(filePath)) {
    throw new Error(`XML autorizado no encontrado: "${storageKey}"`);
  }

  return fs.readFileSync(filePath, "utf8");
}
