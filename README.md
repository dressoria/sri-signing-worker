# sri-signing-worker

Worker de firma electrónica SRI para Appsolux. Procesa `SriSigningJob` de la base de datos core.

## Qué hace

- Se conecta a la Core DB de Appsolux (`postgresql://`).
- Lista jobs `SriSigningJob` con status `QUEUED`.
- Reclama un job de forma segura (transacción para evitar race conditions).
- Carga los datos completos del documento y del tenant.
- Genera el XML preliminar del comprobante.
- Procesa en modo **dry-run** (sin firma real todavía).
- Marca el job como `FAILED` (controlado) o `SUCCEEDED` (solo si dry-run lo permite).
- Implementa reintentos con backoff automático.

## Qué NO hace todavía

- **NO firma** con XAdES-BES.
- **NO carga** certificados `.p12`.
- **NO descifra** certificados.
- **NO se conecta** al web service del SRI.
- **NO autoriza** comprobantes.
- **NO genera** RIDE.
- **NO envía** correos.
- **NO marca** `SriDocument.status = SIGNED`.
- **NO ejecuta** en loop infinito.

## Requisitos

- Node.js 20+
- Acceso a la misma PostgreSQL que el dashboard de Appsolux

## Configuración

```bash
cp .env.example .env
# Editar .env con los valores reales
```

Variables clave:

| Variable | Descripción | Default seguro |
|---|---|---|
| `DATABASE_URL_WORKER` | PostgreSQL de Appsolux Core | (obligatorio) |
| `WORKER_ID` | Nombre único de esta instancia | `sri-signing-worker-local` |
| `DB_SSL` | SSL para la conexión | `false` |
| `ENABLE_REAL_SRI_SIGNING` | Habilita firma real (XAdES-BES) | `false` |
| `ENABLE_SRI_SIGNING_DRY_RUN` | Habilita modo dry-run | `true` |
| `DRY_RUN_MARK_SUCCESS` | En dry-run, marca jobs SUCCEEDED | `false` |
| `SRI_CERT_ENCRYPTION_KEY` | Clave de cifrado del certificado | (vacío — no usada aún) |
| `SRI_CERT_STORAGE_PATH` | Ruta al certificado cifrado | (vacío — no usada aún) |

## Comandos

```bash
npm install

# Verificar que todas las variables de entorno estén presentes
npm run check-env

# Listar jobs QUEUED (solo lectura, sin modificar DB)
npm run scan

# Reclamar y procesar máximo 1 job, luego terminar
npm run run:once

# Type-check
npm run typecheck

# Compilar a dist/
npm run build
```

## Modos de operación

### scan
Solo lectura. Prueba la conexión, lista jobs pendientes, muestra resumen. No modifica nada.

### run:once
Reclama un job (si existe), lo procesa en dry-run, y termina. Ideal para testing manual y cron.

## Flags de control

```
ENABLE_REAL_SRI_SIGNING=false   → worker nunca firma real
ENABLE_SRI_SIGNING_DRY_RUN=true → worker procesa hasta el punto de firma, registra resultado
DRY_RUN_MARK_SUCCESS=false      → job queda FAILED controlado (REAL_SIGNING_DISABLED)
DRY_RUN_MARK_SUCCESS=true       → job queda SUCCEEDED con metadata dry-run (solo para test del flujo completo)
```

**Nunca activar `ENABLE_REAL_SRI_SIGNING=true` sin implementar XAdES-BES real.**

## Seguridad

- La `DATABASE_URL_WORKER` nunca se imprime en logs.
- `SRI_CERT_ENCRYPTION_KEY` nunca se imprime.
- Certificados nunca se loguean.
- `SriDocument.status` nunca se cambia a `SIGNED` desde este worker en esta fase.
- El worker valida que `document.tenantId == job.tenantId` antes de procesar.
- No existe firma cross-tenant.

## Arquitectura

```
Next.js Dashboard
      │
      │ POST /api/sri/documents/[id]/signing-jobs
      ▼
SriSigningJob { status: QUEUED }
      │
      │ npm run run:once
      ▼
sri-signing-worker
  ├── Reclama job (transacción)
  ├── Carga documento + tenant + signature config
  ├── Genera XML preliminar
  ├── [dry-run] Registra resultado
  └── Marca job FAILED/SUCCEEDED
```

Para más detalles sobre la arquitectura completa, ver `docs/SRI_SIGNING_WORKER.md` en el repositorio del dashboard.
