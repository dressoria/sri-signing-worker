import { query } from "./db";
import { getConfig } from "./config";
import { logger } from "./logger";
import { readSignedXml } from "./signed-xml-storage";
import {
  claimNextSubmissionJob,
  markSubmissionAuthorized,
  markSubmissionFailed,
  markSubmissionReceived,
  markSubmissionRejected,
  SubmissionJob,
} from "./sri-submission-jobs";
import { querySRIAuthorization, sendSignedXmlToSRIReception } from "./sri-webservice";

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

  if (doc.environment !== "TEST") {
    throw new Error("El envio a produccion SRI todavia no esta habilitado.");
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
    if (message.identificador === "35") {
      return true;
    }

    const mensaje = normalizeSriText(message.mensaje);
    const informacionAdicional = normalizeSriText(message.informacionAdicional);

    return (
      mensaje.includes("clave de acceso registrada") ||
      informacionAdicional.includes("clave de acceso registrada")
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
      message: "ENABLE_SRI_TEST_SUBMISSION=false. El worker no debe enviar XML al SRI TEST.",
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
      const reception = await sendSignedXmlToSRIReception({
        url: config.sriTestReceptionUrl!,
        signedXml,
      });

      if (reception.kind === "DEVUELTA") {
        if (hasRegisteredAccessKeyMessage(reception.messages)) {
          logger.info("Recepcion SRI devolvio #35 Clave de acceso registrada. Se consultara autorizacion.", {
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
            sriResponseRaw: { phase: "recepcion", status: reception.status, messages: reception.messages },
          });
          return { outcome: "claimed", jobId: job.id, result: "rejected" };
        }
      } else {
        await markSubmissionReceived({
          jobId: job.id,
          sriReceiptStatus: reception.status,
          sriAccessKey: accessKey,
          sriResponseRaw: { phase: "recepcion", status: reception.status },
        });
      }
    }

    const authorization = await querySRIAuthorization({
      url: config.sriTestAuthorizationUrl!,
      accessKey,
    });

    if (authorization.kind === "AUTORIZADO") {
      await markSubmissionAuthorized({
        jobId: job.id,
        sriAuthorizationStatus: authorization.status,
        sriAuthorizationNumber: authorization.authorizationNumber,
        sriAccessKey: authorization.accessKey,
        authorizedAt: authorization.authorizedAt,
        sriResponseRaw: {
          phase: "autorizacion",
          status: authorization.status,
          authorizationNumber: authorization.authorizationNumber,
          messages: authorization.messages,
        },
      });
      return { outcome: "claimed", jobId: job.id, result: "authorized" };
    }

    if (authorization.kind === "NO_AUTORIZADO") {
      await markSubmissionRejected({
        jobId: job.id,
        sriAuthorizationStatus: authorization.status,
        sriAccessKey: authorization.accessKey,
        errorMessage: summarizeMessages(authorization.messages),
        sriResponseRaw: {
          phase: "autorizacion",
          status: authorization.status,
          messages: authorization.messages,
        },
      });
      return { outcome: "claimed", jobId: job.id, result: "rejected" };
    }

    await markSubmissionReceived({
      jobId: job.id,
      sriReceiptStatus: "RECIBIDA",
      sriAccessKey: authorization.accessKey,
      sriResponseRaw: { phase: "autorizacion", status: authorization.status },
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
