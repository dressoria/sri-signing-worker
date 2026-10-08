import { query } from "./db";
import {
  claimNextSigningJob,
  markJobFailed,
  markJobSucceededDryRun,
  markJobSucceededReal,
  SigningJob,
} from "./jobs";
import {
  buildDisplayNumber,
  buildPreliminaryXml,
  SriDocumentData,
  SriDocumentLineData,
  SriEstablishmentData,
  SriIssuePointData,
  SriProfileData,
  validateSriInvoiceXmlStructure,
} from "./sri-xml";
import { getConfig } from "./config";
import { logger } from "./logger";
import crypto from "crypto";
import { decryptBuffer, decryptText } from "./encryption";
import { readEncryptedCertificate } from "./certificate-storage";
import {
  loadPkcs12Certificate,
  signXmlWithTenantCertificate,
  validateCertificateFingerprint,
  validateSignedXmlBasic,
} from "./xades-signature";
import { saveSignedXml } from "./signed-xml-storage";
import { createSubmissionJobAfterSigning } from "./sri-submission-jobs";

// ── Tipos de filas DB ─────────────────────────────────────────────────────────

type DocumentRow = {
  id: string;
  tenantId: string;
  documentType: string;
  status: string;
  environment: "TEST" | "PRODUCTION";
  establishmentId: string;
  issuePointId: string;
  sequentialNumber: string | null;
  accessKey: string | null;
  customerName: string;
  customerIdentification: string | null;
  customerEmail: string | null;
  customerPhone: string | null;
  customerAddress: string | null;
  commercialPaymentMethod: string | null;
  sriPaymentCode: string | null;
  subtotal: string;
  taxTotal: string;
  discountTotal: string;
  grandTotal: string;
  currency: string;
  issuedAt: string | null;
  createdAt: string;
};

type LineRow = {
  itemName: string;
  itemCode: string | null;
  quantity: string;
  unitPrice: string;
  discountAmount: string;
  subtotal: string;
  taxRate: string;
  taxAmount: string;
  total: string;
};

type ProfileRow = {
  ruc: string;
  legalName: string;
  tradeName: string | null;
  dirMatriz: string | null;
  environment: "TEST" | "PRODUCTION";
  accountingRequired: boolean;
  taxRegimeCode: string | null;
  contribuyenteRimpe: string | null;
  companyEmail: string | null;
  companyPhone: string | null;
};

type EstablishmentRow = {
  code: string;
  name: string;
  address: string;
};

type IssuePointRow = {
  code: string;
};

type SignatureConfigRow = {
  tenantId: string;
  status: string;
  certificateFileName: string | null;
  encryptedCertificateStorageKey: string | null;
  encryptedCertificatePassword: string | null;
  fingerprintSha256: string | null;
  encryptionKeyVersion: string | null;
};

// ── Carga de datos completa ───────────────────────────────────────────────────

type DocumentBundle = {
  doc: SriDocumentData;
  profile: SriProfileData;
  establishment: SriEstablishmentData;
  issuePoint: SriIssuePointData;
  lines: SriDocumentLineData[];
  signatureConfig: SignatureConfigRow | null;
};

async function loadDocumentBundle(job: SigningJob): Promise<DocumentBundle> {
  const [docRows, lineRows, profileRows, sigConfigRows] = await Promise.all([
    query<DocumentRow>(
      `SELECT d.*, d."tenantId", d."documentType", d.status, d.environment,
              d."establishmentId", d."issuePointId", d."sequentialNumber",
              d."accessKey", d."customerName", d."customerIdentification",
              d."customerEmail", d."customerPhone", d."sriPaymentCode",
              c.address AS "customerAddress", p.method AS "commercialPaymentMethod",
              d.subtotal, d."taxTotal", d."discountTotal",
              d."grandTotal", d.currency, d."issuedAt", d."createdAt"
       FROM "SriDocument" d
       LEFT JOIN "LightweightSale" s
         ON d."sourceType" = 'BASIC_SALE' AND s.id = d."sourceId" AND s."tenantId" = d."tenantId"
       LEFT JOIN "LightweightCustomer" c ON c.id = s."customerId" AND c."tenantId" = d."tenantId"
       LEFT JOIN LATERAL (
         SELECT method FROM "LightweightPayment"
         WHERE "saleId" = s.id ORDER BY "createdAt" ASC LIMIT 1
       ) p ON true
       WHERE d.id = $1`,
      [job.documentId]
    ),
    query<LineRow>(
      `SELECT "itemName", "itemCode", quantity, "unitPrice", "discountAmount",
              subtotal, "taxRate", "taxAmount", total
       FROM "SriDocumentLine"
       WHERE "documentId" = $1
       ORDER BY "createdAt" ASC`,
      [job.documentId]
    ),
    query<ProfileRow>(
      `SELECT p.ruc, p."legalName", p."tradeName", p."dirMatriz", p.environment,
              p."accountingRequired", p."taxRegimeCode", p."contribuyenteRimpe",
              t."contactEmail" AS "companyEmail", t.phone AS "companyPhone"
       FROM "SriTaxpayerProfile" p
       JOIN "Tenant" t ON t.id = p."tenantId"
       WHERE p."tenantId" = $1`,
      [job.tenantId]
    ),
    query<SignatureConfigRow>(
      `SELECT "tenantId", status, "certificateFileName",
              "encryptedCertificateStorageKey", "encryptedCertificatePassword",
              "fingerprintSha256", "encryptionKeyVersion"
       FROM "SriSignatureConfig"
       WHERE "tenantId" = $1`,
      [job.tenantId]
    ),
  ]);

  const docRow = docRows[0];
  if (!docRow) throw new Error(`Documento no encontrado: ${job.documentId}`);

  // Critical: validate no cross-tenant
  if (docRow.tenantId !== job.tenantId) {
    throw new Error(
      `CROSS-TENANT DETECTADO — job.tenantId=${job.tenantId} doc.tenantId=${docRow.tenantId}`
    );
  }

  if (docRow.status !== "READY_FOR_TESTING") {
    throw new Error(
      `El documento debe estar READY_FOR_TESTING. Estado actual: ${docRow.status}`
    );
  }

  const profileRow = profileRows[0];
  if (!profileRow) throw new Error(`Perfil tributario no encontrado para tenant ${job.tenantId}`);

  const profile: SriProfileData = {
    ruc: profileRow.ruc,
    legalName: profileRow.legalName,
    tradeName: profileRow.tradeName,
    dirMatriz: profileRow.dirMatriz,
    environment: profileRow.environment,
    accountingRequired: profileRow.accountingRequired ?? false,
    taxRegimeCode: profileRow.taxRegimeCode,
    contribuyenteRimpe: profileRow.contribuyenteRimpe,
    companyEmail: profileRow.companyEmail,
    companyPhone: profileRow.companyPhone,
  };

  // Load establishment and issue point
  const [estabRows, issueRows] = await Promise.all([
    query<EstablishmentRow>(
      `SELECT code, name, address FROM "SriEstablishment" WHERE id = $1`,
      [docRow.establishmentId]
    ),
    query<IssuePointRow>(
      `SELECT code FROM "SriIssuePoint" WHERE id = $1`,
      [docRow.issuePointId]
    ),
  ]);

  const establishment = estabRows[0];
  if (!establishment)
    throw new Error(`Establecimiento no encontrado: ${docRow.establishmentId}`);

  const issuePoint = issueRows[0];
  if (!issuePoint) throw new Error(`Punto de emisión no encontrado: ${docRow.issuePointId}`);

  const doc: SriDocumentData = {
    id: docRow.id,
    documentType: docRow.documentType,
    environment: docRow.environment,
    sequentialNumber: docRow.sequentialNumber ? Number(docRow.sequentialNumber) : null,
    accessKey: docRow.accessKey,
    customerName: docRow.customerName,
    customerIdentification: docRow.customerIdentification,
    customerEmail: docRow.customerEmail,
    customerPhone: docRow.customerPhone,
    customerAddress: docRow.customerAddress,
    commercialPaymentMethod: docRow.commercialPaymentMethod,
    sriPaymentCode: docRow.sriPaymentCode,
    subtotal: docRow.subtotal,
    taxTotal: docRow.taxTotal,
    discountTotal: docRow.discountTotal,
    grandTotal: docRow.grandTotal,
    currency: docRow.currency,
    issuedAt: docRow.issuedAt ? new Date(docRow.issuedAt) : null,
    createdAt: new Date(docRow.createdAt),
  };

  const lines: SriDocumentLineData[] = lineRows.map((l) => ({
    itemName: l.itemName,
    itemCode: l.itemCode,
    quantity: l.quantity,
    unitPrice: l.unitPrice,
    discountAmount: l.discountAmount,
    subtotal: l.subtotal,
    taxRate: l.taxRate,
    taxAmount: l.taxAmount,
    total: l.total,
  }));

  return {
    doc,
    profile,
    establishment,
    issuePoint,
    lines,
    signatureConfig: sigConfigRows[0] ?? null,
  };
}

// ── Procesamiento principal ───────────────────────────────────────────────────

export type ProcessResult =
  | { outcome: "no_job" }
  | {
      outcome: "claimed";
      jobId: string;
      result: "dry_run_failed" | "dry_run_succeeded" | "real_sign_failed" | "real_sign_succeeded" | "error";
    }
  | { outcome: "error"; message: string };

export async function processNextSigningJob(): Promise<ProcessResult> {
  const config = getConfig();

  logger.info("Reclamando próximo job QUEUED...");
  const job = await claimNextSigningJob(config.workerId);

  if (!job) {
    logger.info("No hay jobs QUEUED disponibles.");
    return { outcome: "no_job" };
  }

  logger.info("Job reclamado", {
    jobId: job.id,
    tenantId: job.tenantId,
    documentId: job.documentId,
    attempts: job.attempts,
  });

  try {
    // Load document bundle with full cross-tenant validation
    const bundle = await loadDocumentBundle(job);

    // Validate signature config
    if (!bundle.signatureConfig || !bundle.signatureConfig.certificateFileName) {
      await markJobFailed(
        job.id,
        "NO_SIGNATURE_CONFIG",
        "Firma electrónica no configurada para este tenant. Ve a SRI → Firma electrónica."
      );
      logger.warn("Job fallado: sin configuración de firma", { jobId: job.id });
      return { outcome: "claimed", jobId: job.id, result: "dry_run_failed" };
    }

    // Build XML
    if (bundle.doc.sequentialNumber == null || !bundle.doc.accessKey) {
      await markJobFailed(
        job.id,
        "MISSING_PERSISTED_NUMBERING",
        "El comprobante no tiene sequentialNumber/accessKey persistidos. Reserva y guarda la numeracion en el dashboard antes de firmar."
      );
      logger.warn("Job fallado: numeracion persistida faltante", {
        jobId: job.id,
        documentId: job.documentId,
        sequentialNumber: bundle.doc.sequentialNumber,
        hasAccessKey: Boolean(bundle.doc.accessKey),
      });
      return { outcome: "claimed", jobId: job.id, result: "dry_run_failed" };
    }

    const seqNum = bundle.doc.sequentialNumber;
    const accessKey = bundle.doc.accessKey;

    const displayNumber = buildDisplayNumber(
      bundle.establishment.code,
      bundle.issuePoint.code,
      seqNum
    );

    const xmlContent = buildPreliminaryXml({
      doc: bundle.doc,
      profile: bundle.profile,
      establishment: bundle.establishment,
      issuePoint: bundle.issuePoint,
      lines: bundle.lines,
      accessKey,
      displayNumber,
    });

    const structuralErrors = validateSriInvoiceXmlStructure(
      xmlContent,
      bundle.profile.taxRegimeCode
    );
    if (structuralErrors.length) {
      await markJobFailed(
        job.id,
        "SRI_XML_STRUCTURE_INVALID",
        `XML SRI inválido: ${structuralErrors.join(" ")}`,
        false
      );
      logger.error("Job fallado: XML SRI estructuralmente inválido.", {
        jobId: job.id,
        structuralErrors,
      });
      return { outcome: "claimed", jobId: job.id, result: "real_sign_failed" };
    }

    const unsignedXmlHash = crypto
      .createHash("sha256")
      .update(xmlContent)
      .digest("hex");

    logger.info("XML preliminar generado", {
      jobId: job.id,
      documentId: job.documentId,
      displayNumber,
      accessKey: accessKey.slice(0, 12) + "...",
      xmlLength: xmlContent.length,
      unsignedXmlHash,
    });

    // ── Punto de firma ────────────────────────────────────────────────────────

    if (!config.enableRealSriSigning) {
      logger.info("ENABLE_REAL_SRI_SIGNING=false — firma real no habilitada.");

      if (!config.enableDryRun) {
        await markJobFailed(
          job.id,
          "REAL_SIGNING_DISABLED",
          "Firma real deshabilitada y dry-run no habilitado. " +
            "Activa ENABLE_SRI_SIGNING_DRY_RUN para procesar en modo prueba."
        );
        logger.warn("Job fallado: firma y dry-run deshabilitados.", { jobId: job.id });
        return { outcome: "claimed", jobId: job.id, result: "dry_run_failed" };
      }

      logger.info("Modo dry-run activo. Llegamos hasta el punto de firma.", {
        jobId: job.id,
        dryRunMarkSuccess: config.dryRunMarkSuccess,
      });

      if (config.dryRunMarkSuccess) {
        await markJobSucceededDryRun(job.id, xmlContent);
        logger.info("Job marcado SUCCEEDED (dry-run). SriDocument.status NO cambiado a SIGNED.", {
          jobId: job.id,
        });
        return { outcome: "claimed", jobId: job.id, result: "dry_run_succeeded" };
      } else {
        await markJobFailed(
          job.id,
          "REAL_SIGNING_DISABLED",
          "Firma XAdES-BES real no habilitada en este entorno. " +
            "El worker llegó hasta el punto de firma pero no puede continuar sin certificado real. " +
            "Esto es el comportamiento esperado en la fase de prueba de arquitectura."
        );
        logger.info("Job marcado FAILED controlado (REAL_SIGNING_DISABLED). Comportamiento esperado.", {
          jobId: job.id,
        });
        return { outcome: "claimed", jobId: job.id, result: "dry_run_failed" };
      }
    }

    // ── Firma XAdES-BES real ───────────────────────────────────────────────────
    // ENABLE_REAL_SRI_SIGNING=true
    // Requires: SRI_CERT_ENCRYPTION_KEY, SRI_CERT_STORAGE_PATH, valid signature config

    logger.info("ENABLE_REAL_SRI_SIGNING=true — iniciando firma XAdES-BES real.", {
      jobId: job.id,
      tenantId: job.tenantId,
    });

    const sigConfig = bundle.signatureConfig;
    if (
      !sigConfig ||
      !sigConfig.encryptedCertificateStorageKey ||
      !sigConfig.encryptedCertificatePassword
    ) {
      await markJobFailed(
        job.id,
        "NO_SIGNATURE_CONFIG",
        "Configuración de firma incompleta: faltan encryptedCertificateStorageKey o " +
          "encryptedCertificatePassword. Ve a SRI → Firma electrónica."
      );
      return { outcome: "claimed", jobId: job.id, result: "real_sign_failed" };
    }

    // Validate encryption key is available
    const encKey = config.certEncryptionKey!;
    const certStoragePath = config.certStoragePath!;
    const signedXmlStoragePath = config.signedXmlStoragePath!;

    // Decrypt certificate password (never log it)
    let certPassword: string;
    try {
      certPassword = decryptText(sigConfig.encryptedCertificatePassword, encKey);
    } catch (err) {
      await markJobFailed(
        job.id,
        "CERT_PASSWORD_DECRYPT_ERROR",
        `No se pudo descifrar la contraseña del certificado: ${err instanceof Error ? err.message : String(err)}`
      );
      return { outcome: "claimed", jobId: job.id, result: "real_sign_failed" };
    }

    // Read and decrypt certificate file
    let p12Buffer: Buffer;
    try {
      const encryptedCertBuffer = readEncryptedCertificate(
        certStoragePath,
        sigConfig.encryptedCertificateStorageKey
      );
      p12Buffer = decryptBuffer(
        encryptedCertBuffer.toString("utf8"),
        encKey
      );
    } catch (err) {
      certPassword = ""; // clear before logging anything
      await markJobFailed(
        job.id,
        "CERT_READ_ERROR",
        `No se pudo leer o descifrar el certificado: ${err instanceof Error ? err.message : String(err)}`
      );
      return { outcome: "claimed", jobId: job.id, result: "real_sign_failed" };
    }

    // Load PKCS#12 and validate
    let certBundle;
    try {
      certBundle = loadPkcs12Certificate(p12Buffer, certPassword);
    } catch (err) {
      certPassword = ""; // clear
      const msg = err instanceof Error ? err.message : String(err);
      const errorCode = msg.startsWith("CERTIFICATE_PASSWORD_INVALID")
        ? "CERTIFICATE_PASSWORD_INVALID"
        : "CERTIFICATE_LOAD_ERROR";
      await markJobFailed(job.id, errorCode, msg);
      return { outcome: "claimed", jobId: job.id, result: "real_sign_failed" };
    }
    certPassword = ""; // clear as soon as certificate is loaded

    // Check certificate expiry
    const now = new Date();
    if (now > certBundle.notAfter) {
      await markJobFailed(
        job.id,
        "CERTIFICATE_EXPIRED",
        `El certificado de firma expiró el ${certBundle.notAfter.toISOString()}. ` +
          `Renueva el certificado en SRI → Firma electrónica.`
      );
      return { outcome: "claimed", jobId: job.id, result: "real_sign_failed" };
    }

    // Validate fingerprint if available
    if (sigConfig.fingerprintSha256) {
      try {
        validateCertificateFingerprint(certBundle, sigConfig.fingerprintSha256);
      } catch (err) {
        await markJobFailed(
          job.id,
          "CERTIFICATE_FINGERPRINT_MISMATCH",
          err instanceof Error ? err.message : String(err)
        );
        return { outcome: "claimed", jobId: job.id, result: "real_sign_failed" };
      }
    }

    // Validate RUC match (best-effort — warn only)
    const subjectRuc = certBundle.subjectName.match(/SERIALNUMBER=(\d{13})/)?.[1];
    if (subjectRuc && subjectRuc !== bundle.profile.ruc) {
      logger.warn(
        "El RUC en el certificado no coincide con el RUC del perfil tributario. " +
          "Verifica que el certificado pertenece a este tenant.",
        {
          jobId: job.id,
          tenantId: job.tenantId,
          certRucPartial: subjectRuc.slice(0, 4) + "...",
          profileRucPartial: bundle.profile.ruc.slice(0, 4) + "...",
        }
      );
    }

    logger.info("Certificado cargado y validado. Iniciando firma XAdES-BES.", {
      jobId: job.id,
      certSubject: certBundle.subjectName,
      certNotAfter: certBundle.notAfter.toISOString(),
      certFingerprintPartial: certBundle.certSha256FingerprintHex.slice(0, 12) + "...",
    });

    // Sign the XML
    let signingResult;
    try {
      signingResult = signXmlWithTenantCertificate(xmlContent, certBundle);
    } catch (err) {
      await markJobFailed(
        job.id,
        "XADES_SIGNING_FAILED",
        `Error en la firma XAdES-BES: ${err instanceof Error ? err.message : String(err)}`
      );
      return { outcome: "claimed", jobId: job.id, result: "real_sign_failed" };
    }

    // Log warnings if any (never log the XML content itself)
    for (const w of signingResult.warnings) {
      logger.warn("Advertencia en firma XAdES-BES", { jobId: job.id, warning: w });
    }

    // Basic structural validation
    const validation = validateSignedXmlBasic(signingResult.signedXml);
    if (!validation.valid) {
      await markJobFailed(
        job.id,
        "SIGNED_XML_INVALID",
        `El XML firmado no pasó la validación básica de estructura: ${validation.errors.join("; ")}`
      );
      return { outcome: "claimed", jobId: job.id, result: "real_sign_failed" };
    }

    // Save signed XML to storage
    let savedXml;
    try {
      savedXml = saveSignedXml(
        signedXmlStoragePath,
        job.tenantId,
        job.documentId,
        signingResult.signedXml
      );
    } catch (err) {
      await markJobFailed(
        job.id,
        "SIGNED_XML_STORAGE_ERROR",
        `No se pudo guardar el XML firmado: ${err instanceof Error ? err.message : String(err)}`
      );
      return { outcome: "claimed", jobId: job.id, result: "real_sign_failed" };
    }

    // Mark job SUCCEEDED and SriDocument.status = SIGNED
    await markJobSucceededReal(job.id, {
      signedXmlStorageKey: savedXml.storageKey,
      signedXmlHash: signingResult.signedXmlHash,
      unsignedXmlHash,
    });

    logger.info("Job completado. XML firmado guardado. SriDocument.status actualizado a SIGNED.", {
      jobId: job.id,
      documentId: job.documentId,
      storageKey: savedXml.storageKey,
      signedXmlHashPartial: signingResult.signedXmlHash.slice(0, 12) + "...",
      byteLength: savedXml.byteLength,
    });

    // Auto-crear submission job (best-effort — no bloquea si falla)
    try {
      await createSubmissionJobAfterSigning({
        tenantId: job.tenantId,
        documentId: job.documentId,
        environment: bundle.doc.environment,
        sriAccessKey: bundle.doc.accessKey,
      });
    } catch (submitErr) {
      logger.warn("No se pudo crear submission job automaticamente. Se puede crear manualmente desde el dashboard.", {
        jobId: job.id,
        documentId: job.documentId,
        error: submitErr instanceof Error ? submitErr.message : String(submitErr),
      });
    }

    return { outcome: "claimed", jobId: job.id, result: "real_sign_succeeded" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("Error al procesar job", { jobId: job.id, message });

    try {
      await markJobFailed(job.id, "PROCESSING_ERROR", message);
    } catch (markErr) {
      logger.error("No se pudo marcar el job como fallado", {
        jobId: job.id,
        message: markErr instanceof Error ? markErr.message : String(markErr),
      });
    }

    return { outcome: "claimed", jobId: job.id, result: "error" };
  }
}
