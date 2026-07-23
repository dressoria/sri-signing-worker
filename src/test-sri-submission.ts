import { hasAmbiguousReceptionMessage, hasRegisteredAccessKeyMessage } from "./sri-submission";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function main(): void {
  assert(
    hasRegisteredAccessKeyMessage([
      {
        identificador: "35",
        mensaje: "Mensaje no disponible",
      },
    ]),
    "Debe detectar identificador 35 aunque el mensaje no venga completo"
  );

  assert(
    hasRegisteredAccessKeyMessage([
      {
        mensaje: "CLAVE DE ACCESO REGISTRADA",
      },
    ]),
    "Debe detectar el texto en mensaje sin depender de mayusculas"
  );

  assert(
    hasRegisteredAccessKeyMessage([
      {
        mensaje: "Error",
        informacionAdicional: "La clave de acceso registrada ya existe en el sistema",
      },
    ]),
    "Debe detectar el texto en informacionAdicional"
  );

  assert(
    !hasRegisteredAccessKeyMessage([
      {
        identificador: "70",
        mensaje: "Comprobante invalido",
      },
    ]),
    "No debe marcar otros errores como acceso ya registrado"
  );

  assert(
    hasAmbiguousReceptionMessage([
      {
        identificador: "65",
        mensaje: "Mensaje no disponible",
      },
    ]),
    "Debe tratar #65 / Mensaje no disponible como respuesta ambigua para consultar autorización"
  );

  assert(
    hasAmbiguousReceptionMessage([]),
    "Sin mensajes también debe considerarse ambiguo para evitar rechazo prematuro"
  );

  assert(
    !hasAmbiguousReceptionMessage([
      {
        identificador: "70",
        mensaje: "Comprobante invalido",
      },
    ]),
    "Errores concretos no deben tratarse como ambigüedad"
  );

  console.log("SRI submission helper OK");
}

main();
