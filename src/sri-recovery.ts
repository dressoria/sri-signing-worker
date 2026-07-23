import { getConfig } from "./config";
import { logger } from "./logger";
import { saveAuthorizedXml } from "./authorized-xml-storage";
import {
  findSubmissionRecoveryTarget,
  recoverSubmissionAuthorized,
  type SubmissionRecoveryTarget,
} from "./sri-submission-jobs";
import {
  querySRIAuthorization,
  summarizeAuthorizationForStorage,
} from "./sri-webservice";

type RecoveryLookup = {
  documentId?: string;
  accessKey?: string;
};

export type RecoveryAuthorizationResult =
  | {
      outcome: "authorized";
      target: SubmissionRecoveryTarget;
      authorizationNumber: string;
      authorizedAt: string;
      authorizedXmlStorageKey: string | null;
    }
  | {
      outcome: "not_found";
      target: SubmissionRecoveryTarget;
      authorizationStatus: "EN PROCESO";
    }
  | {
      outcome: "rejected";
      target: SubmissionRecoveryTarget;
      authorizationStatus: "NO AUTORIZADO";
      messageSummary: string;
    };

function summarizeAuthorizationMessages(
  messages: Array<{
    mensaje: string;
    informacionAdicional?: string;
    identificador?: string;
  }>
) {
  return messages
    .map((message) =>
      [message.identificador ? `#${message.identificador}` : null, message.mensaje, message.informacionAdicional]
        .filter(Boolean)
        .join(" - ")
    )
    .join("; ");
}

function resolveAuthorizationUrl(environment: "TEST" | "PRODUCTION") {
  const config = getConfig();
  return environment === "PRODUCTION"
    ? config.sriProductionAuthorizationUrl
    : config.sriTestAuthorizationUrl;
}

export async function recoverAuthorizationByLookup(
  lookup: RecoveryLookup
): Promise<RecoveryAuthorizationResult> {
  const target = await findSubmissionRecoveryTarget(lookup);

  if (!target) {
    throw new Error("No se encontró SriDocument para el criterio enviado.");
  }

  if (!target.accessKey) {
    throw new Error("El SriDocument no tiene accessKey persistida. No se puede recuperar autorización.");
  }

  const authorizationUrl = resolveAuthorizationUrl(target.environment);
  if (!authorizationUrl) {
    throw new Error(`No hay URL de autorización configurada para ambiente ${target.environment}.`);
  }

  const authorization = await querySRIAuthorization({
    url: authorizationUrl,
    accessKey: target.accessKey,
  });

  if (authorization.kind === "AUTORIZADO") {
    let authorizedXmlStorageKey: string | null = target.authorizedXmlStorageKey;
    const config = getConfig();

    if (config.authorizedXmlStoragePath) {
      const saved = saveAuthorizedXml(
        config.authorizedXmlStoragePath,
        target.tenantId,
        target.documentId,
        authorization.rawXml
      );
      authorizedXmlStorageKey = saved.storageKey;
    }

    await recoverSubmissionAuthorized({
      documentId: target.documentId,
      tenantId: target.tenantId,
      accessKey: authorization.accessKey,
      authorizationNumber: authorization.authorizationNumber,
      authorizedAt: authorization.authorizedAt,
      authorizedXmlStorageKey,
      sriResponseRaw: {
        recovery: true,
        documentId: target.documentId,
        accessKey: authorization.accessKey,
        authorization: summarizeAuthorizationForStorage(authorization),
      },
    });

    return {
      outcome: "authorized",
      target,
      authorizationNumber: authorization.authorizationNumber,
      authorizedAt: authorization.authorizedAt.toISOString(),
      authorizedXmlStorageKey,
    };
  }

  if (authorization.kind === "NO_AUTORIZADO") {
    return {
      outcome: "rejected",
      target,
      authorizationStatus: authorization.status,
      messageSummary: summarizeAuthorizationMessages(authorization.messages),
    };
  }

  return {
    outcome: "not_found",
    target,
    authorizationStatus: authorization.status,
  };
}

export async function runRecoverAuthorizationCommand(): Promise<void> {
  const documentId = process.env["SRI_DOCUMENT_ID"]?.trim() || undefined;
  const accessKey = process.env["ACCESS_KEY"]?.trim() || undefined;

  if (!documentId && !accessKey) {
    throw new Error("Debes enviar SRI_DOCUMENT_ID o ACCESS_KEY para recovery.");
  }

  const result = await recoverAuthorizationByLookup({ documentId, accessKey });

  logger.info("Recovery de autorización ejecutado.", {
    lookup: { documentId: documentId ?? null, accessKey: accessKey ?? null },
    previousDocumentStatus: result.target.documentStatus,
    previousSubmissionStatus: result.target.submissionJobStatus,
    outcome: result.outcome,
    authorizationNumber:
      result.outcome === "authorized" ? result.authorizationNumber : null,
    authorizedAt: result.outcome === "authorized" ? result.authorizedAt : null,
    authorizedXmlStorageKey:
      result.outcome === "authorized" ? result.authorizedXmlStorageKey : null,
    messageSummary:
      result.outcome === "rejected" ? result.messageSummary : null,
  });
}
