import * as crypto from "crypto";

// Format: v1:<base64(iv)>:<base64(authTag)>:<base64(ciphertext)>
const VERSION_PREFIX = "v1:";
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32; // AES-256

function parseKey(keyHex: string): Buffer {
  if (!keyHex || keyHex.trim() === "") {
    throw new Error("SRI_CERT_ENCRYPTION_KEY no está configurada.");
  }
  const stripped = keyHex.trim();
  if (!/^[0-9a-fA-F]{64}$/.test(stripped)) {
    throw new Error(
      `SRI_CERT_ENCRYPTION_KEY tiene formato inválido. ` +
        `Debe ser 64 caracteres hexadecimales (32 bytes). ` +
        `Longitud recibida: ${stripped.length}`
    );
  }
  const buf = Buffer.from(stripped, "hex");
  if (buf.length !== KEY_BYTES) {
    throw new Error(`SRI_CERT_ENCRYPTION_KEY debe ser exactamente ${KEY_BYTES} bytes.`);
  }
  return buf;
}

function parseEncrypted(encrypted: string): { iv: Buffer; tag: Buffer; ciphertext: Buffer } {
  if (!encrypted.startsWith(VERSION_PREFIX)) {
    throw new Error(
      `Formato de cifrado no reconocido. Se esperaba prefijo "${VERSION_PREFIX}". ` +
        `Verifica que el valor fue cifrado con el mismo formato que el dashboard.`
    );
  }

  const parts = encrypted.slice(VERSION_PREFIX.length).split(":");
  if (parts.length !== 3) {
    throw new Error(
      `Formato de cifrado inválido. Se esperaban 3 partes (iv:tag:ciphertext), ` +
        `se encontraron ${parts.length}.`
    );
  }

  const [ivB64, tagB64, ciphertextB64] = parts as [string, string, string];

  const iv = Buffer.from(ivB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  const ciphertext = Buffer.from(ciphertextB64, "base64");

  if (iv.length !== IV_BYTES) {
    throw new Error(`IV inválido: se esperaban ${IV_BYTES} bytes, se obtuvieron ${iv.length}.`);
  }
  if (tag.length !== TAG_BYTES) {
    throw new Error(`Auth tag inválido: se esperaban ${TAG_BYTES} bytes, se obtuvieron ${tag.length}.`);
  }
  if (ciphertext.length === 0) {
    throw new Error("El texto cifrado está vacío.");
  }

  return { iv, tag, ciphertext };
}

export function decryptText(encrypted: string, keyHex: string): string {
  const key = parseKey(keyHex);
  const { iv, tag, ciphertext } = parseEncrypted(encrypted);

  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return plain.toString("utf8");
  } catch {
    // Do not log the key or any plaintext
    throw new Error(
      "Error al descifrar texto. Verifica que SRI_CERT_ENCRYPTION_KEY es correcta " +
        "y el valor fue cifrado con el mismo algoritmo."
    );
  }
}

export function decryptBuffer(encrypted: string, keyHex: string): Buffer {
  const key = parseKey(keyHex);
  const { iv, tag, ciphertext } = parseEncrypted(encrypted);

  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new Error(
      "Error al descifrar buffer. Verifica que SRI_CERT_ENCRYPTION_KEY es correcta " +
        "y el certificado fue cifrado correctamente."
    );
  }
}
