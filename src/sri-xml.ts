/**
 * Helpers puros para generación de XML SRI Ecuador.
 * Lógica duplicada del dashboard — el worker es un proceso separado y no importa
 * desde Next.js. Mantener sincronizado manualmente con lib/core/sri-access-key.ts.
 */

import { createHash } from "crypto";

// ── Tipos de datos del documento ─────────────────────────────────────────────

export type SriDocumentData = {
  id: string;
  documentType: string;
  environment: "TEST" | "PRODUCTION";
  sequentialNumber: number | null;
  accessKey: string | null;
  customerName: string;
  customerIdentification: string | null;
  customerEmail: string | null;
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
  environment: "TEST" | "PRODUCTION";
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
  quantity: string;
  unitPrice: string;
  discountAmount: string;
  subtotal: string;
  taxRate: string;
  taxAmount: string;
  total: string;
};

// ── Acceso a clave ────────────────────────────────────────────────────────────

function formatSriDate(date: Date): string {
  const day = String(date.getDate()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const year = String(date.getFullYear());
  return `${day}${month}${year}`;
}

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

function formatSequential(n: number): string {
  return String(n).padStart(9, "0");
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
  return `${establishmentCode}-${issuePointCode}-${formatSequential(sequential)}`;
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
  const dateStr = formatSriDate(params.issuedAt);
  const sequential = formatSequential(params.sequentialNumber);

  const base48 = `${dateStr}${docCode}${params.ruc}${envCode}${params.establishmentCode}${params.issuePointCode}${sequential}${numericCode}1`;

  if (base48.length !== 48) {
    throw new Error(`Base de clave inválida: ${base48.length} dígitos (esperado 48).`);
  }

  return `${base48}${modulo11CheckDigit(base48)}`;
}

// ── Escape XML ────────────────────────────────────────────────────────────────

function esc(val: string | null | undefined): string {
  if (!val) return "";
  return val
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// ── Generador XML preliminar (sin firma) ──────────────────────────────────────

export function buildPreliminaryXml(params: {
  doc: SriDocumentData;
  profile: SriProfileData;
  establishment: SriEstablishmentData;
  issuePoint: SriIssuePointData;
  lines: SriDocumentLineData[];
  accessKey: string;
  displayNumber: string;
}): string {
  const { doc, profile, establishment, issuePoint, lines, accessKey, displayNumber } = params;

  if (doc.sequentialNumber == null) {
    throw new Error("MISSING_PERSISTED_SEQUENCE: El documento no tiene sequentialNumber persistido.");
  }

  const issuedAt = doc.issuedAt ?? doc.createdAt;
  const fechaEmision = `${String(issuedAt.getDate()).padStart(2, "0")}/${String(issuedAt.getMonth() + 1).padStart(2, "0")}/${issuedAt.getFullYear()}`;

  const totalSinImpuestos = Number(doc.subtotal).toFixed(2);
  const totalDescuento = Number(doc.discountTotal).toFixed(2);
  const totalIva = Number(doc.taxTotal).toFixed(2);
  const importeTotal = Number(doc.grandTotal).toFixed(2);

  const linesXml = lines
    .map((l, idx) => {
      const precioUnitario = Number(l.unitPrice).toFixed(6);
      const cantidad = Number(l.quantity).toFixed(6);
      const precioTotalSinImpuesto = Number(l.subtotal).toFixed(2);
      const descuento = Number(l.discountAmount).toFixed(2);
      const codigoPrincipal = l.itemCode ? `<codigoPrincipal>${esc(l.itemCode)}</codigoPrincipal>` : "";
      const codigoAdicional = "";
      const tarifaIva = Number(l.taxRate).toFixed(0);
      const baseImponibleIva = Number(l.subtotal).toFixed(2);
      const valorIva = Number(l.taxAmount).toFixed(2);

      return `    <detalle>
      ${codigoPrincipal}
      ${codigoAdicional}
      <descripcion>${esc(l.itemName)}</descripcion>
      <cantidad>${cantidad}</cantidad>
      <precioUnitario>${precioUnitario}</precioUnitario>
      <descuento>${descuento}</descuento>
      <precioTotalSinImpuesto>${precioTotalSinImpuesto}</precioTotalSinImpuesto>
      <impuestos>
        <impuesto>
          <codigo>2</codigo>
          <codigoPorcentaje>${tarifaIva === "0" ? "0" : tarifaIva === "5" ? "5" : "2"}</codigoPorcentaje>
          <tarifa>${tarifaIva}</tarifa>
          <baseImponible>${baseImponibleIva}</baseImponible>
          <valor>${valorIva}</valor>
        </impuesto>
      </impuestos>
    </detalle>
    <!-- linea ${idx + 1} -->`;
    })
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!-- BORRADOR PRELIMINAR — SIN FIRMA ELECTRONICA — Appsolux sri-signing-worker -->
<!-- accessKey: ${accessKey} -->
<!-- displayNumber: ${displayNumber} -->
<factura id="comprobante" version="1.0.0">
  <infoTributaria>
    <ambiente>${doc.environment === "PRODUCTION" ? "2" : "1"}</ambiente>
    <tipoEmision>1</tipoEmision>
    <razonSocial>${esc(profile.legalName)}</razonSocial>
    <nombreComercial>${esc(profile.tradeName ?? profile.legalName)}</nombreComercial>
    <ruc>${esc(profile.ruc)}</ruc>
    <claveAcceso>${accessKey}</claveAcceso>
    <codDoc>${getSriDocumentCode(doc.documentType)}</codDoc>
    <estab>${esc(establishment.code)}</estab>
    <ptoEmi>${esc(issuePoint.code)}</ptoEmi>
    <secuencial>${formatSequential(doc.sequentialNumber)}</secuencial>
    <dirMatriz>${esc(establishment.address)}</dirMatriz>
  </infoTributaria>
  <infoFactura>
    <fechaEmision>${fechaEmision}</fechaEmision>
    <dirEstablecimiento>${esc(establishment.address)}</dirEstablecimiento>
    <tipoIdentificacionComprador>04</tipoIdentificacionComprador>
    <razonSocialComprador>${esc(doc.customerName)}</razonSocialComprador>
    <identificacionComprador>${esc(doc.customerIdentification ?? "9999999999999")}</identificacionComprador>
    <totalSinImpuestos>${totalSinImpuestos}</totalSinImpuestos>
    <totalDescuento>${totalDescuento}</totalDescuento>
    <totalConImpuestos>
      <totalImpuesto>
        <codigo>2</codigo>
        <codigoPorcentaje>2</codigoPorcentaje>
        <baseImponible>${totalSinImpuestos}</baseImponible>
        <valor>${totalIva}</valor>
      </totalImpuesto>
    </totalConImpuestos>
    <propina>0.00</propina>
    <importeTotal>${importeTotal}</importeTotal>
    <moneda>${doc.currency}</moneda>
  </infoFactura>
  <detalles>
${linesXml}
  </detalles>
  <infoAdicional>
    <campoAdicional nombre="Email">${esc(doc.customerEmail ?? "")}</campoAdicional>
    <campoAdicional nombre="Sistema">Appsolux</campoAdicional>
  </infoAdicional>
</factura>
`;
}
