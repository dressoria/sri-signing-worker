import { query } from "./db";
import { getConfig } from "./config";
import { logger } from "./logger";
import { readSignedXml } from "./signed-xml-storage";
import { saveAuthorizedXml } from "./authorized-xml-storage";
import {
  claimNextSubmissionJob,
  markSubmissionAuthorized,
  markSubmissionFailed,
  markSubmissionReceived,
  markSubmissionRejected,
  SubmissionJob,
} from "./sri-submission-jobs";
import {
  querySRIAuthorization,
  sendSignedXmlToSRIReception,
  summarizeAuthorizationForStorage,
  summarizeReceptionForStorage,
} from "./sri-webservice";

type SRIStatusMessage = {
  mensaje: string;
  informacionAdicional?: string;
  identificador?: string;
};

type SignedDocumentRow = {
  id: string;
  tenantId: string;
  status: string;
  accessKey: string | null;
  environment: "TEST" | "PRODUCTION";
  latestSignedXmlStorageKey: string | null;
  latestSignedXmlHash: string | null;
};

function extractAccessKeyFromXml(xml: string): string | null {
  const match = xml.match(/<claveAcceso>([^<]+)<\/claveAcceso>/i);
  return match?.[1]?.trim() ?? null;
}

function ensureSignedXmlLooksSigned(xml: string): void {
  if (!/<(?:\w+:)?Signature\b/i.test(xml)) {
    throw new Error("SIGNED_XML_INVALID: El XML firmado no contiene un nodo Signature.");
  }
}

async function loadSignedDocument(job: SubmissionJob): Promise<SignedDocumentRow> {
  const rows = await query<SignedDocumentRow>(
    `SELECT d.id, d."tenantId", d.status, d."accessKey", d.environment,
            sj."signedXmlStorageKey" AS "latestSignedXmlStorageKey",
            sj."signedXmlHash" AS "latestSignedXmlHash"
     FROM "SriDocument" d
     LEFT JOIN LATERAL (
       SELECT "signedXmlStorageKey", "signedXmlHash"
       FROM "SriSigningJob"
       WHERE "documentId" = d.id AND status = 'SUCCEEDED'
       ORDER BY "createdAt" DESC
       LIMIT 1
     ) sj ON true
     WHERE d.id = $1`,
    [job.documentId]
  );

  const doc = rows[0];
  if (!doc) throw new Error(`Documento no encontrado: ${job.documentId}`);
  if (doc.tenantId !== job.tenantId) {
    throw new Error(`CROSS-TENANT DETECTADO — job.tenantId=${job.tenantId} doc.tenantId=${doc.tenantId}`);
  }

  if (!["SIGNED", "SENT", "AUTHORIZED", "REJECTED"].includes(doc.status)) {
    throw new Error(`El documento no esta listo para envio SRI. Estado actual: ${doc.status}`);
  }

  if (!doc.latestSignedXmlStorageKey) {
    throw new Error("SIGNED_XML_NOT_FOUND: No se encontro signedXmlStorageKey para este documento.");
  }

  return doc;
}

function summarizeMessages(
  messages: SRIStatusMessage[]
): string {
  return messages
    .map((message) =>
      [message.identificador ? `#${message.identificador}` : null, message.mensaje, message.informacionAdicional]
        .filter(Boolean)
        .join(" - ")
    )
    .join("; ");
}

function normalizeSriText(value: string | undefined): string {
  return value?.toLocaleLowerCase().trim() ?? "";
}

export function hasRegisteredAccessKeyMessage(messages: SRIStatusMessage[]): boolean {
  return messages.some((message) => {
    const mensaje = normalizeSriText(message.mensaje);
    const informacionAdicional = normalizeSriText(message.informacionAdicional);

    return (
      mensaje.includes("clave de acceso registrada") ||
      informacionAdicional.includes("clave de acceso registrada")
    );
  });
}

export function hasAmbiguousReceptionMessage(messages: SRIStatusMessage[]): boolean {
  if (messages.length === 0) {
    return true;
  }

  return messages.every((message) => {
    const mensaje = normalizeSriText(message.mensaje);
    const informacionAdicional = normalizeSriText(message.informacionAdicional);

    return (
      message.identificador === "65" ||
      mensaje === "" ||
      mensaje === "mensaje no disponible" ||
      informacionAdicional === "mensaje no disponible"
    );
  });
}

export type SubmissionProcessResult =
  | { outcome: "no_job" }
  | { outcome: "claimed"; jobId: string; result: "received" | "authorized" | "rejected" | "failed" | "in_progress" }
  | { outcome: "error"; message: string };

export async function processNextSubmissionJob(): Promise<SubmissionProcessResult> {
  const config = getConfig();

  if (!config.enableSriTestSubmission) {
    return {
      outcome: "error",
      message: "ENABLE_SRI_TEST_SUBMISSION=false. El worker no debe enviar XML al SRI.",
    };
  }

  logger.info("Reclamando proximo submission job...");
  const job = await claimNextSubmissionJob(config.workerId);
  if (!job) {
    logger.info("No hay submission jobs pendientes.");
    return { outcome: "no_job" };
  }

  logger.info("Submission job reclamado", {
    jobId: job.id,
    tenantId: job.tenantId,
    documentId: job.documentId,
    previousStatus: job.status,
  });

  try {
    const doc = await loadSignedDocument(job);

    // Guard de producción — requiere flag explícito en el worker
    if (doc.environment === "PRODUCTION" && !config.enableSriProductionSubmission) {
      await markSubmissionFailed({
        jobId: job.id,
        errorCode: "PRODUCTION_SUBMISSION_DISABLED",
        errorMessage:
          "SRI_PRODUCTION_SUBMISSION_ENABLED no está activo. " +
          "Activa SRI_PRODUCTION_SUBMISSION_ENABLED=true en el worker para habilitar el envío a producción SRI.",
      });
      logger.warn("Submission job bloqueado: producción SRI no habilitada.", {
        jobId: job.id,
        tenantId: job.tenantId,
        documentId: job.documentId,
        environment: doc.environment,
      });
      return { outcome: "claimed", jobId: job.id, result: "failed" };
    }

    // Selección de URLs según ambiente del documento
    const isProduction = doc.environment === "PRODUCTION";
    const receptionUrl = isProduction
      ? config.sriProductionReceptionUrl!
      : config.sriTestReceptionUrl!;
    const authorizationUrl = isProduction
      ? config.sriProductionAuthorizationUrl!
      : config.sriTestAuthorizationUrl!;

    const signedXml = readSignedXml(config.signedXmlStoragePath!, doc.latestSignedXmlStorageKey!);
    ensureSignedXmlLooksSigned(signedXml);

    if (!doc.accessKey) {
      await markSubmissionFailed({
        jobId: job.id,
        errorCode: "ACCESS_KEY_NOT_FOUND",
        errorMessage: "El SriDocument no tiene accessKey persistida. No se puede enviar este comprobante.",
      });
      return { outcome: "claimed", jobId: job.id, result: "failed" };
    }

    const accessKey = doc.accessKey;
    const sriResponseTrace: Record<string, unknown> = {
      documentId: job.documentId,
      jobId: job.id,
      accessKey,
      environment: doc.environment,
    };
    const xmlAccessKey = extractAccessKeyFromXml(signedXml);
    if (!xmlAccessKey) {
      await markSubmissionFailed({
        jobId: job.id,
        errorCode: "SIGNED_XML_ACCESS_KEY_NOT_FOUND",
        errorMessage: "El XML firmado guardado no contiene clave de acceso.",
      });
      return { outcome: "claimed", jobId: job.id, result: "failed" };
    }

    if (xmlAccessKey !== accessKey) {
      await markSubmissionFailed({
        jobId: job.id,
        errorCode: "ACCESS_KEY_MISMATCH",
        errorMessage:
          "La clave del XML firmado no coincide con la clave persistida del comprobante. Se aborta el envio para evitar divergencia.",
      });
      return { outcome: "claimed", jobId: job.id, result: "failed" };
    }

    if (job.receivedAt == null) {
      const reception = await sendSignedXmlToSRIReception({ url: receptionUrl, signedXml });
      sriResponseTrace.reception = summarizeReceptionForStorage(reception);

      if (reception.kind === "DEVUELTA") {
        if (
          hasRegisteredAccessKeyMessage(reception.messages) ||
          hasAmbiguousReceptionMessage(reception.messages)
        ) {
          logger.info("Recepcion SRI requiere verificacion por autorizacion antes de rechazar.", {
            jobId: job.id,
            accessKey,
            messages: reception.messages,
          });
        } else {
          await markSubmissionRejected({
            jobId: job.id,
            sriReceiptStatus: reception.status,
            sriAccessKey: accessKey,
            errorMessage: summarizeMessages(reception.messages),
            sriResponseRaw: sriResponseTrace,
          });
          return { outcome: "claimed", jobId: job.id, result: "rejected" };
        }
      }

      if (reception.kind === "RECIBIDA") {
        await markSubmissionReceived({
          jobId: job.id,
          sriReceiptStatus: reception.status,
          sriAccessKey: accessKey,
          sriResponseRaw: sriResponseTrace,
        });
      }
    }

    const authorization = await querySRIAuthorization({ url: authorizationUrl, accessKey });
    sriResponseTrace.authorization = summarizeAuthorizationForStorage(authorization);

    if (authorization.kind === "AUTORIZADO") {
      // Guardar XML de autorización en filesystem (best-effort — no bloquea si falla)
      let authorizedXmlStorageKey: string | null = null;
      if (config.authorizedXmlStoragePath) {
        try {
          const saved = saveAuthorizedXml(
            config.authorizedXmlStoragePath,
            job.tenantId,
            job.documentId,
            authorization.rawXml
          );
          authorizedXmlStorageKey = saved.storageKey;
          logger.info("XML autorizado guardado.", {
            jobId: job.id,
            storageKey: authorizedXmlStorageKey,
            byteLength: saved.byteLength,
          });
        } catch (saveErr) {
          logger.warn("No se pudo guardar el XML autorizado. El job continúa.", {
            jobId: job.id,
            error: saveErr instanceof Error ? saveErr.message : String(saveErr),
          });
        }
      }

      await markSubmissionAuthorized({
        jobId: job.id,
        sriAuthorizationStatus: authorization.status,
        sriAuthorizationNumber: authorization.authorizationNumber,
        sriAccessKey: authorization.accessKey,
        authorizedAt: authorization.authorizedAt,
        authorizedXmlStorageKey,
        sriResponseRaw: sriResponseTrace,
      });

      logger.info("Comprobante AUTORIZADO por el SRI.", {
        jobId: job.id,
        documentId: job.documentId,
        tenantId: job.tenantId,
        accessKey: accessKey.slice(0, 12) + "...",
        authorizationNumber: authorization.authorizationNumber,
        authorizedAt: authorization.authorizedAt.toISOString(),
        environment: doc.environment,
      });

      return { outcome: "claimed", jobId: job.id, result: "authorized" };
    }

    if (authorization.kind === "NO_AUTORIZADO") {
      await markSubmissionRejected({
        jobId: job.id,
        sriAuthorizationStatus: authorization.status,
        sriAccessKey: authorization.accessKey,
        errorMessage: summarizeMessages(authorization.messages),
        sriResponseRaw: sriResponseTrace,
      });
      return { outcome: "claimed", jobId: job.id, result: "rejected" };
    }

    await markSubmissionReceived({
      jobId: job.id,
      sriReceiptStatus:
        job.receivedAt == null
          ? typeof (sriResponseTrace.reception as { status?: string } | undefined)?.status === "string"
            ? ((sriResponseTrace.reception as { status: string }).status)
            : "RECIBIDA"
          : job.sriReceiptStatus ?? "RECIBIDA",
      sriAccessKey: authorization.accessKey,
      sriResponseRaw: sriResponseTrace,
      pollAfterMs: 60_000,
    });
    return { outcome: "claimed", jobId: job.id, result: "in_progress" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("Error al procesar submission job", {
      jobId: job.id,
      message,
    });

    try {
      await markSubmissionFailed({
        jobId: job.id,
        errorCode: "SUBMISSION_PROCESSING_ERROR",
        errorMessage: message,
      });
    } catch (markError) {
      logger.error("No se pudo marcar submission job como fallido", {
        jobId: job.id,
        message: markError instanceof Error ? markError.message : String(markError),
      });
    }

    return { outcome: "claimed", jobId: job.id, result: "failed" };
  }
}
