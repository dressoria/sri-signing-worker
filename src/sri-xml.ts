/**
 * Generación de XML para facturas electrónicas SRI Ecuador.
 * Proceso separado del dashboard — mantener sincronizado con lib/core/sri-xml.ts.
 * Versión del comprobante: factura 1.1.0 (ficha técnica SRI vigente).
 */

import { createHash } from "crypto";

// ── Tipos ─────────────────────────────────────────────────────────────────────

export type SriDocumentData = {
  id: string;
  documentType: string;
  environment: "TEST" | "PRODUCTION";
  sequentialNumber: number | null;
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
  issuedAt: Date | null;
  createdAt: Date;
};

export type SriProfileData = {
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

export type SriEstablishmentData = {
  code: string;
  name: string;
  address: string;
};

export type SriIssuePointData = {
  code: string;
};

export type SriDocumentLineData = {
  itemName: string;
  itemCode: string | null;
  itemAuxiliaryCode?: string | null;
  quantity: string;
  unitPrice: string;
  discountAmount: string;
  subtotal: string;
  taxRate: string;
  taxAmount: string;
  total: string;
};

// ── Utilidades ────────────────────────────────────────────────────────────────

function pad(n: number, digits: number): string {
  return String(n).padStart(digits, "0");
}

function dec(value: string | number, digits = 2): string {
  return Number(value).toFixed(digits);
}

function esc(val: string | null | undefined): string {
  if (!val) return "";
  return val
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

const ECUADOR_TIME_ZONE = "America/Guayaquil";
const ECUADOR_DATE_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: ECUADOR_TIME_ZONE,
  calendar: "gregory",
  numberingSystem: "latn",
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
});

export function getEcuadorSriDateParts(date: Date): {
  day: string;
  month: string;
  year: string;
} {
  if (Number.isNaN(date.getTime())) throw new Error("Fecha SRI inválida.");
  const parts = Object.fromEntries(
    ECUADOR_DATE_FORMATTER.formatToParts(date).map((part) => [part.type, part.value])
  );
  if (!parts.day || !parts.month || !parts.year)
    throw new Error(`No se pudo convertir la fecha SRI a ${ECUADOR_TIME_ZONE}.`);
  return { day: parts.day, month: parts.month, year: parts.year };
}

export function formatDateEC(date: Date): string {
  const { day, month, year } = getEcuadorSriDateParts(date);
  return `${day}/${month}/${year}`;
}

// ── Clave de acceso ───────────────────────────────────────────────────────────

function getSriDocumentCode(type: string): string {
  const codes: Record<string, string> = {
    INVOICE: "01",
    CREDIT_NOTE: "04",
    DEBIT_NOTE: "05",
    WITHHOLDING: "07",
    REFERRAL_GUIDE: "06",
  };
  const code = codes[type];
  if (!code) throw new Error(`Tipo de documento SRI no soportado: ${type}`);
  return code;
}

function stableNumericCode(documentId: string): string {
  const hash = createHash("sha256").update(documentId).digest("hex");
  const num = parseInt(hash.slice(0, 8), 16);
  return String(num % 100_000_000).padStart(8, "0");
}

function modulo11CheckDigit(base48: string): string {
  const multipliers = [2, 3, 4, 5, 6, 7];
  let sum = 0;
  for (let i = base48.length - 1; i >= 0; i--) {
    const digit = parseInt(base48[i]!, 10);
    const multiplier = multipliers[(base48.length - 1 - i) % 6]!;
    sum += digit * multiplier;
  }
  const raw = 11 - (sum % 11);
  if (raw === 11) return "0";
  if (raw === 10) return "1";
  return String(raw);
}

export function buildDisplayNumber(
  establishmentCode: string,
  issuePointCode: string,
  sequential: number
): string {
  return `${establishmentCode}-${issuePointCode}-${pad(sequential, 9)}`;
}

export function buildAccessKey(params: {
  issuedAt: Date;
  documentType: string;
  ruc: string;
  environment: "TEST" | "PRODUCTION";
  establishmentCode: string;
  issuePointCode: string;
  sequentialNumber: number;
  documentId: string;
}): string {
  const numericCode = stableNumericCode(params.documentId);
  const envCode = params.environment === "PRODUCTION" ? "2" : "1";
  const docCode = getSriDocumentCode(params.documentType);
  const { day, month, year } = getEcuadorSriDateParts(params.issuedAt);
  const dateStr = `${day}${month}${year}`;
  const sequential = pad(params.sequentialNumber, 9);

  const base48 = `${dateStr}${docCode}${params.ruc}${envCode}${params.establishmentCode}${params.issuePointCode}${sequential}${numericCode}1`;

  if (base48.length !== 48) {
    throw new Error(`Base de clave inválida: ${base48.length} dígitos (esperado 48).`);
  }

  return `${base48}${modulo11CheckDigit(base48)}`;
}

// ── Resolución de identificación del comprador ────────────────────────────────

function resolveIdentificacion(identification: string | null): {
  tipo: string;
  valor: string;
} {
  if (!identification || !identification.trim()) {
    return { tipo: "07", valor: "9999999999999" }; // Consumidor Final
  }
  const id = identification.trim();
  if (/^\d{13}$/.test(id)) return { tipo: "04", valor: id }; // RUC
  if (/^\d{10}$/.test(id)) return { tipo: "05", valor: id }; // Cédula
  return { tipo: "06", valor: id }; // Pasaporte / exterior
}

// ── codigoPorcentaje IVA (catálogo SRI) ──────────────────────────────────────

function resolveIvaCodigoPorcentaje(taxRate: string): string {
  const rate = Number(taxRate);
  if (rate === 0) return "0";  // 0%
  if (rate === 5) return "5";  // 5% (bienes específicos)
  if (rate === 12) return "2"; // 12% (tarifa histórica)
  if (rate === 15) return "4"; // 15% (tarifa vigente desde 2024)
  return "2"; // default: IVA general
}

const FACTUROM_ELECTRONIC_BILLING_PROVIDER_RUC = "1793242481001";
const FACTUROM_SYSTEM_NAME = "FACTUROM COM";
const COMMERCIAL_PAYMENT_LABELS: Record<string, string> = {
  cash: "EFECTIVO",
  transfer: "TRANSFERENCIA",
  card: "TARJETA",
  credit: "CRÉDITO",
};

function resolveCommercialPaymentLabel(method: string | null): string {
  return method ? (COMMERCIAL_PAYMENT_LABELS[method] ?? method.toUpperCase()) : "";
}

export function validateSriInvoiceXmlStructure(
  xml: string,
  taxRegimeCode: string | null
): string[] {
  const errors: string[] = [];
  const infoTributaria = xml.match(/<infoTributaria>([\s\S]*?)<\/infoTributaria>/)?.[1] ?? "";
  const infoFactura = xml.match(/<infoFactura>([\s\S]*?)<\/infoFactura>/)?.[1] ?? "";
  const isRimpe = ["RIMPE_EMPRENDEDOR", "RIMPE_NEGOCIO_POPULAR"].includes(
    taxRegimeCode ?? ""
  );

  if (/<contribuyenteRimpe>/.test(infoFactura))
    errors.push("contribuyenteRimpe no puede estar dentro de infoFactura.");
  if (isRimpe && !/<contribuyenteRimpe>/.test(infoTributaria))
    errors.push("El régimen RIMPE requiere contribuyenteRimpe en infoTributaria.");
  if (!isRimpe && /<contribuyenteRimpe>/.test(infoTributaria))
    errors.push("contribuyenteRimpe solo corresponde a contribuyentes RIMPE.");
  if (!/<obligadoContabilidad>(SI|NO)<\/obligadoContabilidad>/.test(infoFactura))
    errors.push("obligadoContabilidad debe contener SI o NO dentro de infoFactura.");
  return errors;
}

// ── XML preliminar (sin firma) ────────────────────────────────────────────────

export function buildPreliminaryXml(params: {
  doc: SriDocumentData;
  profile: SriProfileData;
  establishment: SriEstablishmentData;
  issuePoint: SriIssuePointData;
  lines: SriDocumentLineData[];
  accessKey: string;
  displayNumber: string;
}): string {
  const { doc, profile, establishment, issuePoint, lines, accessKey } = params;

  if (doc.sequentialNumber == null) {
    throw new Error("MISSING_PERSISTED_SEQUENCE: El documento no tiene sequentialNumber persistido.");
  }

  const issuedAt = doc.issuedAt ?? doc.createdAt;
  const fechaEmision = formatDateEC(issuedAt);
  const { tipo: tipoIdComprador, valor: idComprador } = resolveIdentificacion(doc.customerIdentification);
  const ambiente = doc.environment === "PRODUCTION" ? "2" : "1";
  const dirMatriz = esc(profile.dirMatriz ?? establishment.address);

  const totalSinImpuestos = dec(doc.subtotal);
  const totalDescuento = dec(doc.discountTotal);
  const importeTotal = dec(doc.grandTotal);

  // Agrupar impuestos por tasa para totalConImpuestos
  const taxMap = new Map<string, { codigoPorcentaje: string; tarifa: string; baseImponible: number; valor: number }>();
  for (const line of lines) {
    const cp = resolveIvaCodigoPorcentaje(line.taxRate);
    const key = cp;
    const base = Number(line.subtotal);
    const tax = Number(line.taxAmount);
    const existing = taxMap.get(key);
    if (existing) {
      existing.baseImponible += base;
      existing.valor += tax;
    } else {
      taxMap.set(key, { codigoPorcentaje: cp, tarifa: dec(line.taxRate), baseImponible: base, valor: tax });
    }
  }

  const totalImpuestosXml = Array.from(taxMap.values())
    .map(
      (g) => `      <totalImpuesto>
        <codigo>2</codigo>
        <codigoPorcentaje>${g.codigoPorcentaje}</codigoPorcentaje>
        <baseImponible>${dec(g.baseImponible)}</baseImponible>
        <valor>${dec(g.valor)}</valor>
      </totalImpuesto>`
    )
    .join("\n");

  // Detalle de líneas
  const linesXml = lines
    .map((l) => {
      if (!l.itemCode?.trim()) {
        throw new Error(
          `SRI_ITEM_PRIMARY_CODE_MISSING: el producto "${l.itemName}" no tiene código principal.`,
        );
      }
      const cp = resolveIvaCodigoPorcentaje(l.taxRate);
      const auxLine = l.itemAuxiliaryCode?.trim()
        ? `\n      <codigoAuxiliar>${esc(l.itemAuxiliaryCode.trim())}</codigoAuxiliar>`
        : "";
      return `    <detalle>
      <codigoPrincipal>${esc(l.itemCode.trim())}</codigoPrincipal>${auxLine}
      <descripcion>${esc(l.itemName)}</descripcion>
      <cantidad>${dec(l.quantity, 6)}</cantidad>
      <precioUnitario>${dec(l.unitPrice, 6)}</precioUnitario>
      <descuento>${dec(l.discountAmount)}</descuento>
      <precioTotalSinImpuesto>${dec(l.subtotal)}</precioTotalSinImpuesto>
      <impuestos>
        <impuesto>
          <codigo>2</codigo>
          <codigoPorcentaje>${cp}</codigoPorcentaje>
          <tarifa>${dec(l.taxRate)}</tarifa>
          <baseImponible>${dec(l.subtotal)}</baseImponible>
          <valor>${dec(l.taxAmount)}</valor>
        </impuesto>
      </impuestos>
    </detalle>`;
    })
    .join("\n");

  // infoAdicional (campos opcionales)
  const additionalValues: Array<[string, string | null | undefined]> = [
    ["REGIMEN", profile.contribuyenteRimpe],
    ["RUC PROVEEDOR FACTURACIÓN ELECTRONICA", FACTUROM_ELECTRONIC_BILLING_PROVIDER_RUC],
    ["SISTEMA", FACTUROM_SYSTEM_NAME],
    ["EMAIL EMPRESA", profile.companyEmail],
    ["TELEFONO EMPRESA", profile.companyPhone],
    ["EMAIL CLIENTE", doc.customerEmail],
    ["TELEFONO CLIENTE", doc.customerPhone],
    ["DIRECCION CLIENTE", doc.customerAddress],
    ["FORMA PAGO", resolveCommercialPaymentLabel(doc.commercialPaymentMethod)],
  ];
  const infoAdicionalItems = additionalValues
    .filter((item): item is [string, string] => Boolean(item[1]?.trim()))
    .map(([name, value]) => `    <campoAdicional nombre="${esc(name)}">${esc(value)}</campoAdicional>`);
  const infoAdicionalXml = `  <infoAdicional>\n${infoAdicionalItems.join("\n")}\n  </infoAdicional>`;

  const contribuyenteRimpeXml = profile.contribuyenteRimpe &&
    ["RIMPE_EMPRENDEDOR", "RIMPE_NEGOCIO_POPULAR"].includes(profile.taxRegimeCode ?? "")
    ? `\n    <contribuyenteRimpe>${esc(profile.contribuyenteRimpe)}</contribuyenteRimpe>`
    : "";

  return `<?xml version="1.0" encoding="UTF-8"?>
<factura id="comprobante" version="1.1.0">
  <infoTributaria>
    <ambiente>${ambiente}</ambiente>
    <tipoEmision>1</tipoEmision>
    <razonSocial>${esc(profile.legalName)}</razonSocial>
    <nombreComercial>${esc(profile.tradeName ?? profile.legalName)}</nombreComercial>
    <ruc>${esc(profile.ruc)}</ruc>
    <claveAcceso>${accessKey}</claveAcceso>
    <codDoc>${getSriDocumentCode(doc.documentType)}</codDoc>
    <estab>${esc(establishment.code)}</estab>
    <ptoEmi>${esc(issuePoint.code)}</ptoEmi>
    <secuencial>${pad(doc.sequentialNumber, 9)}</secuencial>
    <dirMatriz>${dirMatriz}</dirMatriz>${contribuyenteRimpeXml}
  </infoTributaria>
  <infoFactura>
    <fechaEmision>${fechaEmision}</fechaEmision>
    <dirEstablecimiento>${esc(establishment.address)}</dirEstablecimiento>
    <obligadoContabilidad>${profile.accountingRequired ? "SI" : "NO"}</obligadoContabilidad>
    <tipoIdentificacionComprador>${tipoIdComprador}</tipoIdentificacionComprador>
    <razonSocialComprador>${esc(doc.customerName)}</razonSocialComprador>
    <identificacionComprador>${esc(idComprador)}</identificacionComprador>
    <totalSinImpuestos>${totalSinImpuestos}</totalSinImpuestos>
    <totalDescuento>${totalDescuento}</totalDescuento>
    <totalConImpuestos>
${totalImpuestosXml}
    </totalConImpuestos>
    <propina>0.00</propina>
    <importeTotal>${importeTotal}</importeTotal>
    <moneda>${esc(doc.currency || "DOLAR")}</moneda>
    <pagos>
      <pago>
        <formaPago>${esc(doc.sriPaymentCode ?? "01")}</formaPago>
        <total>${importeTotal}</total>
        <plazo>0</plazo>
        <unidadTiempo>dias</unidadTiempo>
      </pago>
    </pagos>
  </infoFactura>
  <detalles>
${linesXml}
  </detalles>
  ${infoAdicionalXml}
</factura>`;
}
