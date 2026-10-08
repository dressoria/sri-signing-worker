import {
  buildPreliminaryXml,
  buildAccessKey,
  formatDateEC,
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

function build(profileOverrides: Partial<SriProfileData> = {}, lineOverrides: Partial<SriDocumentLineData> = {}) {
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
  const testLine = { ...line, ...lineOverrides };
  const xml = buildPreliminaryXml({
    doc,
    profile,
    establishment: { code: "001", name: "Matriz", address: "Quito" },
    issuePoint: { code: "001" },
    lines: [testLine],
    accessKey: doc.accessKey!,
    displayNumber: "001-001-000000305",
  });
  return { xml, profile };
}

function main(): void {
  // ── Existing tests ──

  const utcBoundary = new Date("2026-10-08T04:39:00Z");
  assert(formatDateEC(utcBoundary) === "07/10/2026", "Debe usar fecha local de Ecuador");
  const boundaryAccessKey = buildAccessKey({
    issuedAt: utcBoundary,
    documentType: "INVOICE",
    ruc: "1751566751001",
    environment: "PRODUCTION",
    establishmentCode: "001",
    issuePointCode: "001",
    sequentialNumber: 306,
    documentId: "timezone-test",
  });
  assert(boundaryAccessKey.startsWith("07102026"), "La clave debe iniciar con fecha Ecuador");

  const general = build();
  assert(!general.xml.includes("<contribuyenteRimpe>"), "Régimen general no debe generar nodo RIMPE");
  assert(general.xml.includes("<obligadoContabilidad>NO</obligadoContabilidad>"), "Debe emitir NO");
  assert(general.xml.includes("FACTUROM COM"), "Debe identificar a FACTUROM COM");
  assert(!general.xml.includes("Appsolux"), "No debe exponer Appsolux en el XML");
  assert(general.xml.includes('nombre="REGIMEN">CONTRIBUYENTE RÉGIMEN GENERAL'), "Debe incluir REGIMEN");

  const boundaryXml = buildPreliminaryXml({
    doc: { ...doc, issuedAt: utcBoundary, createdAt: utcBoundary, sequentialNumber: 306, accessKey: boundaryAccessKey },
    profile: general.profile,
    establishment: { code: "001", name: "Matriz", address: "Quito" },
    issuePoint: { code: "001" },
    lines: [line],
    accessKey: boundaryAccessKey,
    displayNumber: "001-001-000000306",
  });
  assert(boundaryXml.includes("<fechaEmision>07/10/2026</fechaEmision>"), "XML debe usar fecha Ecuador");
  assert(boundaryXml.includes(`<claveAcceso>${boundaryAccessKey}</claveAcceso>`), "XML y clave deben compartir fecha");

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

  // ── Test A: primaryCode as codigoPrincipal ──

  const testA = build({}, { itemCode: "PROD-001" });
  assert(testA.xml.includes("<codigoPrincipal>PROD-001</codigoPrincipal>"), "A: codigoPrincipal debe ser primaryCode");

  // ── Test B: primaryCode + auxiliaryCode ──

  const testB = build({}, { itemCode: "PROD-001", itemAuxiliaryCode: "AUX-01" });
  assert(testB.xml.includes("<codigoPrincipal>PROD-001</codigoPrincipal>"), "B: codigoPrincipal correcto");
  assert(testB.xml.includes("<codigoAuxiliar>AUX-01</codigoAuxiliar>"), "B: codigoAuxiliar presente");

  // ── Test C: no auxiliaryCode = no codigoAuxiliar node ──

  const testC = build({}, { itemCode: "PROD-001", itemAuxiliaryCode: null });
  assert(!testC.xml.includes("<codigoAuxiliar>"), "C: sin auxiliaryCode no debe generar nodo codigoAuxiliar");

  const testC2 = build({}, { itemCode: "PROD-001", itemAuxiliaryCode: "" });
  assert(!testC2.xml.includes("<codigoAuxiliar>"), "C2: auxiliaryCode vacío no genera nodo");

  // ── Test D: no primaryCode = error, NOT ITEM-001 ──

  let threwD = false;
  try {
    build({}, { itemCode: null });
  } catch (e: unknown) {
    threwD = true;
    assert(
      (e as Error).message.includes("SRI_ITEM_PRIMARY_CODE_MISSING"),
      "D: error debe incluir SRI_ITEM_PRIMARY_CODE_MISSING",
    );
  }
  assert(threwD, "D: debe lanzar error cuando itemCode es null");

  let threwD2 = false;
  try {
    build({}, { itemCode: "" });
  } catch {
    threwD2 = true;
  }
  assert(threwD2, "D2: debe lanzar error cuando itemCode es vacío");

  // ── Test E: barcode != primaryCode, uses primaryCode ──

  const testE = build({}, { itemCode: "MY-PRIMARY-CODE" });
  assert(testE.xml.includes("<codigoPrincipal>MY-PRIMARY-CODE</codigoPrincipal>"), "E: usa primaryCode, no barcode");
  assert(!testE.xml.includes("ITEM-"), "E: no debe generar ITEM-xxx");

  // ── Verify no ITEM- anywhere ──

  assert(!general.xml.includes("ITEM-"), "No debe existir ITEM- en XML generado");

  console.log("SRI XML worker OK");
}

main();
