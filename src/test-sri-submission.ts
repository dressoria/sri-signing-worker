import { hasAmbiguousReceptionMessage, hasRegisteredAccessKeyMessage } from "./sri-submission";
import { parseSRIReceptionResponse } from "./sri-webservice";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function main(): void {
  assert(
    !hasRegisteredAccessKeyMessage([
      {
        identificador: "35",
        mensaje: "ARCHIVO NO CUMPLE ESTRUCTURA XML",
        informacionAdicional: "cvc-complex-type.2.4.a: Invalid content",
      },
    ]),
    "El identificador 35 no debe implicar clave registrada"
  );

  assert(
    hasRegisteredAccessKeyMessage([
      {
        mensaje: "CLAVE DE ACCESO REGISTRADA",
      },
    ]),
    "Debe detectar el texto en mensaje sin depender de mayusculas"
  );

  const returned = parseSRIReceptionResponse(`
    <respuestaRecepcionComprobante>
      <estado>DEVUELTA</estado>
      <comprobantes><comprobante><mensajes><mensaje>
        <identificador>35</identificador>
        <mensaje>ARCHIVO NO CUMPLE ESTRUCTURA XML</mensaje>
        <informacionAdicional>cvc-complex-type.2.4.a: Invalid content</informacionAdicional>
        <tipo>ERROR</tipo>
      </mensaje></mensajes></comprobante></comprobantes>
    </respuestaRecepcionComprobante>`);
  assert(returned.kind === "DEVUELTA", "La respuesta debe conservar DEVUELTA");
  assert(
    returned.kind === "DEVUELTA" &&
      returned.messages[0]?.mensaje === "ARCHIVO NO CUMPLE ESTRUCTURA XML" &&
      !hasRegisteredAccessKeyMessage(returned.messages) &&
      !hasAmbiguousReceptionMessage(returned.messages),
    "El error estructural 35 debe conservarse y seguir la rama REJECTED"
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

  const extemporaneous = parseSRIReceptionResponse(`
    <respuestaRecepcionComprobante>
      <estado>DEVUELTA</estado>
      <comprobantes><comprobante><mensajes><mensaje>
        <identificador>65</identificador>
        <mensaje>FECHA EMISION EXTEMPORANEA</mensaje>
        <informacionAdicional>La fecha no corresponde al día de emisión</informacionAdicional>
        <tipo>ERROR</tipo>
      </mensaje></mensajes></comprobante></comprobantes>
    </respuestaRecepcionComprobante>`);
  assert(
    extemporaneous.kind === "DEVUELTA" &&
      !hasRegisteredAccessKeyMessage(extemporaneous.messages) &&
      !hasAmbiguousReceptionMessage(extemporaneous.messages),
    "DEVUELTA #65 con mensaje real debe seguir la rama REJECTED"
  );

  assert(
    hasAmbiguousReceptionMessage([{ identificador: "65", mensaje: "Mensaje no disponible" }]),
    "Un mensaje realmente ausente puede consultarse como ambiguo sin importar el identificador"
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
