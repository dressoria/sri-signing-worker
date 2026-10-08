import {
  buildPreliminaryXml,
  SriDocumentData,
  SriDocumentLineData,
  SriProfileData,
  validateSriInvoiceXmlStructure,
} from "./sri-xml";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

const doc: SriDocumentData = {
  id: "xml-test",
  documentType: "INVOICE",
  environment: "PRODUCTION",
  sequentialNumber: 305,
  accessKey: "0710202601175156675100120010010000003051234567811",
  customerName: "CLIENTE PRUEBA",
  customerIdentification: "9999999999999",
  customerEmail: "cliente@example.com",
  customerPhone: "0999999999",
  customerAddress: "Quito",
  commercialPaymentMethod: "transfer",
  sriPaymentCode: "20",
  subtotal: "1.00",
  taxTotal: "0.15",
  discountTotal: "0.00",
  grandTotal: "1.15",
  currency: "DOLAR",
  issuedAt: new Date("2026-10-07T12:00:00-05:00"),
  createdAt: new Date("2026-10-07T12:00:00-05:00"),
};

const line: SriDocumentLineData = {
  itemName: "Producto prueba",
  itemCode: "TEST-1",
  quantity: "1",
  unitPrice: "1",
  discountAmount: "0",
  subtotal: "1",
  taxRate: "15",
  taxAmount: "0.15",
  total: "1.15",
};

function build(profileOverrides: Partial<SriProfileData> = {}) {
  const profile: SriProfileData = {
    ruc: "1751566751001",
    legalName: "EMISOR PRUEBA",
    tradeName: null,
    dirMatriz: "Quito",
    environment: "PRODUCTION",
    accountingRequired: false,
    taxRegimeCode: "REGIMEN_GENERAL",
    contribuyenteRimpe: "CONTRIBUYENTE RÉGIMEN GENERAL",
    companyEmail: "empresa@example.com",
    companyPhone: "022345678",
    ...profileOverrides,
  };
  const xml = buildPreliminaryXml({
    doc,
    profile,
    establishment: { code: "001", name: "Matriz", address: "Quito" },
    issuePoint: { code: "001" },
    lines: [line],
    accessKey: doc.accessKey!,
    displayNumber: "001-001-000000305",
  });
  return { xml, profile };
}

function main(): void {
  const general = build();
  assert(!general.xml.includes("<contribuyenteRimpe>"), "Régimen general no debe generar nodo RIMPE");
  assert(general.xml.includes("<obligadoContabilidad>NO</obligadoContabilidad>"), "Debe emitir NO");
  assert(general.xml.includes("FACTUROM COM"), "Debe identificar a FACTUROM COM");
  assert(!general.xml.includes("Appsolux"), "No debe exponer Appsolux en el XML");
  assert(general.xml.includes('nombre="REGIMEN">CONTRIBUYENTE RÉGIMEN GENERAL'), "Debe incluir REGIMEN");

  const rimpe = build({
    accountingRequired: true,
    taxRegimeCode: "RIMPE_EMPRENDEDOR",
    contribuyenteRimpe: "CONTRIBUYENTE RÉGIMEN RIMPE",
  });
  const infoTributaria = rimpe.xml.match(/<infoTributaria>([\s\S]*?)<\/infoTributaria>/)?.[1] ?? "";
  const infoFactura = rimpe.xml.match(/<infoFactura>([\s\S]*?)<\/infoFactura>/)?.[1] ?? "";
  assert(infoTributaria.includes("<contribuyenteRimpe>"), "RIMPE debe estar en infoTributaria");
  assert(!infoFactura.includes("<contribuyenteRimpe>"), "RIMPE no debe estar en infoFactura");
  assert(rimpe.xml.includes("<obligadoContabilidad>SI</obligadoContabilidad>"), "Debe emitir SI");
  assert(validateSriInvoiceXmlStructure(rimpe.xml, rimpe.profile.taxRegimeCode).length === 0, "XML válido");

  const invalid = rimpe.xml.replace(
    "<tipoIdentificacionComprador>",
    "<contribuyenteRimpe>INVALIDO</contribuyenteRimpe><tipoIdentificacionComprador>",
  );
  assert(validateSriInvoiceXmlStructure(invalid, rimpe.profile.taxRegimeCode).length > 0, "Debe bloquear estructura inválida");
  console.log("SRI XML worker OK");
}

main();
