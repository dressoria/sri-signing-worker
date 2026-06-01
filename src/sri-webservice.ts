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
  return blocks.map((block) => ({
    identificador: extractFirstTag(block, "identificador") ?? undefined,
    mensaje: extractFirstTag(block, "mensaje") ?? "Mensaje no disponible",
    informacionAdicional: extractFirstTag(block, "informacionAdicional") ?? undefined,
    tipo: extractFirstTag(block, "tipo") ?? undefined,
  }));
}

async function postSoap(url: string, actionBody: string): Promise<string> {
  const body = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ec="ec.gob.sri.ws.recepcion">
  <soapenv:Header/>
  <soapenv:Body>
    ${actionBody}
  </soapenv:Body>
</soapenv:Envelope>`;

  const response = await fetch(stripWsdl(url), {
    method: "POST",
    headers: {
      "Content-Type": "text/xml; charset=utf-8",
    },
    body,
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`SRI reception HTTP ${response.status}: ${text.slice(0, 300)}`);
  }
  return text;
}

async function postAuthorizationSoap(url: string, actionBody: string): Promise<string> {
  const body = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ec="ec.gob.sri.ws.autorizacion">
  <soapenv:Header/>
  <soapenv:Body>
    ${actionBody}
  </soapenv:Body>
</soapenv:Envelope>`;

  const response = await fetch(stripWsdl(url), {
    method: "POST",
    headers: {
      "Content-Type": "text/xml; charset=utf-8",
    },
    body,
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`SRI authorization HTTP ${response.status}: ${text.slice(0, 300)}`);
  }
  return text;
}

export async function sendSignedXmlToSRIReception(params: {
  url: string;
  signedXml: string;
}): Promise<SRIReceptionResult> {
  const xmlBase64 = Buffer.from(params.signedXml, "utf8").toString("base64");
  const rawXml = await postSoap(
    params.url,
    `<ec:validarComprobante><xml>${escapeXml(xmlBase64)}</xml></ec:validarComprobante>`
  );

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

  const authorizationBlocks = extractAllBlocks(rawXml, "autorizacion");
  if (authorizationBlocks.length === 0) {
    return {
      kind: "EN_PROCESO",
      status: "EN PROCESO",
      accessKey: params.accessKey,
      rawXml,
    };
  }

  const first = authorizationBlocks[0]!;
  const status = extractFirstTag(first, "estado") ?? "EN PROCESO";
  const accessKey = extractFirstTag(first, "claveAcceso") ?? params.accessKey;

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
