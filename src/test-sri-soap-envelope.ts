import {
  buildAuthorizationSoapEnvelope,
  buildReceptionSoapEnvelope,
} from "./sri-webservice";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function main() {
  const receptionEnvelope = buildReceptionSoapEnvelope(
    "<ec:validarComprobante><xml>BASE64_PLACEHOLDER</xml></ec:validarComprobante>"
  );
  const authorizationEnvelope = buildAuthorizationSoapEnvelope(
    "<ec:autorizacionComprobante><claveAccesoComprobante>123</claveAccesoComprobante></ec:autorizacionComprobante>"
  );

  assert(
    receptionEnvelope.includes('xmlns:ec="http://ec.gob.sri.ws.recepcion"'),
    "El envelope de recepción no contiene el namespace http://ec.gob.sri.ws.recepcion"
  );
  assert(
    receptionEnvelope.includes("<ec:validarComprobante>") &&
      receptionEnvelope.includes("</ec:validarComprobante>"),
    "El envelope de recepción no contiene el wrapper ec:validarComprobante"
  );
  assert(
    !receptionEnvelope.includes('xmlns:ec="ec.gob.sri.ws.recepcion"') &&
      !receptionEnvelope.includes('xmlns="ec.gob.sri.ws.recepcion"'),
    "El envelope de recepción sigue usando el namespace incorrecto sin http://"
  );

  assert(
    authorizationEnvelope.includes('xmlns:ec="http://ec.gob.sri.ws.autorizacion"'),
    "El envelope de autorización no contiene el namespace http://ec.gob.sri.ws.autorizacion"
  );
  assert(
    authorizationEnvelope.includes("<ec:autorizacionComprobante>") &&
      authorizationEnvelope.includes("</ec:autorizacionComprobante>"),
    "El envelope de autorización no contiene el wrapper ec:autorizacionComprobante"
  );
  assert(
    !authorizationEnvelope.includes('xmlns:ec="ec.gob.sri.ws.autorizacion"') &&
      !authorizationEnvelope.includes('xmlns="ec.gob.sri.ws.autorizacion"'),
    "El envelope de autorización sigue usando el namespace incorrecto sin http://"
  );

  console.log("SRI SOAP envelope OK");
}

main();
