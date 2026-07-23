import {
  parseSRIAuthorizationResponse,
  parseSRIReceptionResponse,
} from "./sri-webservice";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function main() {
  const receivedXml = `<?xml version="1.0" encoding="UTF-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <ns2:validarComprobanteResponse xmlns:ns2="http://ec.gob.sri.ws.recepcion">
      <RespuestaRecepcionComprobante>
        <estado>RECIBIDA</estado>
      </RespuestaRecepcionComprobante>
    </ns2:validarComprobanteResponse>
  </soap:Body>
</soap:Envelope>`;

  const authorizedXml = `<?xml version="1.0" encoding="UTF-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <ns2:autorizacionComprobanteResponse xmlns:ns2="http://ec.gob.sri.ws.autorizacion">
      <RespuestaAutorizacionComprobante>
        <autorizaciones>
          <autorizacion>
            <estado>AUTORIZADO</estado>
            <numeroAutorizacion>2207202601175156675100120010010000050171497069017</numeroAutorizacion>
            <fechaAutorizacion>2026-07-23T08:39:19-05:00</fechaAutorizacion>
            <ambiente>PRODUCCIÓN</ambiente>
            <claveAcceso>2207202601175156675100120010010000050171497069017</claveAcceso>
          </autorizacion>
        </autorizaciones>
      </RespuestaAutorizacionComprobante>
    </ns2:autorizacionComprobanteResponse>
  </soap:Body>
</soap:Envelope>`;

  const reception = parseSRIReceptionResponse(receivedXml);
  assert(reception.kind === "RECIBIDA", "Debe parsear RECIBIDA");

  const authorization = parseSRIAuthorizationResponse(
    authorizedXml,
    "2207202601175156675100120010010000050171497069017"
  );
  assert(authorization.kind === "AUTORIZADO", "Debe parsear AUTORIZADO");
  if (authorization.kind === "AUTORIZADO") {
    assert(
      authorization.authorizationNumber ===
        "2207202601175156675100120010010000050171497069017",
      "Debe conservar numeroAutorizacion"
    );
    assert(
      authorization.accessKey === "2207202601175156675100120010010000050171497069017",
      "Debe conservar claveAcceso"
    );
  }

  console.log("SRI SOAP parser OK");
}

main();
