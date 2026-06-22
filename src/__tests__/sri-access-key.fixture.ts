/**
 * Fixture de validación — Factura electrónica autorizada en producción SRI.
 *
 * Factura: 001-001-000005003
 * Clave de acceso: 2106202601175156675100120010010000050038765432119
 * Fecha autorización: 2026-06-21T12:53:41-05:00
 * RUC emisor: 1751566751001
 * Razón social: SORIA GOMEZ WILSON ANDRES
 * Ambiente: PRODUCCIÓN (código 2)
 *
 * IMPORTANTE: Estos datos corresponden a un tenant demo de validación técnica.
 * En producción SaaS cada factura usa los datos fiscales de su tenant.
 * Este fixture solo valida estructura y algoritmos — no emite nada al SRI.
 */

import { createHash } from "crypto";

// ── Algoritmo módulo 11 (replicado para testeo aislado) ───────────────────────

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

function pad(n: number, digits: number): string {
  return String(n).padStart(digits, "0");
}

function stableNumericCode(documentId: string): string {
  const hash = createHash("sha256").update(documentId).digest("hex");
  const num = parseInt(hash.slice(0, 8), 16);
  return String(num % 100_000_000).padStart(8, "0");
}

function buildAccessKey(params: {
  day: number; month: number; year: number;
  docCode: string;
  ruc: string;
  ambiente: string;
  estab: string;
  ptoEmi: string;
  sequential: number;
  numericCode: string;
}): string {
  const fecha = `${pad(params.day, 2)}${pad(params.month, 2)}${params.year}`;
  const seq = pad(params.sequential, 9);
  const base48 = `${fecha}${params.docCode}${params.ruc}${params.ambiente}${params.estab}${params.ptoEmi}${seq}${params.numericCode}1`;

  if (base48.length !== 48) throw new Error(`Base inválida: ${base48.length} dígitos`);

  return `${base48}${modulo11CheckDigit(base48)}`;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(label: string, actual: unknown, expected: unknown) {
  if (actual === expected) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}`);
    console.error(`    Esperado: ${String(expected)}`);
    console.error(`    Obtenido: ${String(actual)}`);
    failed++;
  }
}

console.log("\n── Módulo 11 — Casos básicos ──");
assert("11 - (sum % 11) = 11  → dígito 0", modulo11CheckDigit("0".repeat(48)), "0");
assert("Dígito de clave real 2106202601...", modulo11CheckDigit("210620260117515667510012001001000005003876543211"), "9");

console.log("\n── Longitud y estructura de la clave ──");
const claveReal = "2106202601175156675100120010010000050038765432119";
assert("Clave tiene 49 dígitos", claveReal.length, 49);
assert("Base48 tiene 48 dígitos (sin dígito verificador)", claveReal.slice(0, 48).length, 48);
assert("Fecha ddMMyyyy en posición 0-7", claveReal.slice(0, 8), "21062026");
assert("codDoc factura = 01 en posición 8-9", claveReal.slice(8, 10), "01");
assert("RUC emisor en posición 10-22", claveReal.slice(10, 23), "1751566751001");
assert("Ambiente producción = 2 en posición 23", claveReal.slice(23, 24), "2");
assert("Establecimiento 001 en posición 24-26", claveReal.slice(24, 27), "001");
assert("Punto emisión 001 en posición 27-29", claveReal.slice(27, 30), "001");
assert("Secuencial 000005003 en posición 30-38", claveReal.slice(30, 39), "000005003");
assert("Código numérico 87654321 en posición 39-46", claveReal.slice(39, 47), "87654321");
assert("Tipo emisión = 1 en posición 47", claveReal.slice(47, 48), "1");
assert("Dígito verificador = 9 en posición 48", claveReal.slice(48, 49), "9");

console.log("\n── Reconstrucción exacta de la clave real ──");
const claveReconstruida = buildAccessKey({
  day: 21, month: 6, year: 2026,
  docCode: "01",
  ruc: "1751566751001",
  ambiente: "2",
  estab: "001",
  ptoEmi: "001",
  sequential: 5003,
  numericCode: "87654321", // Conocido de la clave autorizada
});
assert("Clave reconstruida coincide con la autorizada", claveReconstruida, claveReal);

console.log("\n── Validación de dígito verificador ──");
assert("Base48 + checkDigit reproducen clave completa", `${claveReal.slice(0, 48)}${modulo11CheckDigit(claveReal.slice(0, 48))}`, claveReal);

console.log("\n── stableNumericCode (determinista) ──");
const code1 = stableNumericCode("test-document-id-1");
const code2 = stableNumericCode("test-document-id-1");
const code3 = stableNumericCode("test-document-id-2");
assert("Mismo documentId produce mismo código", code1, code2);
assert("Código tiene 8 dígitos", code1.length, 8);
assert("Diferente documentId produce código diferente", code1 !== code3, true);

console.log("\n── Resolución de tipoIdentificacion ──");
function resolveId(id: string | null): { tipo: string; valor: string } {
  if (!id || !id.trim()) return { tipo: "07", valor: "9999999999999" };
  const clean = id.trim();
  if (/^\d{13}$/.test(clean)) return { tipo: "04", valor: clean };
  if (/^\d{10}$/.test(clean)) return { tipo: "05", valor: clean };
  return { tipo: "06", valor: clean };
}
assert("null → Consumidor Final tipo 07", resolveId(null).tipo, "07");
assert("null → Consumidor Final 9999999999999", resolveId(null).valor, "9999999999999");
assert("RUC 13 dígitos → tipo 04", resolveId("1751566751001").tipo, "04");
assert("Cédula 10 dígitos → tipo 05", resolveId("1751566751").tipo, "05");
assert("Pasaporte → tipo 06", resolveId("AB123456").tipo, "06");

console.log("\n── codigoPorcentaje IVA ──");
function resolveIvaCodigo(rate: number): string {
  if (rate === 0) return "0";
  if (rate === 5) return "5";
  if (rate === 12) return "2";
  if (rate === 15) return "4";
  return "2";
}
assert("IVA 0% → código 0", resolveIvaCodigo(0), "0");
assert("IVA 5% → código 5", resolveIvaCodigo(5), "5");
assert("IVA 12% → código 2", resolveIvaCodigo(12), "2");
assert("IVA 15% → código 4 (vigente 2024)", resolveIvaCodigo(15), "4");

console.log(`\n── Resultado: ${passed} pasaron, ${failed} fallaron ──\n`);

if (failed > 0) process.exit(1);
