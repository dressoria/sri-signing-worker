import http from "http";
import https from "https";

type ReceiptMessage = {
  identificador?: string;
  mensaje: string;
  informacionAdicional?: string;
  tipo?: string;
};

type AuthorizationMessage = {
  identificador?: string;
  mensaje: string;
  informacionAdicional?: string;
  tipo?: string;
};

const SOAP_ENV_NAMESPACE = "http://schemas.xmlsoap.org/soap/envelope/";
const SRI_RECEPCION_NAMESPACE = "http://ec.gob.sri.ws.recepcion";
const SRI_AUTORIZACION_NAMESPACE = "http://ec.gob.sri.ws.autorizacion";
const SRI_MESSAGE_BY_IDENTIFIER: Record<string, string> = {
  "35": "Clave de acceso registrada",
};

export type SRIReceptionResult =
  | {
      kind: "RECIBIDA";
      status: "RECIBIDA";
      rawXml: string;
    }
  | {
      kind: "DEVUELTA";
      status: "DEVUELTA";
      rawXml: string;
      messages: ReceiptMessage[];
    };

export type SRIAuthorizationResult =
  | {
      kind: "AUTORIZADO";
      status: "AUTORIZADO";
      authorizationNumber: string;
      accessKey: string;
      authorizedAt: Date;
      rawXml: string;
      messages: AuthorizationMessage[];
    }
  | {
      kind: "NO_AUTORIZADO";
      status: "NO AUTORIZADO";
      accessKey: string;
      rawXml: string;
      messages: AuthorizationMessage[];
    }
  | {
      kind: "EN_PROCESO";
      status: "EN PROCESO";
      accessKey: string;
      rawXml: string;
    };

function stripWsdl(url: string): string {
  return url.replace(/\?wsdl$/i, "");
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function extractFirstTag(xml: string, tagName: string): string | null {
  const match = xml.match(new RegExp(`<(?:\\w+:)?${tagName}>([\\s\\S]*?)</(?:\\w+:)?${tagName}>`, "i"));
  return match?.[1] ? decodeXmlEntities(match[1].trim()) : null;
}

function extractAllBlocks(xml: string, tagName: string): string[] {
  return Array.from(
    xml.matchAll(new RegExp(`<(?:\\w+:)?${tagName}>([\\s\\S]*?)</(?:\\w+:)?${tagName}>`, "gi"))
  ).map((match) => match[1] ?? "");
}

function parseMessages(blocks: string[]): ReceiptMessage[] {
  return blocks.map((block) => {
    const identificador = extractFirstTag(block, "identificador") ?? undefined;
    const rawMessage = extractFirstTag(block, "mensaje");
    const mappedMessage =
      identificador != null ? SRI_MESSAGE_BY_IDENTIFIER[identificador] : undefined;
    const mensaje =
      rawMessage && rawMessage !== "Mensaje no disponible"
        ? rawMessage
        : mappedMessage ?? "Mensaje no disponible";

    return {
      identificador,
      mensaje,
      informacionAdicional: extractFirstTag(block, "informacionAdicional") ?? undefined,
      tipo: extractFirstTag(block, "tipo") ?? undefined,
    };
  });
}

function sanitizeSoapFaultText(xml: string): string {
  const faultString =
    extractFirstTag(xml, "faultstring") ??
    extractFirstTag(xml, "faultcode") ??
    extractFirstTag(xml, "message");

  if (faultString) {
    return faultString.replace(/\s+/g, " ").trim().slice(0, 300);
  }

  return xml.replace(/\s+/g, " ").trim().slice(0, 300);
}

function extractEnvironment(rawXml: string): string | null {
  return extractFirstTag(rawXml, "ambiente");
}

export function buildReceptionSoapEnvelope(actionBody: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="${SOAP_ENV_NAMESPACE}" xmlns:ec="${SRI_RECEPCION_NAMESPACE}">
  <soapenv:Header/>
  <soapenv:Body>
    ${actionBody}
  </soapenv:Body>
</soapenv:Envelope>`;
}

export function buildAuthorizationSoapEnvelope(actionBody: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="${SOAP_ENV_NAMESPACE}" xmlns:ec="${SRI_AUTORIZACION_NAMESPACE}">
  <soapenv:Header/>
  <soapenv:Body>
    ${actionBody}
  </soapenv:Body>
</soapenv:Envelope>`;
}

async function postSoapXml(params: {
  url: string;
  body: string;
  phase: "reception" | "authorization";
}): Promise<string> {
  const endpoint = new URL(stripWsdl(params.url));
  const client = endpoint.protocol === "https:" ? https : http;
  const bodyBuffer = Buffer.from(params.body, "utf8");

  return new Promise<string>((resolve, reject) => {
    const request = client.request(
      {
        protocol: endpoint.protocol,
        hostname: endpoint.hostname,
        port: endpoint.port || undefined,
        path: `${endpoint.pathname}${endpoint.search}`,
        method: "POST",
        headers: {
          "Content-Type": "text/xml; charset=utf-8",
          SOAPAction: "",
          "Content-Length": String(bodyBuffer.length),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];

        response.on("data", (chunk: Buffer | string) => {
          chunks.push(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk);
        });

        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          const statusCode = response.statusCode ?? 0;

          if (statusCode < 200 || statusCode >= 300) {
            reject(
              new Error(
                `SRI ${params.phase} HTTP ${statusCode}: ${sanitizeSoapFaultText(text)}`
              )
            );
            return;
          }

          resolve(text);
        });
      }
    );

    request.on("error", reject);
    request.write(bodyBuffer);
    request.end();
  });
}

export async function sendSignedXmlToSRIReception(params: {
  url: string;
  signedXml: string;
}): Promise<SRIReceptionResult> {
  const xmlBase64 = Buffer.from(params.signedXml, "utf8").toString("base64");
  const rawXml = await postSoapXml({
    url: params.url,
    body: buildReceptionSoapEnvelope(
      `<ec:validarComprobante><xml>${escapeXml(xmlBase64)}</xml></ec:validarComprobante>`
    ),
    phase: "reception",
  });

  return parseSRIReceptionResponse(rawXml);
}

export function parseSRIReceptionResponse(rawXml: string): SRIReceptionResult {
  const estado = extractFirstTag(rawXml, "estado");
  if (estado === "RECIBIDA") {
    return { kind: "RECIBIDA", status: "RECIBIDA", rawXml };
  }

  if (estado === "DEVUELTA") {
    return {
      kind: "DEVUELTA",
      status: "DEVUELTA",
      rawXml,
      messages: parseMessages(extractAllBlocks(rawXml, "mensaje")),
    };
  }

  throw new Error(`Respuesta inesperada del servicio de recepcion SRI: ${estado ?? "sin estado"}`);
}

export async function querySRIAuthorization(params: {
  url: string;
  accessKey: string;
}): Promise<SRIAuthorizationResult> {
  const rawXml = await postAuthorizationSoap(
    params.url,
    `<ec:autorizacionComprobante><claveAccesoComprobante>${escapeXml(
      params.accessKey
    )}</claveAccesoComprobante></ec:autorizacionComprobante>`
  );

  return parseSRIAuthorizationResponse(rawXml, params.accessKey);
}

export function parseSRIAuthorizationResponse(
  rawXml: string,
  fallbackAccessKey: string
): SRIAuthorizationResult {
  const authorizationBlocks = extractAllBlocks(rawXml, "autorizacion");
  if (authorizationBlocks.length === 0) {
    return {
      kind: "EN_PROCESO",
      status: "EN PROCESO",
      accessKey: fallbackAccessKey,
      rawXml,
    };
  }

  const first = authorizationBlocks[0]!;
  const status = extractFirstTag(first, "estado") ?? "EN PROCESO";
  const accessKey = extractFirstTag(first, "claveAcceso") ?? fallbackAccessKey;

  if (status === "AUTORIZADO") {
    return {
      kind: "AUTORIZADO",
      status: "AUTORIZADO",
      authorizationNumber: extractFirstTag(first, "numeroAutorizacion") ?? "",
      accessKey,
      authorizedAt: new Date(extractFirstTag(first, "fechaAutorizacion") ?? new Date().toISOString()),
      rawXml,
      messages: parseMessages(extractAllBlocks(first, "mensaje")),
    };
  }

  if (status === "NO AUTORIZADO") {
    return {
      kind: "NO_AUTORIZADO",
      status: "NO AUTORIZADO",
      accessKey,
      rawXml,
      messages: parseMessages(extractAllBlocks(first, "mensaje")),
    };
  }

  return {
    kind: "EN_PROCESO",
    status: "EN PROCESO",
    accessKey,
    rawXml,
  };
}

async function postAuthorizationSoap(url: string, actionBody: string): Promise<string> {
  return postSoapXml({
    url,
    body: buildAuthorizationSoapEnvelope(actionBody),
    phase: "authorization",
  });
}

export function summarizeReceptionForStorage(result: SRIReceptionResult) {
  return {
    status: result.status,
    messages: result.kind === "DEVUELTA" ? result.messages : [],
    rawXml: result.rawXml,
  };
}

export function summarizeAuthorizationForStorage(result: SRIAuthorizationResult) {
  return {
    status: result.status,
    accessKey: result.accessKey,
    authorizationNumber:
      result.kind === "AUTORIZADO" ? result.authorizationNumber : null,
    authorizedAt:
      result.kind === "AUTORIZADO" ? result.authorizedAt.toISOString() : null,
    environment: extractEnvironment(result.rawXml),
    messages:
      result.kind === "AUTORIZADO" || result.kind === "NO_AUTORIZADO"
        ? result.messages
        : [],
    rawXml: result.rawXml,
  };
}
