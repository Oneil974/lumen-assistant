#!/usr/bin/env node
// Tests du moteur de facturation (src/crm/facturx.js).
//
//   node --test scripts/test-facturx.mjs
//
// Ce qui est vérifié est ce qu'une plateforme de dématérialisation refuserait :
// une ventilation de TVA qui ne retombe pas sur ses pieds, une mention
// obligatoire absente, un XML dont les montants ne correspondent pas au PDF.
// Le module est pur (aucun DOM, aucun backend) : il se teste tel quel.

import assert from "node:assert/strict";
import test from "node:test";

const fx = await import("../src/crm/facturx.js");

const seller = {
  "Raison sociale": "Atelier Lumen", "SIREN": "123456789", "SIRET": "12345678900017",
  "TVA intracom": "FR12123456789", "Adresse": "3 rue des Lilas", "Code postal": "75011",
  "Ville": "Paris", "Pays": "FR", "Régime TVA": "Réel normal", "Taux pénalités": 10.85,
  "Indemnité recouvrement": 40, "IBAN": "FR7630006000011234567890189", "Mode paiement": "Virement",
};
const buyer = {
  "Nom": "Dupont SAS", "Type": "Entreprise", "SIREN": "987654321",
  "Adresse": "8 avenue du Port", "Code postal": "44000", "Ville": "Nantes", "Pays": "FR",
};
const invoice = {
  "Numéro": "F2026-0001", "Date": "2026-09-03", "Échéance": "2026-10-03", "Type": "Facture",
  "Nature opération": "Prestation de services", "Payé": 0, "Remise": 0,
};
const lines = [
  { "Désignation": "Formation", "Quantité": 3, "Unité": "jour", "Prix HT": 800, "TVA": 20, "Remise": 0 },
  { "Désignation": "Support imprimé", "Quantité": 10, "Unité": "pièce", "Prix HT": 12, "TVA": 5.5, "Remise": 10 },
];

test("le total d'une ligne applique sa remise", () => {
  assert.equal(fx.lineTotal(lines[0]), 2400);
  assert.equal(fx.lineTotal(lines[1]), 108); // 10 × 12 − 10 %
});

test("la TVA est ventilée par taux, pas calculée sur le total", () => {
  const t = fx.computeTotals(lines, 0);
  assert.equal(t.totalHt, 2508);
  const rates = t.vat.map((v) => v.rate);
  assert.deepEqual(rates, [5.5, 20]);
  assert.equal(t.vat.find((v) => v.rate === 20).tax, 480);
  assert.equal(t.vat.find((v) => v.rate === 5.5).tax, 5.94);
  assert.equal(t.totalTva, 485.94);
  assert.equal(t.totalTtc, 2993.94);
});

test("une remise globale réduit chaque base de TVA", () => {
  const t = fx.computeTotals(lines, 10);
  assert.equal(t.discount, 250.8);
  assert.equal(t.totalHt, 2257.2);
  assert.equal(t.vat.find((v) => v.rate === 20).base, 2160);
  // Le total TTC reste la somme des bases et des taxes ventilées.
  assert.equal(t.totalTtc, Math.round((t.totalHt + t.totalTva) * 100) / 100);
});

test("les contrôles bloquent une facture sans SIREN client", () => {
  const issues = fx.validate(invoice, seller, { ...buyer, SIREN: "" }, lines);
  const blocking = issues.filter((i) => i.level === "error");
  assert.ok(blocking.some((i) => i.field === "client"));
});

test("une facture complète ne déclenche aucun contrôle bloquant", () => {
  const issues = fx.validate(invoice, seller, buyer, lines);
  assert.deepEqual(issues.filter((i) => i.level === "error"), []);
});

test("un avoir doit référencer la facture d'origine", () => {
  const issues = fx.validate({ ...invoice, "Type": "Avoir" }, seller, buyer, lines);
  assert.ok(issues.some((i) => i.field === "avoir" && i.level === "error"));
});

test("le XML CII porte le profil, les identifiants et les mêmes montants", () => {
  const totals = fx.computeTotals(lines, 0);
  const xml = fx.buildXml({ invoice, seller, buyer, lines, totals });
  assert.match(xml, /urn:cen\.eu:en16931:2017/);
  assert.match(xml, /<ram:TypeCode>380<\/ram:TypeCode>/);
  assert.match(xml, /<udt:DateTimeString format="102">20260903<\/udt:DateTimeString>/);
  assert.match(xml, /schemeID="0009">12345678900017/);      // SIRET de l'émetteur
  assert.match(xml, /schemeID="0002">987654321/);            // SIREN du client
  assert.match(xml, /<ram:GrandTotalAmount>2993\.94<\/ram:GrandTotalAmount>/);
  assert.match(xml, /<ram:TaxTotalAmount currencyID="EUR">485\.94<\/ram:TaxTotalAmount>/);
  assert.match(xml, /<ram:DuePayableAmount>2993\.94<\/ram:DuePayableAmount>/);
  assert.match(xml, /unitCode="DAY"/);                        // unité UN/ECE Rec 20
  assert.match(xml, /unitCode="H87"/);
  assert.match(xml, /<ram:IBANID>FR7630006000011234567890189<\/ram:IBANID>/);
  // Mentions françaises devenues obligatoires au 1er septembre 2026.
  assert.match(xml, /Nature de l'opération/);
  assert.match(xml, /Pénalités de retard/);
});

test("la franchise en base porte son article et une TVA nulle", () => {
  const franchise = { ...seller, "Régime TVA": "Franchise en base", "TVA intracom": "" };
  const zeroLines = [{ "Désignation": "Conseil", "Quantité": 1, "Unité": "forfait", "Prix HT": 500, "TVA": 0, "Remise": 0 }];
  const totals = fx.computeTotals(zeroLines, 0);
  assert.equal(totals.totalTva, 0);
  const xml = fx.buildXml({ invoice, seller: franchise, buyer, lines: zeroLines, totals });
  assert.match(xml, /293 B du CGI/);
  assert.match(xml, /<ram:CategoryCode>E<\/ram:CategoryCode>/);
});

test("les caractères XML sont échappés", () => {
  const totals = fx.computeTotals(lines, 0);
  const xml = fx.buildXml({ invoice, seller, buyer: { ...buyer, "Nom": "Martin & Fils <SARL>" }, lines, totals });
  assert.match(xml, /Martin &amp; Fils &lt;SARL&gt;/);
  assert.doesNotMatch(xml, /<SARL>/);
});

test("le taux d'outre-mer à 8,5 % est ventilé comme les autres", () => {
  const domLines = [
    { "Désignation": "Installation", "Quantité": 2, "Unité": "jour", "Prix HT": 500, "TVA": 8.5, "Remise": 0 },
    { "Désignation": "Câblage", "Quantité": 1, "Unité": "forfait", "Prix HT": 200, "TVA": 8.5, "Remise": 0 },
  ];
  const t = fx.computeTotals(domLines, 0);
  assert.equal(t.totalHt, 1200);
  assert.equal(t.vat.length, 1);
  assert.equal(t.vat[0].rate, 8.5);
  assert.equal(t.vat[0].tax, 102);
  assert.equal(t.totalTtc, 1302);
  const xml = fx.buildXml({ invoice, seller, buyer, lines: domLines, totals: t });
  assert.match(xml, /<ram:RateApplicablePercent>8\.50<\/ram:RateApplicablePercent>/);
  assert.match(xml, /<ram:GrandTotalAmount>1302\.00<\/ram:GrandTotalAmount>/);
});
