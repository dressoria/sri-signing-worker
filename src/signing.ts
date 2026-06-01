import { query } from "./db";
import {
  claimNextSigningJob,
  markJobFailed,
  markJobSucceededDryRun,
  SigningJob,
} from "./jobs";
import {
  buildAccessKey,
  buildDisplayNumber,
  buildPreliminaryXml,
  SriDocumentData,
  SriDocumentLineData,
  SriEstablishmentData,
  SriIssuePointData,
  SriProfileData,
} from "./sri-xml";
import { getConfig } from "./config";
import { logger } from "./logger";
import crypto from "crypto";

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
  environment: "TEST" | "PRODUCTION";
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
              d."customerEmail", d.subtotal, d."taxTotal", d."discountTotal",
              d."grandTotal", d.currency, d."issuedAt", d."createdAt"
       FROM "SriDocument" d
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
      `SELECT ruc, "legalName", "tradeName", environment
       FROM "SriTaxpayerProfile"
       WHERE "tenantId" = $1`,
      [job.tenantId]
    ),
    query<SignatureConfigRow>(
      `SELECT "tenantId", status, "certificateFileName"
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

  const profile = profileRows[0];
  if (!profile) throw new Error(`Perfil tributario no encontrado para tenant ${job.tenantId}`);

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
  | { outcome: "claimed"; jobId: string; result: "dry_run_failed" | "dry_run_succeeded" | "error" }
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
    const issuedAt = bundle.doc.issuedAt ?? bundle.doc.createdAt;
    const seqNum = bundle.doc.sequentialNumber ?? 1;

    const accessKey =
      bundle.doc.accessKey ??
      buildAccessKey({
        issuedAt,
        documentType: bundle.doc.documentType,
        ruc: bundle.profile.ruc,
        environment: bundle.doc.environment,
        establishmentCode: bundle.establishment.code,
        issuePointCode: bundle.issuePoint.code,
        sequentialNumber: seqNum,
        documentId: bundle.doc.id,
      });

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

      // Dry-run enabled
      logger.info("Modo dry-run activo. Llegamos hasta el punto de firma.", {
        jobId: job.id,
        dryRunMarkSuccess: config.dryRunMarkSuccess,
      });

      if (config.dryRunMarkSuccess) {
        // Mark SUCCEEDED with dry-run metadata — does NOT touch SriDocument.status
        await markJobSucceededDryRun(job.id, xmlContent);
        logger.info("Job marcado SUCCEEDED (dry-run). SriDocument.status NO cambiado a SIGNED.", {
          jobId: job.id,
        });
        return { outcome: "claimed", jobId: job.id, result: "dry_run_succeeded" };
      } else {
        // Mark controlled fail — this is the safe default
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

    // ENABLE_REAL_SRI_SIGNING=true — not implemented yet (guarded at startup by config.ts)
    throw new Error("REAL_SIGNING_NOT_IMPLEMENTED — este bloque no debería ser alcanzable.");
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
