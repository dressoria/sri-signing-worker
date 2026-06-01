/**
 * Firma XAdES-BES real para comprobantes SRI Ecuador.
 * Usa node-forge para parsear PKCS#12 y Node.js crypto para RSA-SHA256.
 * La canonicalización (C14N) usa xml-crypto's C14nCanonicalization.
 *
 * NO conecta con el SRI. NO autoriza comprobantes.
 * Solo genera el XML firmado criptográficamente.
 */

import forge from "node-forge";
import { C14nCanonicalization, findAncestorNs } from "xml-crypto";
import { DOMParser } from "@xmldom/xmldom";
import * as crypto from "crypto";

// ── Algoritmos XAdES ──────────────────────────────────────────────────────────

const ALG_C14N = "http://www.w3.org/TR/2001/REC-xml-c14n-20010315";
const ALG_RSA_SHA256 = "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256";
const ALG_SHA256 = "http://www.w3.org/2001/04/xmlenc#sha256";
const ALG_ENVELOPED = "http://www.w3.org/2000/09/xmldsig#enveloped-signature";
const TYPE_SIGNED_PROPS = "http://uri.etsi.org/01903#SignedProperties";
const NS_XMLDSIG = "http://www.w3.org/2000/09/xmldsig#";
const NS_XADES = "http://uri.etsi.org/01903/v1.3.2#";
const SIGNATURE_ID = "Signature";
const SIGNED_INFO_ID = "Signature-SignedInfo";
const SIGNED_PROPERTIES_ID = "Signature-SignedProperties";
const KEY_INFO_ID = "Signature-KeyInfo";
const OBJECT_ID = "Signature-Object";
const SIGNED_PROPERTIES_REF_URI = `#${SIGNED_PROPERTIES_ID}`;
const SIGNED_PROPERTIES_REF_XPATH = `//*[@Id='${SIGNED_PROPERTIES_ID}' or @ID='${SIGNED_PROPERTIES_ID}' or @id='${SIGNED_PROPERTIES_ID}']`;

// ── Tipos públicos ────────────────────────────────────────────────────────────

export type CertificateBundle = {
  privateKeyPem: string;
  certPem: string;
  certDerBase64: string;
  certSha256FingerprintHex: string;
  issuerName: string;
  serialNumber: string; // decimal string
  subjectName: string;
  notBefore: Date;
  notAfter: Date;
};

export type SigningResult = {
  signedXml: string;
  signedXmlHash: string; // SHA256 hex of the final signed XML
  certificateFingerprint: string; // SHA256 hex of cert DER
  warnings: string[];
};

// ── Helpers internos ──────────────────────────────────────────────────────────

function sha256b64(data: Buffer | string): string {
  return crypto
    .createHash("sha256")
    .update(typeof data === "string" ? Buffer.from(data, "utf8") : data)
    .digest("base64");
}

function sha256hex(data: Buffer | string): string {
  return crypto
    .createHash("sha256")
    .update(typeof data === "string" ? Buffer.from(data, "utf8") : data)
    .digest("hex");
}

function buildDnString(attrs: forge.pki.CertificateField[]): string {
  const map: Record<string, string> = {
    commonName: "CN",
    organizationName: "O",
    organizationalUnitName: "OU",
    localityName: "L",
    stateOrProvinceName: "ST",
    countryName: "C",
    emailAddress: "E",
    serialName: "SERIALNUMBER",
  };

  return attrs
    .map((a) => {
      const short = a.shortName || map[a.name ?? ""] || String(a.type ?? a.name);
      const val = String(a.value ?? "").replace(/,/g, "\\,").replace(/=/g, "\\=");
      return `${short}=${val}`;
    })
    .join(",");
}

function c14nNode(node: Node, ancestorNamespaces: { prefix: string; namespaceURI: string }[]): string {
  const c14n = new C14nCanonicalization();
  return c14n.process(node, { ancestorNamespaces });
}

function parseXmlDoc(xmlString: string): Document {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlString, "text/xml");

  // Check for parse errors (@xmldom/xmldom style)
  const errNs = "http://www.mozilla.org/newlayout/xml/parsererror.xml";
  const errEls = doc.getElementsByTagNameNS(errNs, "parsererror");
  if (errEls.length > 0) {
    throw new Error(`Error parseando XML: ${errEls[0]?.textContent ?? "parse error"}`);
  }

  return doc;
}

function getElementLocalName(node: Node | null): string | null {
  if (!node || node.nodeType !== node.ELEMENT_NODE) return null;
  const el = node as Element;
  return el.localName || el.nodeName.split(":").pop() || null;
}

function getElementIdValue(element: Element): string | null {
  return element.getAttribute("Id") ?? element.getAttribute("ID") ?? element.getAttribute("id");
}

export function findXmlElementById(doc: Document, id: string): Element | null {
  const nodes = doc.getElementsByTagName("*");
  for (let index = 0; index < nodes.length; index += 1) {
    const candidate = nodes[index];
    if (!candidate) continue;
    const candidateId = getElementIdValue(candidate);
    if (candidateId === id) {
      return candidate;
    }
  }
  return null;
}

function listElementIds(doc: Document): Array<{ localName: string; id: string }> {
  const ids: Array<{ localName: string; id: string }> = [];
  const nodes = doc.getElementsByTagName("*");
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index];
    if (!node) continue;
    const id = getElementIdValue(node);
    if (!id) continue;
    ids.push({
      localName: getElementLocalName(node) ?? node.nodeName,
      id,
    });
  }
  return ids;
}

function listChildElementLocalNames(element: Element | null): string[] {
  if (!element) return [];
  const names: string[] = [];
  for (let index = 0; index < element.childNodes.length; index += 1) {
    const child = element.childNodes[index];
    const localName = getElementLocalName(child);
    if (localName) names.push(localName);
  }
  return names;
}

function sanitizeSkeletonSnippet(xml: string): string {
  return xml
    .replace(/>\s+</g, "><")
    .replace(/<X509Certificate>[\s\S]*?<\/X509Certificate>/g, "<X509Certificate>[REDACTED]</X509Certificate>")
    .slice(0, 800);
}

function validateXadesSkeletonDoc(doc: Document, xmlWithSkeleton: string): void {
  const signatureEl = findXmlElementById(doc, SIGNATURE_ID);
  const signedPropsEl = findXmlElementById(doc, SIGNED_PROPERTIES_ID);
  const ids = listElementIds(doc);
  const signatureChildNames = listChildElementLocalNames(signatureEl);
  const objectEl = findXmlElementById(doc, OBJECT_ID);
  const keyInfoEl = findXmlElementById(doc, KEY_INFO_ID);

  const qualifyingPropsEl = doc.getElementsByTagNameNS(NS_XADES, "QualifyingProperties")[0] ?? null;
  const signedInfoEl = doc.getElementsByTagNameNS(NS_XMLDSIG, "SignedInfo")[0] ?? null;

  const missingParts: string[] = [];
  if (!signatureEl) missingParts.push("Signature");
  if (!signedInfoEl) missingParts.push("SignedInfo");
  if (!keyInfoEl) missingParts.push("KeyInfo");
  if (!objectEl) missingParts.push("Object");
  if (!qualifyingPropsEl) missingParts.push("QualifyingProperties");
  if (!signedPropsEl) missingParts.push("SignedProperties");

  if (missingParts.length > 0) {
    throw new Error(
      `XADES_SKELETON_INVALID: Faltan nodos requeridos (${missingParts.join(", ")}). ` +
        `IDs encontrados: ${ids.map((item) => `${item.localName}#${item.id}`).join(", ") || "ninguno"}. ` +
        `Hijos directos de Signature: ${signatureChildNames.join(", ") || "ninguno"}. ` +
        `Skeleton: ${sanitizeSkeletonSnippet(xmlWithSkeleton)}`
    );
  }
}

// ── Carga de certificado PKCS#12 ──────────────────────────────────────────────

export function loadPkcs12Certificate(buffer: Buffer, password: string): CertificateBundle {
  let p12: forge.pkcs12.Pkcs12Pfx;

  try {
    const binaryStr = buffer.toString("binary");
    const p12Asn1 = forge.asn1.fromDer(binaryStr);
    p12 = forge.pkcs12.pkcs12FromAsn1(p12Asn1, password);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (
      msg.includes("password") ||
      msg.includes("decrypt") ||
      msg.includes("PKCS12") ||
      msg.includes("PKCS#12")
    ) {
      throw new Error(
        "CERTIFICATE_PASSWORD_INVALID: No se pudo abrir el certificado. " +
          "Verifica que la contraseña sea correcta."
      );
    }
    throw new Error(`Error cargando certificado PKCS#12: ${msg}`);
  }

  // Extract private key
  const keyBags = p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag });
  const keyBag = keyBags[forge.pki.oids.pkcs8ShroudedKeyBag]?.[0];

  if (!keyBag?.key) {
    throw new Error(
      "El archivo PKCS#12 no contiene una clave privada válida. " +
        "Verifica que el archivo es un certificado de firma."
    );
  }

  const privateKeyPem = forge.pki.privateKeyToPem(keyBag.key as forge.pki.rsa.PrivateKey);

  // Extract certificate
  const certBags = p12.getBags({ bagType: forge.pki.oids.certBag });
  const certBag = certBags[forge.pki.oids.certBag]?.[0];

  if (!certBag?.cert) {
    throw new Error(
      "El archivo PKCS#12 no contiene un certificado válido. " +
        "Verifica que el archivo incluye el certificado público."
    );
  }

  const cert = certBag.cert;

  // Get cert DER bytes
  const certAsn1 = forge.pki.certificateToAsn1(cert);
  const certDerBytes = forge.asn1.toDer(certAsn1).getBytes();
  const certDerBuffer = Buffer.from(certDerBytes, "binary");
  const certDerBase64 = certDerBuffer.toString("base64");
  const certPem = forge.pki.certificateToPem(cert);

  // Fingerprint (SHA256 of DER)
  const certSha256FingerprintHex = sha256hex(certDerBuffer);

  // Serial number — hex to decimal
  const serialHex = cert.serialNumber.replace(/^0+/, "") || "0";
  const serialNumber = BigInt("0x" + serialHex).toString(10);

  // Issuer and subject as DN strings
  const issuerName = buildDnString(cert.issuer.attributes);
  const subjectName = buildDnString(cert.subject.attributes);

  // Validity dates
  const notBefore = cert.validity.notBefore;
  const notAfter = cert.validity.notAfter;

  return {
    privateKeyPem,
    certPem,
    certDerBase64,
    certSha256FingerprintHex,
    issuerName,
    serialNumber,
    subjectName,
    notBefore,
    notAfter,
  };
}

// ── Validación de fingerprint ─────────────────────────────────────────────────

export function validateCertificateFingerprint(
  bundle: CertificateBundle,
  expectedFingerprintHex: string
): void {
  const normalized = expectedFingerprintHex.trim().toLowerCase().replace(/:/g, "");
  const actual = bundle.certSha256FingerprintHex.toLowerCase();

  if (actual !== normalized) {
    throw new Error(
      `CERTIFICATE_FINGERPRINT_MISMATCH: El fingerprint SHA-256 del certificado no coincide. ` +
        `Esperado: ${normalized}. ` +
        `Actual: ${actual}. ` +
        `Verifica que se subió el certificado correcto para este tenant.`
    );
  }
}

// ── Construcción del XML firmado XAdES-BES ─────────────────────────────────────

function buildQualifyingPropertiesXml(params: {
  signingTime: string;
  certDigestBase64: string;
  issuerName: string;
  serialNumber: string;
}): string {
  const { signingTime, certDigestBase64, issuerName, serialNumber } = params;

  return (
    `<etsi:QualifyingProperties xmlns:etsi="${NS_XADES}" Target="#${SIGNATURE_ID}">` +
    `<etsi:SignedProperties Id="${SIGNED_PROPERTIES_ID}">` +
    `<etsi:SignedSignatureProperties>` +
    `<etsi:SigningTime>${signingTime}</etsi:SigningTime>` +
    `<etsi:SigningCertificate>` +
    `<etsi:Cert>` +
    `<etsi:CertDigest>` +
    `<ds:DigestMethod xmlns:ds="${NS_XMLDSIG}" Algorithm="${ALG_SHA256}"/>` +
    `<ds:DigestValue xmlns:ds="${NS_XMLDSIG}">${certDigestBase64}</ds:DigestValue>` +
    `</etsi:CertDigest>` +
    `<etsi:IssuerSerial>` +
    `<ds:X509IssuerName xmlns:ds="${NS_XMLDSIG}">${issuerName}</ds:X509IssuerName>` +
    `<ds:X509SerialNumber xmlns:ds="${NS_XMLDSIG}">${serialNumber}</ds:X509SerialNumber>` +
    `</etsi:IssuerSerial>` +
    `</etsi:Cert>` +
    `</etsi:SigningCertificate>` +
    `</etsi:SignedSignatureProperties>` +
    `</etsi:SignedProperties>` +
    `</etsi:QualifyingProperties>`
  );
}

function buildSignatureSkeletonXml(qualifyingPropsXml: string): string {
  return (
    `<Signature xmlns="${NS_XMLDSIG}" Id="${SIGNATURE_ID}">` +
    `<SignedInfo Id="${SIGNED_INFO_ID}">` +
    `<CanonicalizationMethod Algorithm="${ALG_C14N}"/>` +
    `<SignatureMethod Algorithm="${ALG_RSA_SHA256}"/>` +
    `<Reference URI="#comprobante">` +
    `<Transforms><Transform Algorithm="${ALG_ENVELOPED}"/></Transforms>` +
    `<DigestMethod Algorithm="${ALG_SHA256}"/>` +
    `<DigestValue></DigestValue>` +
    `</Reference>` +
    `<Reference URI="${SIGNED_PROPERTIES_REF_URI}" Type="${TYPE_SIGNED_PROPS}">` +
    `<DigestMethod Algorithm="${ALG_SHA256}"/>` +
    `<DigestValue></DigestValue>` +
    `</Reference>` +
    `</SignedInfo>` +
    `<SignatureValue></SignatureValue>` +
    `<KeyInfo Id="${KEY_INFO_ID}"></KeyInfo>` +
    `<Object Id="${OBJECT_ID}">${qualifyingPropsXml}</Object>` +
    `</Signature>`
  );
}

function buildSignedInfoXml(docDigestBase64: string, signedPropsDigestBase64: string): string {
  return (
    `<SignedInfo xmlns="${NS_XMLDSIG}">` +
    `<CanonicalizationMethod Algorithm="${ALG_C14N}"/>` +
    `<SignatureMethod Algorithm="${ALG_RSA_SHA256}"/>` +
    `<Reference Id="comprobante-ref0" URI="#comprobante">` +
    `<Transforms>` +
    `<Transform Algorithm="${ALG_ENVELOPED}"/>` +
    `</Transforms>` +
    `<DigestMethod Algorithm="${ALG_SHA256}"/>` +
    `<DigestValue>${docDigestBase64}</DigestValue>` +
    `</Reference>` +
    `<Reference URI="${SIGNED_PROPERTIES_REF_URI}" Type="${TYPE_SIGNED_PROPS}">` +
    `<DigestMethod Algorithm="${ALG_SHA256}"/>` +
    `<DigestValue>${signedPropsDigestBase64}</DigestValue>` +
    `</Reference>` +
    `</SignedInfo>`
  );
}

function buildFinalSignatureXml(params: {
  signedInfoXml: string;
  signatureValueBase64: string;
  certDerBase64: string;
  qualifyingPropsXml: string;
}): string {
  const { signedInfoXml, signatureValueBase64, certDerBase64, qualifyingPropsXml } = params;

  return (
    `<Signature xmlns="${NS_XMLDSIG}" Id="${SIGNATURE_ID}">` +
    signedInfoXml.replace(` xmlns="${NS_XMLDSIG}"`, "") + // xmlns already on parent
    `<SignatureValue>${signatureValueBase64}</SignatureValue>` +
    `<KeyInfo Id="${KEY_INFO_ID}">` +
    `<X509Data>` +
    `<X509Certificate>${certDerBase64}</X509Certificate>` +
    `</X509Data>` +
    `</KeyInfo>` +
    `<Object Id="${OBJECT_ID}">${qualifyingPropsXml}</Object>` +
    `</Signature>`
  );
}

// ── Firma principal ───────────────────────────────────────────────────────────

export function signXmlWithTenantCertificate(
  unsignedXml: string,
  bundle: CertificateBundle
): SigningResult {
  const warnings: string[] = [];

  // Step 1: Prepare inputs
  const certDigestBase64 = sha256b64(Buffer.from(bundle.certDerBase64, "base64"));
  const signingTime = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

  // Step 2: Build QualifyingProperties XML (exact string — used in two places)
  const qualifyingPropsXml = buildQualifyingPropertiesXml({
    signingTime,
    certDigestBase64,
    issuerName: bundle.issuerName,
    serialNumber: bundle.serialNumber,
  });

  // Step 3: Compute canonical form of SignedProperties in its document context.
  // We embed the Signature skeleton in the factura to get correct ancestor namespaces.
  const skeletonSig = buildSignatureSkeletonXml(qualifyingPropsXml);

  // Insert skeleton before the closing tag of the root element
  const closingTag = `</${getRootTagName(unsignedXml)}>`;
  const xmlWithSkeleton = unsignedXml.trimEnd().replace(
    new RegExp(`${closingTag}\\s*$`),
    skeletonSig + closingTag
  );

  const fullDoc = parseXmlDoc(xmlWithSkeleton);
  validateXadesSkeletonDoc(fullDoc, xmlWithSkeleton);

  // Find the SignedProperties element by Id using XML-safe lookup.
  const signedPropsEl = findXmlElementById(fullDoc, SIGNED_PROPERTIES_ID);
  if (!signedPropsEl) {
    throw new Error(
      "No se encontró el elemento Signature-SignedProperties en el documento con skeleton. " +
        `IDs encontrados: ${listElementIds(fullDoc).map((item) => `${item.localName}#${item.id}`).join(", ") || "ninguno"}.`
    );
  }

  // Get ancestor namespace declarations for correct C14N
  const ancestorNs = findAncestorNs(fullDoc, SIGNED_PROPERTIES_REF_XPATH);

  const c14nSignedProps = c14nNode(
    signedPropsEl as unknown as Node,
    ancestorNs
  );
  const signedPropsDigestBase64 = sha256b64(Buffer.from(c14nSignedProps, "utf8"));

  // Step 4: Compute canonical form of the document reference (#comprobante)
  // Use the UNSIGNED document — no Signature element present
  const unsignedDoc = parseXmlDoc(unsignedXml);
  const facturaEl = unsignedDoc.documentElement;

  if (!facturaEl) {
    throw new Error("El documento XML no tiene un elemento raíz.");
  }

  const c14nFactura = c14nNode(facturaEl as unknown as Node, []);
  const docDigestBase64 = sha256b64(Buffer.from(c14nFactura, "utf8"));

  // Step 5: Build SignedInfo and compute its canonical form
  const signedInfoXml = buildSignedInfoXml(docDigestBase64, signedPropsDigestBase64);
  const signedInfoDoc = parseXmlDoc(signedInfoXml);
  const signedInfoEl = signedInfoDoc.documentElement;

  if (!signedInfoEl) {
    throw new Error("No se pudo parsear el SignedInfo XML.");
  }

  const c14nSignedInfo = c14nNode(signedInfoEl as unknown as Node, []);

  // Step 6: Sign with RSA-SHA256
  let signatureValueBase64: string;
  try {
    const sign = crypto.createSign("RSA-SHA256");
    sign.update(Buffer.from(c14nSignedInfo, "utf8"));
    signatureValueBase64 = sign.sign(bundle.privateKeyPem, "base64");
  } catch (err) {
    throw new Error(
      `Error al firmar con RSA-SHA256: ${err instanceof Error ? err.message : String(err)}. ` +
        `Verifica que la clave privada es RSA y está en formato PEM.`
    );
  }

  // Step 7: Assemble the final Signature element
  const finalSignatureXml = buildFinalSignatureXml({
    signedInfoXml,
    signatureValueBase64,
    certDerBase64: bundle.certDerBase64,
    qualifyingPropsXml,
  });

  // Step 8: Insert Signature inside the root element (before closing tag)
  const signedXml = unsignedXml
    .trimEnd()
    .replace(new RegExp(`${closingTag}\\s*$`), finalSignatureXml + closingTag);

  // Step 9: Final hash
  const signedXmlHash = sha256hex(Buffer.from(signedXml, "utf8"));

  return {
    signedXml,
    signedXmlHash,
    certificateFingerprint: bundle.certSha256FingerprintHex,
    warnings,
  };
}

// ── Validación básica del XML firmado ─────────────────────────────────────────

export function validateSignedXmlBasic(signedXml: string): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  if (!signedXml.includes(`<Signature xmlns="${NS_XMLDSIG}"`)) {
    errors.push("No se encontró el elemento <Signature> con namespace XMLDSig.");
  }

  if (!signedXml.includes("<SignatureValue>")) {
    errors.push("No se encontró <SignatureValue>.");
  }

  if (!signedXml.includes("<X509Certificate>")) {
    errors.push("No se encontró <X509Certificate> en KeyInfo.");
  }

  if (!signedXml.includes("Signature-SignedProperties")) {
    errors.push("No se encontró el elemento XAdES SignedProperties.");
  }

  if (!signedXml.includes(`URI="${SIGNED_PROPERTIES_REF_URI}"`)) {
    errors.push("No se encontró la referencia URI del SignedProperties.");
  }

  if (!signedXml.includes("<etsi:SigningTime>")) {
    errors.push("No se encontró <etsi:SigningTime> en QualifyingProperties.");
  }

  try {
    const doc = parseXmlDoc(signedXml);
    if (!doc.documentElement) {
      errors.push("El XML firmado no tiene elemento raíz.");
    }
  } catch (err) {
    errors.push(`El XML firmado no es parseable: ${err instanceof Error ? err.message : String(err)}`);
  }

  return { valid: errors.length === 0, errors };
}

// ── Helpers internos ──────────────────────────────────────────────────────────

function getRootTagName(xml: string): string {
  // Extract the tag name from the root element opening tag
  const match = xml.match(/<([a-zA-Z][a-zA-Z0-9_:-]*)[^>]*>/);
  if (!match || !match[1]) {
    throw new Error("No se pudo determinar el tag raíz del XML.");
  }
  // Escape for use in regex
  return match[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function calculateSha256(content: Buffer | string): string {
  return sha256hex(content);
}

export function debugValidateXadesSkeleton(unsignedXml: string): {
  foundSignedProperties: boolean;
  foundReferenceUri: boolean;
  foundIds: Array<{ localName: string; id: string }>;
} {
  const qualifyingPropsXml = buildQualifyingPropertiesXml({
    signingTime: "2026-06-01T00:00:00Z",
    certDigestBase64: Buffer.from("dummy-cert-digest").toString("base64"),
    issuerName: "CN=Dummy Issuer",
    serialNumber: "123456789",
  });

  const skeletonSig = buildSignatureSkeletonXml(qualifyingPropsXml);
  const closingTag = `</${getRootTagName(unsignedXml)}>`;
  const xmlWithSkeleton = unsignedXml.trimEnd().replace(
    new RegExp(`${closingTag}\\s*$`),
    skeletonSig + closingTag
  );
  const doc = parseXmlDoc(xmlWithSkeleton);
  validateXadesSkeletonDoc(doc, xmlWithSkeleton);

  return {
    foundSignedProperties: Boolean(findXmlElementById(doc, SIGNED_PROPERTIES_ID)),
    foundReferenceUri: xmlWithSkeleton.includes(`URI="${SIGNED_PROPERTIES_REF_URI}"`),
    foundIds: listElementIds(doc),
  };
}
