# sri-signing-worker

Worker de firma electrónica SRI para Appsolux. Procesa `SriSigningJob` de la base de datos core.

## Qué hace

- Se conecta a la Core DB de Appsolux (`postgresql://`).
- Lista jobs `SriSigningJob` con status `QUEUED`.
- Reclama un job de forma segura (`FOR UPDATE SKIP LOCKED`).
- Carga los datos completos del documento, tenant y configuración de firma.
- Valida cross-tenant antes de procesar cualquier dato.
- Genera el XML preliminar del comprobante.
- **Si `ENABLE_REAL_SRI_SIGNING=true`**: firma con XAdES-BES real usando el certificado cifrado del tenant.
- Implementa reintentos con backoff automático.

## Qué hace en firma real (ENABLE_REAL_SRI_SIGNING=true)

1. Lee el certificado cifrado desde `SRI_CERT_STORAGE_PATH`.
2. Descifra el certificado con `SRI_CERT_ENCRYPTION_KEY` (AES-256-GCM).
3. Descifra la contraseña del certificado (misma clave).
4. Carga el PKCS#12 (`.p12`/`.pfx`) con node-forge.
5. Valida expiración del certificado.
6. Valida fingerprint SHA-256 si está configurado.
7. Advierte si el RUC del certificado no coincide con el perfil tributario.
8. Genera XML preliminar con número de comprobante y clave de acceso.
9. Firma con XAdES-BES (RSA-SHA256, C14N inclusivo, QualifyingProperties).
10. Valida estructura básica del XML firmado.
11. Guarda el XML firmado en `SRI_SIGNED_XML_STORAGE_PATH/<tenantId>/<documentId>/signed.xml`.
12. Marca el job `SUCCEEDED` y actualiza `SriDocument.status = SIGNED` en una transacción.

## Qué NO hace

- **NO** genera RIDE oficial.
- **NO** envía correos.
- **NO** ejecuta en loop infinito (se usa con cron o manualmente).
- **NO** imprime contraseñas, certificados ni claves en logs.
- **NO** firma documentos de un tenant con certificado de otro tenant.

## Requisitos

- Node.js 20+
- Acceso a la misma PostgreSQL que el dashboard de Appsolux

## Configuración

```bash
cp .env.example .env
# Editar .env con los valores reales
```

| Variable | Descripción | Default |
|---|---|---|
| `DATABASE_URL_WORKER` | PostgreSQL Appsolux Core | (requerida) |
| `WORKER_ID` | Nombre único de esta instancia | (requerida) |
| `DB_SSL` | SSL para la conexión | `false` |
| `ENABLE_REAL_SRI_SIGNING` | Habilita firma XAdES-BES real | `false` |
| `ENABLE_SRI_SIGNING_DRY_RUN` | Habilita modo dry-run | `true` |
| `DRY_RUN_MARK_SUCCESS` | En dry-run, marcar jobs SUCCEEDED | `false` |
| `SRI_CERT_ENCRYPTION_KEY` | Clave AES-256 (64 hex chars) para descifrar certs | (vacío) |
| `SRI_CERT_STORAGE_PATH` | Ruta donde están los certificados cifrados | (vacío) |
| `SRI_SIGNED_XML_STORAGE_PATH` | Ruta donde guardar XML firmados | (vacío; default: `<CERT_PATH>/signed-xml`) |

Generar `SRI_CERT_ENCRYPTION_KEY`:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## Comandos

```bash
npm install

# Verificar variables de entorno
npm run check-env

# Listar jobs QUEUED (solo lectura)
npm run scan

# Reclamar y procesar 1 job, luego terminar
npm run run:once

# Listar submission jobs de envio SRI TEST
npm run scan:submission

# Procesar 1 submission job, luego terminar
npm run submit:once

# Recuperar autorizacion por documento o clave de acceso
SRI_DOCUMENT_ID=... npm run recover:authorization
ACCESS_KEY=... npm run recover:authorization

# Type-check
npm run typecheck

# Compilar a dist/
npm run build
```

## Tabla de comportamiento por flags

| `ENABLE_REAL_SRI_SIGNING` | `ENABLE_SRI_SIGNING_DRY_RUN` | `DRY_RUN_MARK_SUCCESS` | Resultado |
|---|---|---|---|
| `false` | `false` | — | Job → FAILED `REAL_SIGNING_DISABLED` |
| `false` | `true` | `false` | Job → FAILED `REAL_SIGNING_DISABLED` (safe default) |
| `false` | `true` | `true` | Job → SUCCEEDED `dry-run:sha256...` · SriDocument NO cambia |
| `true` | — | — | Firma XAdES-BES real → SUCCEEDED + SriDocument = SIGNED |

## Flujo de firma real

```
DB SriSigningJob { status: QUEUED }
  │
  ▼ claimNextSigningJob (FOR UPDATE SKIP LOCKED)
  │
  ▼ loadDocumentBundle
    ├── SriDocument (READY_FOR_TESTING)
    ├── SriTaxpayerProfile
    ├── SriEstablishment + SriIssuePoint
    └── SriSignatureConfig
        ├── encryptedCertificateStorageKey → readEncryptedCertificate()
        └── encryptedCertificatePassword → decryptText()
  │
  ▼ loadPkcs12Certificate (node-forge)
    ├── Valida expiración
    ├── Valida fingerprint SHA-256 (opcional)
    └── Advierte si RUC no coincide
  │
  ▼ buildPreliminaryXml (acceso key + XML SRI)
  │
  ▼ signXmlWithTenantCertificate (XAdES-BES)
    ├── C14N del documento (xml-crypto)
    ├── QualifyingProperties (SigningTime + CertDigest)
    ├── C14N de SignedProperties en contexto
    ├── SignedInfo con ambas referencias
    ├── RSA-SHA256 del C14N de SignedInfo (Node.js crypto)
    └── XML final con <Signature> incrustado
  │
  ▼ validateSignedXmlBasic
  │
  ▼ saveSignedXml → signed-xml/<tenantId>/<documentId>/signed.xml
  │
  ▼ markJobSucceededReal (transacción)
    ├── SriSigningJob.status = SUCCEEDED
    └── SriDocument.status = SIGNED
```

## Seguridad

- `DATABASE_URL_WORKER` se sanitiza antes de loguear (password oculto).
- `SRI_CERT_ENCRYPTION_KEY` nunca se imprime.
- Contraseña del certificado se borra de memoria inmediatamente tras cargar el P12.
- El XML firmado nunca se imprime en logs.
- El worker valida `document.tenantId == job.tenantId` antes de procesar.
- Los paths de archivos se validan contra path traversal antes de abrir.
- Certificados solo se leen de rutas dentro de `SRI_CERT_STORAGE_PATH`.
- XML firmados solo se escriben en rutas dentro de `SRI_SIGNED_XML_STORAGE_PATH`.

## Cómo probar con certificado real

1. Configura `.env` con `DATABASE_URL_WORKER` apuntando a la DB.
2. Asegúrate de que hay un `SriSigningJob` en estado `QUEUED` y el documento en `READY_FOR_TESTING`.
3. Asegúrate de que la `SriSignatureConfig` del tenant tiene el certificado cargado y cifrado.
4. Configura `SRI_CERT_ENCRYPTION_KEY` con la misma clave que usa el dashboard.
5. Configura `SRI_CERT_STORAGE_PATH` con la ruta de los certificados.
6. Configura `ENABLE_REAL_SRI_SIGNING=true`.
7. Ejecuta `npm run run:once`.
8. Verifica el XML firmado en `SRI_SIGNED_XML_STORAGE_PATH`.

## Submission SRI

Cuando `ENABLE_SRI_TEST_SUBMISSION=true`, el worker tambien puede:

1. Reclamar `SriSubmissionJob` en estado `QUEUED` o `RECEIVED`.
2. Leer `signed.xml` desde `SRI_SIGNED_XML_STORAGE_PATH`.
3. Enviar el XML firmado al web service de recepcion SRI del ambiente del documento.
4. Consultar autorizacion en el web service de autorizacion SRI del ambiente del documento.
5. Actualizar `SriDocument.status` a `SENT`, `AUTHORIZED` o `REJECTED`.
6. Si recepcion devuelve una respuesta ambigua, consultar autorizacion antes de cerrar el rechazo.
7. Guardar `authorized.xml` cuando el comprobante queda `AUTORIZADO`.

Cuando además `SRI_PRODUCTION_SUBMISSION_ENABLED=true`, el mismo flujo se habilita para comprobantes en `PRODUCTION`.

## Recovery de autorizacion

El comando `recover:authorization` consulta directamente autorizacion SRI por:

- `SRI_DOCUMENT_ID`
- `ACCESS_KEY`

Si el SRI ya responde `AUTORIZADO`, el worker:

- actualiza `SriDocument.status = AUTHORIZED`
- actualiza el `SriSubmissionJob` más reciente a `AUTHORIZED`
- persiste `sriAuthorizationStatus`, `sriAuthorizationNumber`, `authorizedAt`
- guarda `authorized.xml`
- preserva un `sriResponseRaw` útil para diagnóstico

## Limitaciones actuales

- XAdES-BES implementado y submission SRI habilitada para `TEST` y `PRODUCTION` según flags.
- No genera RIDE (próxima fase).
- El loop de polling continuo no está implementado (ejecutar con cron o manualmente).

Para más detalles sobre la arquitectura completa, ver `docs/SRI_SIGNING_WORKER.md` en el repositorio del dashboard.
