import * as crypto from "crypto";

import {
  debugValidateXadesSkeleton,
  signXmlWithTenantCertificate,
  validateSignedXmlBasic,
  type CertificateBundle,
} from "./xades-signature";

function buildDummyBundle(): CertificateBundle {
  const { privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });

  return {
    privateKeyPem: privateKey.export({ type: "pkcs1", format: "pem" }).toString(),
    certPem: "-----BEGIN CERTIFICATE-----\nDUMMY\n-----END CERTIFICATE-----",
    certDerBase64: Buffer.from("dummy-certificate-der").toString("base64"),
    certSha256FingerprintHex: crypto
      .createHash("sha256")
      .update(Buffer.from("dummy-certificate-der"))
      .digest("hex"),
    issuerName: "CN=Dummy Issuer,O=Appsolux Test,C=EC",
    serialNumber: "123456789",
    subjectName: "CN=Dummy Subject,O=Appsolux Test,C=EC",
    notBefore: new Date("2026-01-01T00:00:00Z"),
    notAfter: new Date("2027-01-01T00:00:00Z"),
  };
}

function buildMinimalInvoiceXml(): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<factura id="comprobante" version="1.1.0">',
    "<infoTributaria>",
    "<ambiente>1</ambiente>",
    "<tipoEmision>1</tipoEmision>",
    "<razonSocial>Appsolux Test</razonSocial>",
    "<ruc>1790012345001</ruc>",
    "<claveAcceso>0106202601179001234500110010010000000011234567811</claveAcceso>",
    "<codDoc>01</codDoc>",
    "<estab>001</estab>",
    "<ptoEmi>001</ptoEmi>",
    "<secuencial>000000001</secuencial>",
    "</infoTributaria>",
    "<infoFactura>",
    "<fechaEmision>01/06/2026</fechaEmision>",
    "<razonSocialComprador>Consumidor Final</razonSocialComprador>",
    "<identificacionComprador>9999999999999</identificacionComprador>",
    "<totalSinImpuestos>10.00</totalSinImpuestos>",
    "<importeTotal>10.00</importeTotal>",
    "</infoFactura>",
    "<detalles>",
    "<detalle><codigoPrincipal>SKU-1</codigoPrincipal><descripcion>Producto de prueba</descripcion><cantidad>1</cantidad><precioUnitario>10.00</precioUnitario><precioTotalSinImpuesto>10.00</precioTotalSinImpuesto></detalle>",
    "</detalles>",
    "</factura>",
  ].join("");
}

function main() {
  const unsignedXml = buildMinimalInvoiceXml();
  const skeletonDebug = debugValidateXadesSkeleton(unsignedXml);

  if (!skeletonDebug.foundSignedProperties) {
    throw new Error("No se encontró SignedProperties en el skeleton de prueba.");
  }

  if (!skeletonDebug.foundReferenceUri) {
    throw new Error('No se encontró la referencia URI="#Signature-SignedProperties" en el skeleton.');
  }

  const result = signXmlWithTenantCertificate(unsignedXml, buildDummyBundle());
  const validation = validateSignedXmlBasic(result.signedXml);

  if (!validation.valid) {
    throw new Error(`XML firmado inválido: ${validation.errors.join(" | ")}`);
  }

  console.log("XAdES skeleton OK");
  console.log(
    JSON.stringify(
      {
        foundSignedProperties: skeletonDebug.foundSignedProperties,
        foundReferenceUri: skeletonDebug.foundReferenceUri,
        foundIds: skeletonDebug.foundIds,
        signedXmlHash: result.signedXmlHash,
      },
      null,
      2
    )
  );
}

main();
